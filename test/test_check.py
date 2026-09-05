"""Checking a script without running it.

The two layers are tested apart: `compile()` has to work with nothing installed, and ruff is
skipped where it is not. What both must agree on is the shape of a finding, because the editor
turns it straight into a marker and a wrong line number underlines the wrong code.
"""

from __future__ import annotations

import pytest

from iobpython.check import NAMESPACE, check_source, ruff_available

needs_ruff = pytest.mark.skipif(not ruff_available(), reason="ruff is not installed")


def test_a_clean_script_has_nothing_to_report() -> None:
    result = check_source('@on("a.0.b")\ndef react(event):\n    log.info(event.id)\n')
    assert result["problems"] == []


def test_syntax_error_is_found_without_ruff() -> None:
    result = check_source("def react(event)\n    pass\n")

    assert result["linted"] is False, "a script that does not compile is not linted as well"
    assert len(result["problems"]) == 1

    problem = result["problems"][0]
    assert problem["severity"] == "error"
    assert problem["code"] == "SyntaxError"
    assert problem["line"] == 1


def test_positions_are_one_based_and_ordered() -> None:
    """An editor counts from one, and an end before its start would be an empty underline."""
    for source in ("def react(event)\n    pass\n", "if True\n    pass\n", "x = (\n"):
        for problem in check_source(source)["problems"]:
            assert problem["line"] >= 1 and problem["column"] >= 1
            assert (problem["endLine"], problem["endColumn"]) >= (problem["line"], problem["column"])


def test_a_syntax_error_on_a_later_line_keeps_its_line() -> None:
    result = check_source('log.info("one")\nlog.info("two")\ndef react(event)\n    pass\n')

    assert result["problems"][0]["line"] == 3


@needs_ruff
def test_undefined_name_is_found() -> None:
    result = check_source('@on("a.0.b")\ndef react(event):\n    asdfsd\n')

    assert result["linted"] is True
    codes = {problem["code"] for problem in result["problems"]}
    assert "F821" in codes, f"expected an undefined-name finding, got {result['problems']}"

    found = next(problem for problem in result["problems"] if problem["code"] == "F821")
    assert found["line"] == 3
    assert "asdfsd" in found["message"]
    # Not an error: the script still starts, and only fails if that line is ever reached.
    assert found["severity"] == "warning"


@needs_ruff
@pytest.mark.parametrize("name", NAMESPACE)
def test_the_injected_names_are_not_reported_as_undefined(name: str) -> None:
    """The whole point of the builtins list: a script never imports the API it is given."""
    result = check_source(f"{name}\n")

    assert [problem for problem in result["problems"] if problem["code"] == "F821"] == []


@needs_ruff
def test_unused_import_is_found() -> None:
    codes = {problem["code"] for problem in check_source("import json\n")["problems"]}

    assert "F401" in codes


@needs_ruff
def test_style_is_not_reported() -> None:
    """A logic script is nobody's library; it must not be underlined for its formatting."""
    result = check_source('x    =    1\nlog.info( x )\n' + 'y = "' + "a" * 200 + '"\n')

    assert [problem for problem in result["problems"] if problem["code"].startswith(("E1", "E2", "E3", "E5"))] == []


def test_an_empty_script_is_fine() -> None:
    assert check_source("")["problems"] == []
