"""ioBroker.python -- run Python logic scripts inside ioBroker.

The adapter is itself a Python adapter (``common.platform: "Python"``), so js-controller starts it
natively and it talks to the databases through the Python SDK. Nothing bridges between Node.js and
Python at runtime.
"""

from .host import ENGINE_TYPE, ScriptHost
from .script import Script

__version__ = "0.0.1"

__all__ = ["ScriptHost", "Script", "ENGINE_TYPE", "__version__"]
