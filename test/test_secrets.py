"""The central credential store as the scripts see it: `SECRETS`."""

from __future__ import annotations

import os

import pytest

from support import drive_state, put_instance, put_object, put_script, script_object, wait_for_state

from iobpython.secrets import Credential, SecretsStore

#: 48 hex characters, the shape js-controller writes into `system.config`.
SECRET = "0123456789abcdef0123456789abcdef0123456789abcdef"


def encrypt(value: str, secret: str = SECRET) -> str:
    """Encrypt the way js-controller does, so the engine has something real to decrypt."""
    from cryptography.hazmat.primitives.ciphers import Cipher, algorithms, modes

    iv = os.urandom(16)
    raw = value.encode()
    padding = 16 - len(raw) % 16  # PKCS#7
    encryptor = Cipher(algorithms.AES(bytes.fromhex(secret)), modes.CBC(iv)).encryptor()
    body = encryptor.update(raw + bytes([padding]) * padding) + encryptor.finalize()
    return f"$/aes-192-cbc:{iv.hex()}:{body.hex()}"


def credential(name: str, native: dict) -> dict:
    """A credential object as the admin UI writes it."""
    return {
        "_id": f"system.credentials.{name}",
        "type": "config",
        "common": {"name": name},
        "native": native,
    }


def key_credential(name: str, key: str) -> dict:
    return credential(
        name,
        {
            "type": "custom",
            "version": 1,
            "form": "key",
            "encryptedFields": ["key"],
            "key": encrypt(key),
        },
    )


async def put_system_config(db) -> None:
    await put_object(
        db,
        {
            "_id": "system.config",
            "type": "config",
            "common": {"language": "en"},
            "native": {"secret": SECRET},
        },
    )


READS_A_SECRET = """
@on("trigger.0.go")
def react(event):
    set_state("result.0.secret", SECRETS.CameraPassword.key, ack=True)
"""


class TestScriptsReadCredentials:
    async def test_a_script_reads_a_decrypted_credential(self, db, start_host) -> None:
        await put_system_config(db)
        await put_object(db, key_credential("CameraPassword", "sesame"))
        await put_script(db, script_object("script.py.reader", READS_A_SECRET))

        await start_host()
        await drive_state(db, "trigger.0.go", True)

        result = await wait_for_state(db, "result.0.secret")
        assert result is not None, "the script never read the credential"
        assert result["val"] == "sesame"

    async def test_an_edit_reaches_a_running_script(self, db, start_host) -> None:
        await put_system_config(db)
        await put_object(db, key_credential("CameraPassword", "old"))
        await put_script(db, script_object("script.py.reader", READS_A_SECRET))
        host = await start_host()

        await put_object(db, key_credential("CameraPassword", "new"))
        # The object event has to have been processed before the script asks for the value.
        assert await _eventually(lambda: host.secrets.view["CameraPassword"]["key"] == "new")

        await drive_state(db, "trigger.0.go", True)
        result = await wait_for_state(db, "result.0.secret")
        assert result is not None and result["val"] == "new"

    async def test_the_instance_can_switch_it_off(self, db, start_host) -> None:
        await put_system_config(db)
        await put_object(db, key_credential("CameraPassword", "sesame"))
        await put_instance(db, {"enableSecrets": False})

        host = await start_host()

        assert host.secrets.names() == []
        with pytest.raises(PermissionError):
            host.secrets.lookup("CameraPassword")

    async def test_a_deleted_credential_is_forgotten(self, db, start_host) -> None:
        await put_system_config(db)
        await put_object(db, key_credential("CameraPassword", "sesame"))
        host = await start_host()
        assert host.secrets.names() == ["CameraPassword"]

        await db.set("cfg.o.system.credentials.CameraPassword", "")
        await db.delete("cfg.o.system.credentials.CameraPassword")
        await db.publish("cfg.o.system.credentials.CameraPassword", "")

        assert await _eventually(lambda: host.secrets.names() == [])


async def _eventually(predicate, timeout: float = 10.0) -> bool:
    """Poll a synchronous predicate; object events arrive asynchronously."""
    import asyncio
    import time

    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        if predicate():
            return True
        await asyncio.sleep(0.05)
    return False


class _Log:
    def __init__(self) -> None:
        self.lines: list[str] = []

    def warn(self, message: str) -> None:
        self.lines.append(message)

    def info(self, message: str) -> None:
        self.lines.append(message)

    def debug(self, message: str) -> None:
        self.lines.append(message)


