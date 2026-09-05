"""Trigger conditions for ``on()``, as keyword arguments.

The javascript adapter takes a pattern object with 49 selectors -- ``valGt``, ``oldLcLe``,
``channelName`` and so on. They are not 49 ideas: they are eight or so fields crossed with a handful
of comparison suffixes, and they exist in that form largely because Blockly and the rules editor
generate them. Someone typing a script there usually writes an ``if``.

So the same surface is offered here, but derived rather than enumerated::

    @on("hue.0.lamp.level", val_gt=80, ack=True)
    @on("hue.0.lamp.level", change="ne")
    @on("sensor.0.*.motion", enum_name="Living room")

A name is read as ``<field>`` or ``<field>_<operator>``. Everything a selector can test is already
on the event, so every one of them stays equivalent to an ``if`` in the handler -- which remains the
right answer for anything this vocabulary cannot say.
"""

from __future__ import annotations

import re
from typing import Any, Callable

__all__ = ["SelectorError", "build_predicate", "known_fields"]


class SelectorError(ValueError):
    """A selector cannot be understood -- an unknown field, or an unusable operator."""


#: Fields read from the state that changed. `from` is spelled `from_` on the state, because `from`
#: is a Python keyword; both spellings are accepted as a selector name.
_STATE_FIELDS = {
    "val": "val",
    "ack": "ack",
    "ts": "ts",
    "lc": "lc",
    "q": "q",
    "from": "from_",
    "from_": "from_",
}

#: Fields resolved from the object tree, straight off the event.
_EVENT_FIELDS = ("name", "channel_id", "channel_name", "device_id", "device_name")

#: Fields whose value on the event is a list; a comparison against them means membership.
_LIST_FIELDS = {"enum_id": "enum_ids", "enum_name": "enum_names"}

#: Comparison suffixes, mirroring the javascript adapter's `Ne`, `Gt`, `Ge`, `Lt`, `Le`.
_ORDERED = {
    "gt": lambda a, b: a > b,
    "ge": lambda a, b: a >= b,
    "lt": lambda a, b: a < b,
    "le": lambda a, b: a <= b,
}

#: How `change` compares the new value against the old one.
_CHANGE = {
    "any": lambda new, old: True,
    "eq": lambda new, old: new == old,
    "ne": lambda new, old: new != old,
    "gt": lambda new, old: _orderable(new) > _orderable(old),
    "ge": lambda new, old: _orderable(new) >= _orderable(old),
    "lt": lambda new, old: _orderable(new) < _orderable(old),
    "le": lambda new, old: _orderable(new) <= _orderable(old),
}


def _accepts(field: str) -> bool:
    """Whether a selector may name this field."""
    if field.startswith("old_"):
        field = field[4:]
        return field in _STATE_FIELDS

    return field in _STATE_FIELDS or field in _EVENT_FIELDS or field in _LIST_FIELDS


def known_fields() -> list[str]:
    """Every field worth naming in an error message.

    The canonical spellings only: ``from_`` is accepted because a state carries the value under that
    name, but listing it beside ``from`` would suggest they differ.
    """
    canonical = [name for name in _STATE_FIELDS if not name.endswith("_")]

    return sorted(
        {*canonical, *(f"old_{name}" for name in canonical), *_EVENT_FIELDS, *_LIST_FIELDS, "change"}
    )


def _orderable(value: Any) -> Any:
    """A value the ordering operators can use.

    ``None`` becomes ``0``, the way the javascript adapter's ``?? 0`` does it: a state that has
    never been written must not make ``val_gt`` raise.
    """
    return 0 if value is None else value


def _snake(name: str) -> str:
    """``valGt`` -> ``val_gt``.

    The javascript adapter's selectors are camelCase, and that is what someone porting a script has
    in their fingers. Translating rather than refusing means both spellings work; an actual typo is
    still caught, because the result still has to name a field that exists.
    """
    return re.sub(r"(?<=[a-z0-9])([A-Z])", lambda m: f"_{m.group(1).lower()}", name)


def _split(name: str) -> tuple[str, str | None]:
    """Read a selector name as ``field`` or ``field_operator``.

    Split at the *last* underscore and only when the tail is an operator, so ``old_val`` stays one
    field while ``old_val_gt`` becomes one, and ``from_`` -- whose tail is empty -- is left alone.
    """
    head, _, tail = name.rpartition("_")

    if head and (tail in _ORDERED or tail == "ne"):
        return head, tail

    return name, None


def _read(event: Any, field: str) -> Any:
    """The value a selector compares against, taken off the event."""
    if field.startswith("old_") and field[4:] in _STATE_FIELDS:
        state = event.old_state
        return getattr(state, _STATE_FIELDS[field[4:]], None) if state is not None else None

    if field in _STATE_FIELDS:
        state = event.state
        return getattr(state, _STATE_FIELDS[field], None) if state is not None else None

    if field in _LIST_FIELDS:
        return getattr(event, _LIST_FIELDS[field])

    return getattr(event, field, None)


def _equals(actual: Any, expected: Any) -> bool:
    """Equality as a trigger condition means "matches", not "is identical".

    A list of expected values matches any of them, a compiled regular expression matches by search,
    and a field that is itself a list -- the enums an id belongs to -- matches by membership. That
    is what the javascript adapter's comparisons do too, and it is what makes
    ``enum_name="Living room"`` read the way it looks.
    """
    if isinstance(actual, (list, tuple, set)):
        return any(_equals(item, expected) for item in actual)

    if isinstance(expected, re.Pattern):
        return actual is not None and bool(expected.search(str(actual)))

    if isinstance(expected, (list, tuple, set)):
        return any(_equals(actual, item) for item in expected)

    return actual == expected


def _one(given: str, expected: Any) -> Callable[[Any], bool]:
    """Turn one keyword argument into a predicate over the event."""
    name = _snake(given)

    if name == "change":
        if expected not in _CHANGE:
            raise SelectorError(f"change must be one of {', '.join(sorted(_CHANGE))}, not {expected!r}")

        compare = _CHANGE[expected]
        return lambda event: compare(
            event.state.val if event.state is not None else None,
            event.old_state.val if event.old_state is not None else None,
        )

    field, operator = _split(name)

    if not _accepts(field):
        # Named as it was written, not as it was normalised: being told that `val_g` is unknown
        # when one typed `valG` sends the reader looking in the wrong place.
        raise SelectorError(f"unknown condition {given!r}; fields are {', '.join(known_fields())}")

    if operator is None:
        return lambda event: _equals(_read(event, field), expected)

    if operator == "ne":
        return lambda event: not _equals(_read(event, field), expected)

    compare = _ORDERED[operator]

    def ordered(event: Any) -> bool:
        try:
            return compare(_orderable(_read(event, field)), _orderable(expected))
        except TypeError:
            # Comparing a string with a number, say. False rather than an exception: a trigger that
            # cannot decide has not fired, and one bad comparison must not kill the dispatch loop.
            return False

    return ordered


def build_predicate(selectors: dict[str, Any]) -> Callable[[Any], bool] | None:
    """Combine keyword conditions into one test, or None when there are none.

    All of them have to hold. The javascript adapter's ``logic: 'or'`` has no counterpart here --
    two triggers, or an ``if``, say it more plainly than a flag that changes what the other keys
    mean.

    :raises SelectorError: if a name or a value cannot be understood
    """
    if not selectors:
        return None

    predicates = [_one(name, value) for name, value in selectors.items()]

    if len(predicates) == 1:
        return predicates[0]

    return lambda event: all(predicate(event) for predicate in predicates)
