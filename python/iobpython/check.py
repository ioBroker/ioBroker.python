"""Checking a script without running it.

Two layers, because they answer different questions and cost different amounts.

``compile()`` is the floor: it is the same call the engine makes when it loads a script, so a
syntax error reported here is exactly the one that would stop the script from starting. It needs
nothing installed and cannot disagree with the engine.

``ruff`` is the second layer: a name that does not exist, an import that is never used, a variable
assigned and forgotten. That needs a tool that understands scope, and ruff is a single static
binary that answers in tens of milliseconds -- which is what makes it affordable on the machines
this adapter runs on. If it is missing the check still works, it just says less.

The scripts do not import the API they are given -- ``on``, ``log`` and the rest are put in the
namespace before the code runs -- so a linter reading a script as a standalone file would call
every one of them undefined. `NAMESPACE` is what tells ruff otherwise, and it is the same list
`Script._build_namespace` installs.
"""

from __future__ import annotations

import json
import subprocess
import sys
import tempfile
from pathlib import Path
from typing import Any

__all__ = ["NAMESPACE", "check_source", "ruff_available"]

#: The names a script is given for free. Kept in step with `Script._build_namespace`.
NAMESPACE = (
    "on",
    "schedule",
    "on_stop",
    "set_state",
    "get_state",
    "send_to",
    "log",
    "script_id",
    "script_name",
    "adapter",
)

#: What ruff is asked for: the pyflakes rules plus the syntax and statement errors. Not style --
#: nobody wants their logic script underlined for a line length.
_RULES = ("E4", "E7", "E9", "F")

#: A check must never hold the host up; a script that takes longer than this is not worth linting.
_TIMEOUT_SECONDS = 10


def _problem(
    message: str,
    line: int,
    column: int,
    end_line: int | None = None,
    end_column: int | None = None,
    code: str = "",
    severity: str = "error",
) -> dict[str, Any]:
    """One finding, in the shape the editor turns into a marker (1-based, as editors count)."""
    return {
        "message": message,
        "line": max(line, 1),
        "column": max(column, 1),
        "endLine": max(end_line or line, 1),
        "endColumn": max(end_column or column + 1, 1),
        "code": code,
        "severity": severity,
    }


def _syntax_problems(source: str) -> list[dict[str, Any]]:
    """Whatever stops the script from compiling -- at most one, because that is where it stops."""
    try:
        compile(source, "<script>", "exec")
    except SyntaxError as error:
        # `offset` is 1-based and may be None; `end_offset` only exists from 3.10.
        line = error.lineno or 1
        column = error.offset or 1
        return [
            _problem(
                error.msg or "invalid syntax",
                line,
                column,
                error.end_lineno or line,
                error.end_offset or column + 1,
                code="SyntaxError",
            )
        ]
    except ValueError as error:
        # A source with a null byte, say: not a SyntaxError but still not compilable.
        return [_problem(str(error), 1, 1, code="ValueError")]
    return []


def ruff_available() -> bool:
    """Whether the linter is installed in this environment."""
    try:
        result = subprocess.run(
            [sys.executable, "-m", "ruff", "--version"],
            capture_output=True,
            timeout=_TIMEOUT_SECONDS,
            check=False,
        )
    except (OSError, subprocess.SubprocessError):
        return False
    return result.returncode == 0


def _ruff_problems(source: str) -> list[dict[str, Any]]:
    """What ruff makes of the script, or nothing at all if it cannot be run.

    The source goes to a real file rather than through stdin: ruff resolves its configuration from
    the file's directory, and a temporary directory of our own is the only way to be sure it finds
    the settings below and not a `pyproject.toml` that happens to sit above the data directory.
    """
    with tempfile.TemporaryDirectory(prefix="iobpython-check-") as directory:
        root = Path(directory)
        (root / "ruff.toml").write_text(
            "builtins = [{names}]\n\n[lint]\nselect = [{rules}]\n".format(
                names=", ".join(f'"{name}"' for name in NAMESPACE),
                rules=", ".join(f'"{rule}"' for rule in _RULES),
            ),
            encoding="utf-8",
        )
        script = root / "script.py"
        script.write_text(source, encoding="utf-8")

        try:
            result = subprocess.run(
                [sys.executable, "-m", "ruff", "check", "--output-format", "json", str(script)],
                capture_output=True,
                cwd=directory,
                timeout=_TIMEOUT_SECONDS,
                check=False,
            )
        except (OSError, subprocess.SubprocessError):
            return []

        # 0 is clean, 1 is "found something"; anything else means ruff itself failed and its
        # output is not JSON.
        if result.returncode not in (0, 1):
            return []

        try:
            findings = json.loads(result.stdout or "[]")
        except json.JSONDecodeError:
            return []

    problems: list[dict[str, Any]] = []
    for finding in findings:
        start = finding.get("location") or {}
        end = finding.get("end_location") or {}
        code = finding.get("code") or ""
        problems.append(
            _problem(
                finding.get("message") or "",
                start.get("row") or 1,
                start.get("column") or 1,
                end.get("row"),
                end.get("column"),
                code=code,
                # Only the syntax rules stop a script from running; the rest are worth saying
                # without claiming the script is broken.
                severity="error" if code.startswith("E9") else "warning",
            )
        )
    return problems


def check_source(source: str) -> dict[str, Any]:
    """Everything wrong with a script that can be found without running it.

    A script that does not compile is reported on that alone: ruff would repeat the same error in
    its own words, and every name it could not resolve afterwards would be noise from the same
    cause.
    """
    syntax = _syntax_problems(source)
    if syntax:
        return {"problems": syntax, "linted": False}

    return {"problems": _ruff_problems(source), "linted": True}
