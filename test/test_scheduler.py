"""The cron parser -- pure unit tests, no database."""

from __future__ import annotations

from datetime import datetime

import pytest

from iobpython.scheduler import CronError, CronExpression


def next_after(expression: str, moment: str) -> datetime:
    return CronExpression(expression).next_after(datetime.fromisoformat(moment))


class TestParsing:
    @pytest.mark.parametrize(
        "expression",
        ["* * * *", "* * * * * *", "60 * * * *", "* 24 * * *", "a * * * *", "*/0 * * * *"],
    )
    def test_rejects_nonsense(self, expression: str) -> None:
        with pytest.raises(CronError):
            CronExpression(expression)

    def test_every_minute(self) -> None:
        assert next_after("* * * * *", "2026-09-04T10:00:30") == datetime(2026, 9, 4, 10, 1)

    def test_a_fixed_time(self) -> None:
        assert next_after("30 22 * * *", "2026-09-04T10:00:00") == datetime(2026, 9, 4, 22, 30)

    def test_wraps_to_the_next_day(self) -> None:
        assert next_after("0 6 * * *", "2026-09-04T10:00:00") == datetime(2026, 9, 5, 6, 0)

    def test_step(self) -> None:
        assert next_after("*/15 * * * *", "2026-09-04T10:01:00") == datetime(2026, 9, 4, 10, 15)

    def test_range_with_step(self) -> None:
        # 9-17/4 -> 9, 13, 17
        assert next_after("0 9-17/4 * * *", "2026-09-04T10:00:00") == datetime(2026, 9, 4, 13, 0)

    def test_list(self) -> None:
        assert next_after("0 8,12,18 * * *", "2026-09-04T13:00:00") == datetime(2026, 9, 4, 18, 0)


class TestDayRules:
    def test_weekday(self) -> None:
        # 2026-09-04 is a Friday; Monday is cron weekday 1.
        assert next_after("0 8 * * 1", "2026-09-04T10:00:00") == datetime(2026, 9, 7, 8, 0)

    def test_sunday_is_both_zero_and_seven(self) -> None:
        assert next_after("0 8 * * 0", "2026-09-04T10:00:00") == next_after(
            "0 8 * * 7", "2026-09-04T10:00:00"
        )

    def test_day_and_weekday_are_or_ed(self) -> None:
        # The classic cron rule: "the 1st OR a Monday", not "a Monday that is the 1st".
        # From Friday 2026-09-04 the next Monday is the 7th, which comes before the 1st of October.
        assert next_after("0 8 1 * 1", "2026-09-04T10:00:00") == datetime(2026, 9, 7, 8, 0)

    def test_day_alone_is_not_widened(self) -> None:
        assert next_after("0 8 1 * *", "2026-09-04T10:00:00") == datetime(2026, 10, 1, 8, 0)

    def test_month(self) -> None:
        assert next_after("0 0 1 1 *", "2026-09-04T10:00:00") == datetime(2027, 1, 1, 0, 0)
