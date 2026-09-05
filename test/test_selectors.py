"""Trigger conditions: the keyword arguments `on()` accepts beside the id pattern.

Unit tests against a hand-built event rather than a running host -- what is being checked is the
decision a condition makes, and `test_host.py` already covers that a trigger reaches a real script.
"""

from __future__ import annotations

import re

import pytest
from iobpython.selectors import SelectorError, build_predicate


class FakeState:
    def __init__(self, val=None, ack=True, ts=0, lc=0, q=0, from_="system.adapter.hue.0") -> None:
        self.val = val
        self.ack = ack
        self.ts = ts
        self.lc = lc
        self.q = q
        self.from_ = from_


class FakeEvent:
    def __init__(self, val=None, old=None, **state) -> None:
        self.id = "hue.0.lamp.level"
        self.state = FakeState(val=val, **state)
        self.old_state = None if old is None else FakeState(val=old)
        self.name = "Level"
        self.channel_id = "hue.0.lamp"
        self.channel_name = "Lamp"
        self.device_id = "hue.0"
        self.device_name = "Bridge"
        self.enum_ids = ["enum.rooms.living", "enum.functions.light"]
        self.enum_names = ["Living room", "Light"]


def passes(event, **conditions) -> bool:
    predicate = build_predicate(conditions)
    assert predicate is not None
    return predicate(event)


class TestValues:
    def test_equality(self) -> None:
        assert passes(FakeEvent(val=5), val=5)
        assert not passes(FakeEvent(val=5), val=6)

    def test_ordering(self) -> None:
        assert passes(FakeEvent(val=90), val_gt=80)
        assert not passes(FakeEvent(val=80), val_gt=80)
        assert passes(FakeEvent(val=80), val_ge=80)
        assert passes(FakeEvent(val=10), val_lt=80)
        assert passes(FakeEvent(val=80), val_le=80)

    def test_not_equal(self) -> None:
        assert passes(FakeEvent(val=5), val_ne=6)
        assert not passes(FakeEvent(val=5), val_ne=5)

    def test_a_value_that_cannot_be_ordered_does_not_match(self) -> None:
        # Comparing a string against a number is not an error the script should die of: the trigger
        # simply has not fired.
        assert not passes(FakeEvent(val="hello"), val_gt=80)

    def test_a_missing_value_counts_as_zero(self) -> None:
        # As the javascript adapter's `?? 0` does, so a never-written state does not raise.
        assert passes(FakeEvent(val=None), val_lt=1)

    def test_any_of_a_list(self) -> None:
        assert passes(FakeEvent(val="on"), val=["on", "ON", 1])
        assert not passes(FakeEvent(val="off"), val=["on", "ON", 1])

    def test_a_regular_expression(self) -> None:
        assert passes(FakeEvent(val="alarm: door"), val=re.compile("^alarm"))
        assert not passes(FakeEvent(val="quiet"), val=re.compile("^alarm"))


class TestStateFields:
    def test_ack(self) -> None:
        assert passes(FakeEvent(val=1, ack=False), ack=False)
        assert not passes(FakeEvent(val=1, ack=True), ack=False)

    def test_from_is_spelled_both_ways(self) -> None:
        # `from` is the javascript adapter's name, `from_` the one the state carries -- a script may
        # use either, because guessing wrong costs a trigger that never fires.
        assert passes(FakeEvent(val=1), **{"from": "system.adapter.hue.0"})
        assert passes(FakeEvent(val=1), from_="system.adapter.hue.0")

    def test_the_previous_state(self) -> None:
        assert passes(FakeEvent(val=2, old=1), old_val=1)
        assert passes(FakeEvent(val=2, old=1), old_val_lt=2)

    def test_the_previous_state_of_a_first_change(self) -> None:
        # There is no previous state after a start; a condition on it must decide, not raise.
        assert not passes(FakeEvent(val=2), old_val=1)


class TestChange:
    def test_ne_is_a_real_change(self) -> None:
        assert passes(FakeEvent(val=2, old=1), change="ne")
        assert not passes(FakeEvent(val=1, old=1), change="ne")

    def test_ne_holds_for_the_first_change(self) -> None:
        # From nothing to something is a change; this is what makes `change="ne"` usable right
        # after a start rather than silently swallowing the first event.
        assert passes(FakeEvent(val=1), change="ne")

    def test_direction(self) -> None:
        assert passes(FakeEvent(val=5, old=1), change="gt")
        assert not passes(FakeEvent(val=1, old=5), change="gt")
        assert passes(FakeEvent(val=1, old=5), change="lt")

    def test_any(self) -> None:
        assert passes(FakeEvent(val=1, old=1), change="any")

    def test_an_unknown_direction_is_refused(self) -> None:
        with pytest.raises(SelectorError, match="change must be one of"):
            build_predicate({"change": "sideways"})


class TestTheObjectTree:
    def test_channel_and_device(self) -> None:
        assert passes(FakeEvent(val=1), channel_name="Lamp")
        assert not passes(FakeEvent(val=1), channel_name="Kitchen")
        assert passes(FakeEvent(val=1), device_id="hue.0")

    def test_an_enum_is_membership(self) -> None:
        # The event's value is a list; naming one of them has to match.
        assert passes(FakeEvent(val=1), enum_name="Living room")
        assert passes(FakeEvent(val=1), enum_id="enum.functions.light")
        assert not passes(FakeEvent(val=1), enum_name="Kitchen")


class TestCombining:
    def test_all_conditions_must_hold(self) -> None:
        assert passes(FakeEvent(val=90, ack=False), val_gt=80, ack=False)
        assert not passes(FakeEvent(val=90, ack=True), val_gt=80, ack=False)

    def test_no_conditions_is_no_predicate(self) -> None:
        assert build_predicate({}) is None


class TestTheJavascriptSpelling:
    """camelCase is a wrong spelling here, not a second one -- but the message says so usefully."""

    def test_camel_case_is_refused(self) -> None:
        # This is Python. An API answering to two spellings teaches neither, and `valGt` beside
        # `val_gt` in one script is worse than either on its own.
        with pytest.raises(SelectorError):
            build_predicate({"valGt": 80})

    def test_the_message_names_the_python_spelling(self) -> None:
        with pytest.raises(SelectorError, match="did you mean 'val_gt'"):
            build_predicate({"valGt": 80})

    def test_every_shape_of_it_is_refused_with_a_suggestion(self) -> None:
        for wrong, right in [
            ("oldVal", "old_val"),
            ("oldValLt", "old_val_lt"),
            ("channelName", "channel_name"),
            ("enumName", "enum_name"),
            ("deviceId", "device_id"),
        ]:
            with pytest.raises(SelectorError, match=f"did you mean '{right}'"):
                build_predicate({wrong: 1})


class TestRefusals:
    def test_a_typo_gets_no_suggestion_it_cannot_keep(self) -> None:
        # `valGrt` does not become a field in either spelling, so inventing a suggestion would only
        # send the reader somewhere else that is also wrong.
        with pytest.raises(SelectorError, match="unknown condition 'valGrt'") as raised:
            build_predicate({"valGrt": 80})

        assert "did you mean" not in str(raised.value)

    def test_the_message_names_the_fields(self) -> None:
        with pytest.raises(SelectorError, match="channel_name"):
            build_predicate({"nonsense": 1})

    def test_an_alias_is_accepted_but_not_advertised(self) -> None:
        from iobpython.selectors import known_fields

        assert "from" in known_fields()
        assert "from_" not in known_fields(), "the two spellings mean the same field"