class _Host:
    """Just enough host for the store: a log and the system secret."""

    def __init__(self) -> None:
        self.log = _Log()

    async def get_system_secret(self) -> str:
        return SECRET


class TestDecoding:
    """The field rules, which have to match adapter-core's exactly."""

    def store(self) -> SecretsStore:
        store = SecretsStore(_Host())
        store._enabled = True
        return store

    def test_encrypted_fields_are_decrypted_and_the_rest_is_kept(self) -> None:
        store = self.store()
        store._store(
            credential(
                "Mail",
                {
                    "type": "email",
                    "version": 1,
                    "encryptedFields": ["password"],
                    "login": "user@example.com",
                    "password": encrypt("hunter2"),
                },
            ),
            SECRET,
        )

        mail = store.lookup("Mail")
        assert mail.login == "user@example.com"
        assert mail.password == "hunter2"

    def test_the_metadata_is_not_a_field(self) -> None:
        store = self.store()
        store._store(key_credential("Camera", "sesame"), SECRET)

        fields = sorted(store.lookup("Camera"))
        # `form` is deliberately among them: adapter-core's CREDENTIAL_META_FIELDS does not strip
        # it either, and a credential has to have the same fields in both engines.
        assert fields == ["form", "key"]
        assert "type" not in fields and "version" not in fields
        assert "encryptedFields" not in fields

    def test_an_unreadable_credential_does_not_take_the_others_with_it(self) -> None:
        store = self.store()
        store._store(key_credential("Good", "fine"), SECRET)
        store._store(
            credential("Broken", {"encryptedFields": ["key"], "key": "$/aes-192-cbc:zz:zz"}),
            SECRET,
        )

        assert store.names() == ["Good"]
        assert any("Broken" in line for line in store._host.log.lines)

    def test_structure_reports_names_and_fields_only(self) -> None:
        store = self.store()
        store._store(key_credential("Camera", "sesame"), SECRET)

        assert store.structure() == [{"name": "Camera", "fields": ["form", "key"]}]


class TestTheView:
    def store(self) -> SecretsStore:
        store = SecretsStore(_Host())
        store._enabled = True
        store._store(key_credential("Camera", "sesame"), SECRET)
        return store

    def test_it_reads_by_attribute_and_by_key(self) -> None:
        view = self.store().view
        assert view.Camera.key == "sesame"
        assert view["Camera"]["key"] == "sesame"

    def test_it_is_a_mapping(self) -> None:
        view = self.store().view
        assert "Camera" in view
        assert sorted(view) == ["Camera"]
        assert len(view) == 1

    def test_nothing_can_be_written(self) -> None:
        view = self.store().view
        with pytest.raises(AttributeError):
            view.Camera = {"key": "mine"}
        with pytest.raises(TypeError):
            view["Camera"] = {"key": "mine"}
        with pytest.raises(AttributeError):
            view.Camera.key = "mine"

    def test_an_unknown_name_says_which_ones_exist(self) -> None:
        view = self.store().view
        with pytest.raises(KeyError, match="Camera"):
            view["Nope"]
        with pytest.raises(AttributeError, match="Camera"):
            view.Nope

    def test_an_unknown_field_says_which_ones_exist(self) -> None:
        view = self.store().view
        with pytest.raises(AttributeError, match="key"):
            view.Camera.nope

    def test_printing_shows_names_not_values(self) -> None:
        view = self.store().view

        assert "sesame" not in repr(view)
        assert "sesame" not in repr(view.Camera)
        assert "sesame" not in f"{view.Camera}"
        assert "Camera" in repr(view) and "key" in repr(view.Camera)

    def test_a_disabled_store_warns_once_and_refuses(self) -> None:
        store = self.store()
        store._enabled = False

        for _ in range(3):
            with pytest.raises(PermissionError):
                store.view.Camera

        warnings = [line for line in store._host.log.lines if "not allowed" in line]
        assert len(warnings) == 1, warnings
        assert sorted(store.view) == []


class TestCredential:
    def test_it_is_a_plain_read_only_mapping(self) -> None:
        one = Credential("X", {"login": "u", "password": "p"})

        assert dict(one) == {"login": "u", "password": "p"}
        assert one.get("login") == "u"
        with pytest.raises(AttributeError):
            one.login = "other"
        with pytest.raises(AttributeError):
            del one.login
