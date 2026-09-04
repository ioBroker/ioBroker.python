"""Cron scheduling for logic scripts.

A five-field cron parser rather than a dependency: it is about fifty lines, and a logic host that
drags a package tree into every installation is a host nobody wants on a Raspberry Pi.

Supported per field: ``*``, ``5``, ``1,3,5``, ``9-17``, ``*/15``, ``9-17/2`` -- which covers what
logic scripts actually schedule.
"""

from __future__ import annotations

import asyncio
import contextlib
from datetime import datetime, timedelta
from typing import Awaitable, Callable

__all__ = ["CronExpression", "CronError", "run_cron"]

#: minute, hour, day-of-month, month, day-of-week
_RANGES = ((0, 59), (0, 23), (1, 31), (1, 12), (0, 7))
_NAMES = ("minute", "hour", "day of month", "month", "day of week")


class CronError(ValueError):
    """The cron expression cannot be parsed."""


def _parse_field(spec: str, low: int, high: int, name: str) -> set[int]:
    values: set[int] = set()

    for part in spec.split(","):
        step = 1
        if "/" in part:
            part, _, step_spec = part.partition("/")
            try:
                step = int(step_spec)
            except ValueError:
                raise CronError(f"{name}: '{step_spec}' is not a step") from None
            if step < 1:
                raise CronError(f"{name}: step must be positive, got {step}")

        if part == "*":
            start, end = low, high
        elif "-" in part:
            first, _, last = part.partition("-")
            try:
                start, end = int(first), int(last)
            except ValueError:
                raise CronError(f"{name}: '{part}' is not a range") from None
        else:
            try:
                start = end = int(part)
            except ValueError:
                raise CronError(f"{name}: '{part}' is not a number") from None

        if start < low or end > high or start > end:
            raise CronError(f"{name}: {start}-{end} is outside {low}-{high}")

        values.update(range(start, end + 1, step))

    return values


class CronExpression:
    """A parsed five-field cron expression."""

    def __init__(self, expression: str) -> None:
        fields = expression.split()
        if len(fields) != 5:
            raise CronError(
                f"expected 5 fields (minute hour day month weekday), got {len(fields)}: "
                f"{expression!r}"
            )

        self.expression = expression
        self.minutes, self.hours, self.days, self.months, weekdays = (
            _parse_field(spec, low, high, name)
            for spec, (low, high), name in zip(fields, _RANGES, _NAMES)
        )
        # Cron knows both 0 and 7 as Sunday.
        self.weekdays = {0 if day == 7 else day for day in weekdays}

        # A restricted day-of-month and a restricted day-of-week are OR-ed, not AND-ed -- the
        # classic cron rule, and getting it wrong makes "every 1st and every Monday" mean
        # "every 1st that is a Monday".
        self._day_restricted = fields[2] != "*"
        self._weekday_restricted = fields[4] != "*"

    def _matches(self, moment: datetime) -> bool:
        if moment.minute not in self.minutes or moment.hour not in self.hours:
            return False
        if moment.month not in self.months:
            return False

        day_ok = moment.day in self.days
        weekday_ok = (moment.weekday() + 1) % 7 in self.weekdays  # cron counts Sunday as 0

        if self._day_restricted and self._weekday_restricted:
            return day_ok or weekday_ok
        if self._day_restricted:
            return day_ok
        if self._weekday_restricted:
            return weekday_ok
        return True

    def next_after(self, moment: datetime) -> datetime:
        """The first matching minute strictly after ``moment``."""
        candidate = (moment + timedelta(minutes=1)).replace(second=0, microsecond=0)
        # A year of minutes is the most any valid expression can need (29 February is the
        # pathological case, and it recurs within four years -- bounded either way).
        for _ in range(366 * 24 * 60 * 4):
            if self._matches(candidate):
                return candidate
            candidate += timedelta(minutes=1)
        raise CronError(f"{self.expression!r} never matches")

    def __repr__(self) -> str:
        return f"CronExpression({self.expression!r})"


async def run_cron(
    expression: str, fire: Callable[[], Awaitable[None] | None], now: Callable[[], datetime] = datetime.now
) -> None:
    """Fire ``fire`` on every occurrence of ``expression`` until cancelled."""
    cron = CronExpression(expression)

    while True:
        moment = now()
        delay = (cron.next_after(moment) - moment).total_seconds()
        await asyncio.sleep(max(delay, 1.0))
        result = fire()
        if asyncio.iscoroutine(result):
            with contextlib.suppress(asyncio.CancelledError):
                await result
