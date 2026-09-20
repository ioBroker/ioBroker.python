"""The central credential store (``system.credentials.*``) as the scripts' ``SECRETS``.

Credentials are managed in the admin UI under "Basic settings" -> "Credentials". Each one is an
object of type ``config`` whose ``native`` holds the fields, with the secret ones encrypted using
the system secret. A script reads them without knowing any of that::

    password = SECRETS.CameraPassword.key
    user = SECRETS.MyMailAccount.login

This mirrors the ``javascript`` adapter's global of the same name, down to the spelling, so a
credential reads identically in both engines -- and ``SECRETS`` is a constant, which is how Python
spells one anyway. What is different is that this view is a real mapping: ``SECRETS["Camera"]`` and
``SECRETS.Camera["key"]`` work too, and a name that does not exist raises instead of handing out a
``None`` that fails three lines later with nothing to go on.

The store is kept current while the adapter runs, so editing a credential in the admin UI reaches
the scripts immediately -- no restart of the adapter and no reload of the script.
"""

from __future__ import annotations

from collections.abc import Iterator, Mapping
from typing import Any

from iobroker.crypto import decrypt

__all__ = ["SECRETS_PREFIX", "SecretsStore", "is_secret_id", "secret_name"]

#: Prefix of every credential object id.
SECRETS_PREFIX = "system.credentials."

#: Keys in ``native`` that describe the credential instead of being one of its fields. This is
#: adapter-core's ``CREDENTIAL_META_FIELDS`` verbatim, and deliberately so: a credential must have
#: the same fields here as it has in a JavaScript script. Note that ``form`` is not in that list,
#: so a credential written with one carries it as a field in both engines.
META_FIELDS = ("type", "version", "encryptedFields")

#: Sorts after any real id; the SDK's object view uses the same bound as its default.
_HIGH_ID = "香"


def is_secret_id(id: str) -> bool:
    """Whether ``id`` names a credential of the central store."""
    return id.startswith(SECRETS_PREFIX) and len(id) > len(SECRETS_PREFIX)


def secret_name(id: str) -> str:
    """The name a credential is exposed under, i.e. its id without the prefix."""
    return id[len(SECRETS_PREFIX) :]


class Credential(Mapping):
    """One credential's fields, decrypted, readable by attribute or by key.

    Read-only: the credentials belong to the system, and one script must not be able to change
    what another one reads.
    """

    def __init__(self, name: str, values: dict[str, Any]) -> None:
        object.__setattr__(self, "_name", name)
        object.__setattr__(self, "_values", dict(values))

    def __getattr__(self, field: str) -> Any:
        # Only reached for names that are not real attributes, which is every credential field.
        try:
            return self._values[field]
        except KeyError:
            known = ", ".join(sorted(self._values)) or "none"
            raise AttributeError(
                f'the credential "{self._name}" has no field "{field}" (it has: {known})'
            ) from None

    def __getitem__(self, field: str) -> Any:
        return self._values[field]

    def __iter__(self) -> Iterator[str]:
        return iter(self._values)

    def __len__(self) -> int:
        return len(self._values)

    def __setattr__(self, field: str, value: Any) -> None:
        raise AttributeError(f'the credential "{self._name}" is read-only')

    def __delattr__(self, field: str) -> None:
        raise AttributeError(f'the credential "{self._name}" is read-only')

    def __repr__(self) -> str:
        # The field names, never the values. A script that logs a credential -- deliberately or by
        # dropping it into an f-string -- must not write a password into the log, where it would
        # outlive the run and be visible to anyone who can read the log pane.
        fields = ", ".join(sorted(self._values))
        return f"<credential {self._name}: {fields}>"


class _SecretsView(Mapping):
    """What the scripts see as ``SECRETS``: a read-only live view on the store's cache."""

    def __init__(self, store: SecretsStore) -> None:
        object.__setattr__(self, "_store", store)

    def __getattr__(self, name: str) -> Credential:
        # A name that is not stored has to read as a missing attribute, or `hasattr(SECRETS, "x")`
        # and `getattr(SECRETS, "x", default)` would raise instead of answering.
        try:
            return self._store.lookup(name)
        except KeyError as exc:
            raise AttributeError(exc.args[0]) from None

    def __getitem__(self, name: str) -> Credential:
        return self._store.lookup(name)

    def __iter__(self) -> Iterator[str]:
        return iter(self._store.names())

    def __len__(self) -> int:
        return len(self._store.names())

    def __setattr__(self, name: str, value: Any) -> None:
        raise AttributeError("SECRETS is read-only; credentials are managed in the admin UI")

    def __setitem__(self, name: str, value: Any) -> None:
        raise TypeError("SECRETS is read-only; credentials are managed in the admin UI")

    def __delattr__(self, name: str) -> None:
        raise AttributeError("SECRETS is read-only; credentials are managed in the admin UI")

    def __repr__(self) -> str:
        names = ", ".join(sorted(self._store.names())) or "none"
        return f"<SECRETS: {names}>"


