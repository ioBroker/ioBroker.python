"""Reformatting a script.

Formatting is ruff's job, not ours, so these do not test ruff -- they test the contract the editor
depends on: exactly one of `source` and `error`, the text unharmed on the way through, and a
readable reason when the script cannot be parsed.
"""

from __future__ import annotations

import pytest

from iobpython.check import ruff_available
from iobpython.formatting import format_source

needs_ruff = pytest.mark.skipif(not ruff_available(), reason="ruff is not installed")


@needs_ruff
def test_spacing_is_normalised() -> None:
    result = format_source("x    =    1\n")

    assert result["source"] == "x = 1\n"
    assert "error" not in result


@needs_ruff
def test_formatted_source_is_left_alone() -> None:
    """Pressing the button twice must not keep changing the script."""
    once = format_source('@on("a.0.b")\ndef react(event):\n    log.info(event.id)\n')["source"]

    assert format_source(once)["source"] == once


@needs_ruff
def test_the_script_api_survives() -> None:
    """The names a script is given are not imported, and a formatter must not care."""
    source = "@schedule('0 22 * * *')\nasync def nightly(event):\n    await set_state('a.0.b',True)\n"
    formatted = format_source(source)["source"]

    assert "@schedule" in formatted
    assert "await set_state" in formatted


@needs_ruff
def test_non_ascii_survives() -> None:
    """The subprocess talks UTF-8 explicitly; the machine's code page must not get a say."""
    formatted = format_source('log.info( "Grüße ✓" )\n')["source"]

    assert "Grüße ✓" in formatted


@needs_ruff
def test_a_syntax_error_is_reported_not_swallowed() -> None:
    result = format_source("def react(event\n")

    assert "source" not in result
    assert result["error"], "a script that cannot be parsed must say so"


@needs_ruff
def test_an_empty_script_is_fine() -> None:
    assert format_source("")["source"] == ""


def test_a_missing_ruff_is_an_error_not_a_crash(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr("iobpython.formatting.ruff_available", lambda: False)

    result = format_source("x=1\n")

    assert "source" not in result
    assert "ruff" in result["error"]
