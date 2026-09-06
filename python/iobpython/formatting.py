"""Rewriting a script the way a formatter would write it.

The editor has a button for this, the way ioBroker.javascript has one for prettier. What does the
work here is ``ruff format`` -- the same tool the check already runs, in the same environment, and
Black-compatible in its output, so the result is the shape most Python code in the world has.

It runs with ``--isolated``: no ``pyproject.toml`` or ``ruff.toml`` from anywhere above the working
directory can reach it. A logic script is not part of a project and must not be reformatted
differently depending on which folder the host happens to have been started in.

The source goes through stdin rather than a file. The check needs a real file because it has to
put a configuration next to it; formatting needs no configuration, and stdin keeps the script --
which is the user's, and may be large -- off the disk entirely.
"""

from __future__ import annotations

import subprocess
import sys
from typing import Any

from .check import TIMEOUT_SECONDS, ruff_available

__all__ = ["format_source"]


def format_source(source: str) -> dict[str, Any]:
    """The script as ruff would write it, or why it could not be written.

    Returns ``{"source": ...}`` on success and ``{"error": ...}`` otherwise -- never both. A script
    with a syntax error is the ordinary failure: a formatter has to parse before it can print, so
    ruff says where it gave up and that message is worth more than a silent no-op.
    """
    if not ruff_available():
        return {"error": "ruff is not installed in this Python environment"}

    try:
        result = subprocess.run(
            [sys.executable, "-m", "ruff", "format", "--isolated", "-"],
            input=source,
            capture_output=True,
            # Explicit, because the default is the machine's locale encoding: on Windows that is a
            # code page that cannot carry every character a script may legitimately contain.
            text=True,
            encoding="utf-8",
            timeout=TIMEOUT_SECONDS,
            check=False,
        )
    except subprocess.TimeoutExpired:
        return {"error": f"ruff did not finish within {TIMEOUT_SECONDS} seconds"}
    except (OSError, subprocess.SubprocessError) as error:
        return {"error": f"ruff could not be run: {error}"}

    if result.returncode != 0:
        # ruff reports a parse error on stderr and prints nothing on stdout. Its own wording says
        # where the script stops making sense, which is exactly what the user needs to hear.
        message = (result.stderr or "").strip() or f"ruff exited with {result.returncode}"
        return {"error": message}

    return {"source": result.stdout}