class SecretsStore:
    """Holds every credential decrypted and hands the scripts a read-only view of them."""

    def __init__(self, host: Any) -> None:
        self._host = host
        self._cache: dict[str, Credential] = {}
        self._enabled = False
        #: Say once per run that the feature is off, not once per attempt: a handler that reads a
        #: credential on every state change would otherwise fill the log with the same line.
        self._warned = False
        self.view = _SecretsView(self)

    # -- Reading ----------------------------------------------------------

    def lookup(self, name: str) -> Credential:
        """One credential by name, for the script-facing view."""
        if not self._enabled:
            if not self._warned:
                self._warned = True
                self._host.log.warn(
                    f'a script tried to read the credential "{name}", but scripts are not allowed '
                    'to read them. Enable "Allow scripts to read the credentials" in the instance '
                    "settings."
                )
            raise PermissionError(
                f'cannot read the credential "{name}": scripts are not allowed to read the '
                "credentials of the central store"
            )

        try:
            return self._cache[name]
        except KeyError:
            known = ", ".join(sorted(self._cache)) or "none are stored"
            raise KeyError(f'there is no credential named "{name}" (available: {known})') from None

    def names(self) -> list[str]:
        """The names of the credentials currently available to the scripts."""
        return sorted(self._cache) if self._enabled else []

    def structure(self) -> list[dict[str, Any]]:
        """Which credentials exist and which fields each has -- names only, never a value.

        This is what the ``getSecrets`` message answers, so an editor can offer the available
        ``SECRETS.<name>.<field>`` expressions without the values ever leaving the process.
        """
        return [
            {"name": name, "fields": sorted(credential)}
            for name, credential in sorted(self._cache.items())
        ]

    # -- Keeping it current ------------------------------------------------

    async def load(self, enabled: bool) -> None:
        """Read and decrypt every credential of the central store.

        :param enabled: the instance option ``enableSecrets``
        """
        self._cache.clear()
        self._warned = False
        self._enabled = enabled

        if not enabled:
            self._host.log.debug("scripts are not allowed to read the credentials")
            return

        try:
            objects = await self._host.get_object_view(
                "system", "config", SECRETS_PREFIX, f"{SECRETS_PREFIX}{_HIGH_ID}"
            )
        except Exception as exc:  # noqa: BLE001 - a broken store must not stop the scripts
            self._host.log.warn(f"cannot read the credentials: {exc}")
            return

        secret = await self._system_secret()
        for obj in objects:
            self._store(obj, secret)

        self._host.log.info(
            f'{len(self._cache)} credential(s) available to the scripts as "SECRETS"'
        )

    async def update(self, id: str, obj: dict[str, Any] | None = None) -> None:
        """Re-read one credential, because its object was written.

        :param id: the credential's object id
        :param obj: the new object, when the caller already has it
        """
        if not self._enabled or not is_secret_id(id):
            return

        if obj is None:
            try:
                obj = await self._host.get_foreign_object(id)
            except Exception as exc:  # noqa: BLE001
                self._host.log.warn(f'cannot read the credential "{secret_name(id)}": {exc}')
                return

        if obj is None:
            self.remove(id)
            return

        self._store(obj, await self._system_secret())

    def remove(self, id: str) -> None:
        """Forget one credential, because its object was deleted."""
        if is_secret_id(id) and self._cache.pop(secret_name(id), None) is not None:
            self._host.log.debug(f'the credential "{secret_name(id)}" was deleted')

    def clear(self) -> None:
        """Forget every decrypted credential."""
        self._cache.clear()
        self._enabled = False

    # -- Internals ---------------------------------------------------------

    async def _system_secret(self) -> str:
        """The system secret the encrypted fields are encrypted with."""
        return await self._host.get_system_secret()

    def _store(self, obj: dict[str, Any], secret: str) -> None:
        """Decode one credential object into the cache, or drop it if it cannot be read."""
        id = obj.get("_id") or ""
        if not is_secret_id(id):
            return
        name = secret_name(id)

        try:
            self._cache[name] = Credential(name, self._decode(obj, secret))
        except Exception as exc:  # noqa: BLE001 - one unreadable credential, not all of them
            self._cache.pop(name, None)
            self._host.log.warn(f'cannot read the credential "{name}": {exc}')

    @staticmethod
    def _decode(obj: dict[str, Any], secret: str) -> dict[str, Any]:
        """The fields of one credential, with the encrypted ones decrypted.

        The rule is adapter-core's: everything in ``native`` is a field except the metadata, and
        only what ``native.encryptedFields`` names is encrypted.
        """
        native = obj.get("native") or {}
        encrypted = native.get("encryptedFields")
        encrypted = encrypted if isinstance(encrypted, list) else []

        values: dict[str, Any] = {}
        for key, value in native.items():
            if key in META_FIELDS:
                continue
            if key in encrypted and isinstance(value, str) and value:
                values[key] = decrypt(secret, value)
            else:
                values[key] = value

        return values
