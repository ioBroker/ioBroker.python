"""What a script handler receives -- the Python counterpart of the javascript adapter's ``EventObj``.

The names are that class's, adapted to Python: ``newState``/``oldState`` become ``new_state`` and
``old_state``, ``channelName`` becomes ``channel_name``, and so on. Someone who has written ioBroker
scripts should recognise every one of them.

Everything beyond the two states is derived from the object tree and is therefore **lazy**:
``functools.cached_property`` computes on first access and stores the result on the instance, which
is exactly what the JS class does by hand with ``Object.defineProperty``. A handler that only reads
``event.state.val`` -- the overwhelming majority -- pays for nothing else.
"""

from __future__ import annotations

from functools import cached_property
from typing import Any

from iobroker.types import State

__all__ = ["Event", "ObjectTree"]


class ObjectTree:
    """The object cache an ``Event`` resolves against.

    Held in the process because the properties below answer synchronously while a handler runs;
    an ``await`` per attribute would make scripts read nothing like their JavaScript counterparts.
    """

    def __init__(self, language: str = "en") -> None:
        self.objects: dict[str, dict[str, Any]] = {}
        self.enum_ids: set[str] = set()
        self.language = language
        #: Memo per id, cleared whenever an enum changes -- the walk is not free and ids repeat.
        self._enum_cache: dict[str, tuple[list[str], list[str]]] = {}

    def load(self, objects: dict[str, dict[str, Any]]) -> None:
        self.objects = objects
        self.enum_ids = {id for id, obj in objects.items() if obj.get("type") == "enum"}
        self._enum_cache.clear()

    def apply(self, id: str, obj: dict[str, Any] | None) -> None:
        """Keep the cache in step with one object change."""
        was_enum = id in self.enum_ids

        if obj is None:
            self.objects.pop(id, None)
            self.enum_ids.discard(id)
        else:
            self.objects[id] = obj
            if obj.get("type") == "enum":
                self.enum_ids.add(id)
            else:
                self.enum_ids.discard(id)

        # Membership is stored on the enum, so any enum change can invalidate any id's answer.
        if was_enum or id in self.enum_ids:
            self._enum_cache.clear()
        else:
            self._enum_cache.pop(id, None)

    def translate(self, name: Any) -> Any:
        """A `common.name` may be a plain string or a map of languages."""
        if isinstance(name, dict):
            return name.get(self.language) or name.get("en")
        return name

    def enums_of(self, id: str) -> tuple[list[str], list[str]]:
        """The enums an id belongs to, ids and names.

        Membership is inherited from the parent object, the way ``getObjectEnumsSync`` does it: a
        state in a channel that is in a room counts as being in that room.
        """
        cached = self._enum_cache.get(id)
        if cached is not None:
            return cached

        ids: list[str] = []
        names: list[str] = []

        for enum_id in sorted(self.enum_ids):
            members = ((self.objects.get(enum_id) or {}).get("common") or {}).get("members") or []
            if id in members:
                ids.append(enum_id)
                name = self.translate(((self.objects[enum_id].get("common") or {}).get("name")))
                if name and name not in names:
                    names.append(name)

        parent = id.rpartition(".")[0]
        if parent and parent in self.objects:
            parent_ids, parent_names = self.enums_of(parent)
            ids.extend(i for i in parent_ids if i not in ids)
            names.extend(n for n in parent_names if n not in names)

        self._enum_cache[id] = (ids, names)
        return ids, names


class Event:
    """One state change, as a script sees it."""

    def __init__(
        self,
        id: str,
        state: State | None,
        old_state: State | None,
        tree: ObjectTree,
    ) -> None:
        self.id = id
        self.new_state = state
        self.old_state = old_state
        #: Alias of ``new_state``, exactly as in the JS class.
        self.state = state
        self._tree = tree

    # -- resolved from the object tree, each computed at most once ---------

    @cached_property
    def obj(self) -> dict[str, Any]:
        """The object behind the id; empty when it has none (a state may exist without one)."""
        return self._tree.objects.get(self.id) or {}

    @cached_property
    def common(self) -> dict[str, Any]:
        return self.obj.get("common") or {}

    @cached_property
    def native(self) -> dict[str, Any]:
        return self.obj.get("native") or {}

    @cached_property
    def name(self) -> Any:
        return self._tree.translate(self.common.get("name"))

    @cached_property
    def channel_id(self) -> str | None:
        parent = self.id.rpartition(".")[0]
        return parent if parent and parent in self._tree.objects else None

    @cached_property
    def channel_name(self) -> Any:
        channel = self.channel_id
        if not channel:
            return None
        return self._tree.translate(((self._tree.objects[channel].get("common") or {}).get("name")))

    @cached_property
    def device_id(self) -> str | None:
        channel = self.channel_id
        if not channel:
            return None
        parent = channel.rpartition(".")[0]
        return parent if parent and parent in self._tree.objects else None

    @cached_property
    def device_name(self) -> Any:
        device = self.device_id
        if not device:
            return None
        return self._tree.translate(((self._tree.objects[device].get("common") or {}).get("name")))

    @cached_property
    def enum_ids(self) -> list[str]:
        return self._tree.enums_of(self.id)[0]

    @cached_property
    def enum_names(self) -> list[Any]:
        return self._tree.enums_of(self.id)[1]

    def __repr__(self) -> str:
        value = self.state.val if self.state else None
        return f"<Event {self.id} = {value!r}>"
