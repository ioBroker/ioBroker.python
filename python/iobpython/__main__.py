"""Entry point.

The controller starts this as ``python -m iobpython`` from the adapter's ``python/`` directory,
with the database connection in the environment (see ``doc/PYTHON.md``).
"""

from __future__ import annotations

from .host import ScriptHost

if __name__ == "__main__":
    ScriptHost().run()
