"""The event object a handler receives -- pure logic, so no database is needed.

Mirrors the javascript adapter's EventObj: the same information under the same names, adapted to
Python. What is worth pinning here is the part that is easy to get subtly wrong -- translation of
names, inheritance of enums from the parent object, and that nothing is resolved until it is read.
"""

from __future__ import annotations

from iobroker.types import State

from iobpython.event import Event, ObjectTree

TREE = {
    "hue.0": {"type": "device", "common": {"name": "Hue Bridge"}, "native": {}},
    "hue.0.lamp": {
        "type": "channel",
        "common": {"name": {"de": "Deckenlampe", "en": "Ceiling"}},
        "native": {},
    },
    "hue.0.lamp.level": {
        "type": "state",
        "common": {"name": {"de": "Helligkeit", "en": "Level"}, "role": "level.dimmer"},
        "native": {"pin": 7},
    },
    # The room is on the *channel*, the function on the state: reaching the state through both is
    # what the inheritance rule is for.
    "enum.rooms.living": {
        "type": "enum",
        "common": {"name": {"de": "Wohnzimmer", "en": "Living room"}, "members": ["hue.0.lamp"]},
    },
    "enum.functions.light": {
        "type": "enum",
        "common": {"name": {"de": "Licht", "en": "Light"}, "members": ["hue.0.lamp.level"]},
    },
}


def tree(language: str = "en") -> ObjectTree:
    built = ObjectTree(language=language)
    built.load({id: dict(obj) for id, obj in TREE.items()})
    return built


def event(language: str = "en", **over) -> Event:
    return Event(
        over.get("id", "hue.0.lamp.level"),
        over.get("state", State(val=90, ack=True)),
        over.get("old_state", State(val=10, ack=True)),
        over.get("tree") or tree(language),
    )


class TestStates:
    def test_state_is_an_alias_of_new_state(self) -> None:
        # Both names exist in the JS class, and scripts in the wild use each of them.
        ev = event()
        assert ev.state is ev.new_state
        assert ev.state.val == 90

    def test_the_previous_state_is_carried(self) -> None:
        assert event().old_state.val == 10

    def test_a_first_change_has_no_previous_state(self) -> None:
        assert event(old_state=None).old_state is None


class TestObjectFields:
    def test_common_and_native(self) -> None:
        ev = event()
        assert ev.common["role"] == "level.dimmer"
        assert ev.native["pin"] == 7

    def test_an_id_without_an_object_stays_empty(self) -> None:
        # A state may exist without an object; reading through it must not raise.
        ev = event(id="ghost.0.nothing")
        assert ev.common == {} and ev.native == {} and ev.name is None
        assert ev.channel_id is None and ev.device_id is None

    def test_the_name_follows_the_system_language(self) -> None:
        assert event("de").name == "Helligkeit"
        assert event("en").name == "Level"

    def test_a_plain_string_name_is_returned_as_is(self) -> None:
        assert event(id="hue.0").name == "Hue Bridge"


class TestHierarchy:
    def test_channel_and_device(self) -> None:
        ev = event("de")
        assert ev.channel_id == "hue.0.lamp"
        assert ev.channel_name == "Deckenlampe"
        assert ev.device_id == "hue.0"
        assert ev.device_name == "Hue Bridge"

    def test_a_parent_without_an_object_is_not_a_channel(self) -> None:
        built = tree()
        del built.objects["hue.0.lamp"]
        assert event(tree=built).channel_id is None


class TestEnums:
    def test_enums_are_inherited_from_the_parent(self) -> None:
        ev = event("de")
        assert sorted(ev.enum_ids) == ["enum.functions.light", "enum.rooms.living"]
        assert sorted(ev.enum_names) == ["Licht", "Wohnzimmer"]

    def test_membership_of_an_unrelated_id_is_empty(self) -> None:
        assert event(id="hue.0").enum_ids == []


class TestCacheUpdates:
    def test_a_renamed_channel_is_seen(self) -> None:
        built = tree("de")
        built.apply("hue.0.lamp", {"type": "channel", "common": {"name": "Stehlampe"}, "native": {}})
        assert event("de", tree=built).channel_name == "Stehlampe"

    def test_a_deleted_enum_drops_out(self) -> None:
        built = tree("de")
        built.apply("enum.rooms.living", None)
        assert sorted(event("de", tree=built).enum_names) == ["Licht"]

    def test_a_new_member_is_picked_up(self) -> None:
        # Membership lives on the enum, so any enum write can change any id's answer -- the memo
        # has to be given up, not just the entry for the id that changed.
        built = tree("de")
        built.apply(
            "enum.rooms.living",
            {"type": "enum", "common": {"name": "Wohnzimmer", "members": ["hue.0"]}},
        )
        assert event("de", id="hue.0", tree=built).enum_names == ["Wohnzimmer"]


class TestLaziness:
    def test_nothing_is_resolved_until_it_is_read(self) -> None:
        # The overwhelming majority of handlers read state.val and nothing else; they must not pay
        # for an enum walk. cached_property stores on the instance, so __dict__ is the evidence.
        ev = event()
        assert "common" not in ev.__dict__
        assert "enum_ids" not in ev.__dict__

    def test_a_resolved_property_is_kept(self) -> None:
        ev = event()
        first = ev.common
        assert "common" in ev.__dict__
        assert ev.common is first
