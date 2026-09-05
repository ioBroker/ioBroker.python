# The names a logic script is given, as a stub.
#
# Scripts do not import their API: `Script._build_namespace` puts these in the namespace before the
# code runs. A tool reading a script as a standalone file therefore sees undefined names, and an
# editor has nothing to offer completions from. This file is what tells them otherwise.
#
# Two consumers, and the file is written for both:
#
#   * An editor outside this tab -- VS Code with Pylance, or pyright on the command line -- picks
#     it up as a stub and gives completions and type errors for the whole API.
#   * The adapter's own tab parses it (see `src-admin/src/completions.ts`) to build the completion
#     list Monaco offers. That parser understands the shapes used below: a module-level `def`, a
#     `class` with annotated attributes and methods, and a module-level annotated name. Keep to
#     them, and keep the docstrings -- they are what the editor shows beside each entry.
#
# Kept in step by hand with `script.py` and `event.py`. `NAMESPACE` in `check.py` is the same list
# again, in the form ruff wants.

from typing import Any, Awaitable, Callable

class State:
    """One value of an ioBroker state, with everything ioBroker records about it."""

    val: Any
    """The value."""
    ack: bool
    """False is a command towards a device, True a confirmed reading. Confusing the two builds
    feedback loops."""
    ts: int
    """When it was written, in milliseconds since the epoch."""
    lc: int | None
    """Last change: only moves forward when `val` actually changed."""
    q: int
    """Quality; 0 is good."""
    from_: str
    """Who wrote it, e.g. `system.adapter.hue.0`. Spelled with an underscore because `from` is a
    keyword."""
    user: str | None
    """The user it was written as."""
    expire: int | None
    """Seconds after which the value expires, if it was written with a lifetime."""
    c: str | None
    """Free-text comment."""

class Event:
    """One state change, as a handler receives it.

    Everything past the two states is resolved from the object tree on first access and then
    remembered, so a handler that only reads `event.state.val` pays for nothing else.
    """

    id: str
    """The id of the state that changed."""
    state: State | None
    """The new state. None when the state was deleted."""
    new_state: State | None
    """Alias of `state`."""
    old_state: State | None
    """The state before this change. None for the first change after the engine started."""
    obj: dict[str, Any]
    """The object behind the id; empty when it has none."""
    common: dict[str, Any]
    """The object's `common` section."""
    native: dict[str, Any]
    """The object's `native` section."""
    name: Any
    """The object's name, in the host's language."""
    channel_id: str | None
    """The parent channel's id, or None."""
    channel_name: Any
    """The parent channel's name, or None."""
    device_id: str | None
    """The parent channel's parent, or None."""
    device_name: Any
    """That device's name, or None."""
    enum_ids: list[str]
    """The enums the id belongs to, inherited from its parents."""
    enum_names: list[Any]
    """Those enums' names."""

class Log:
    """The script's log. Every line is tagged with the script's name."""

    def debug(self, message: Any) -> None:
        """Write a debug line. Only reaches the log when the instance's log level allows it."""
    def info(self, message: Any) -> None:
        """Write an info line."""
    def warn(self, message: Any) -> None:
        """Write a warning."""
    def error(self, message: Any) -> None:
        """Write an error."""

def on(pattern: str, handler: Callable[..., Any] | None = ...) -> Any:
    """Run a handler whenever a matching state is written.

    `*` is the only wildcard. Usable as a decorator or called with the handler directly. The
    handler receives an Event; the older `(id, state)` and `(id, state, old)` spellings still work.

        @on("hue.0.lamp.level")
        def dim(event):
            if event.state.val > 80:
                set_state("hue.0.lamp.on", True)
    """

def schedule(expression: str, handler: Callable[..., Any] | None = ...) -> Any:
    """Run a handler on a cron schedule of five fields: minute hour day month weekday.

    Each field takes `*`, a number, a list `1,3,5`, a range `9-17`, a step `*/15`, or a range with
    a step `9-17/2`. In the weekday field both 0 and 7 mean Sunday. There is no seconds field.

        @schedule("0 22 * * *")
        def night():
            set_state("hue.0.lamp.on", False)
    """

def on_stop(handler: Callable[..., Any]) -> Callable[..., Any]:
    """Run a handler when the script is stopped, disabled or reloaded after an edit."""

def set_state(id: str, val: Any, ack: bool = ...) -> Awaitable[None]:
    """Write a state. `ack=False` is a command towards a device, `ack=True` a reading.

    Returns a task: await it in an `async def` handler, or ignore it and let it run. A failure is
    logged against the script either way.
    """

def get_state(id: str) -> Awaitable[State | None]:
    """Read a state. Must be awaited, which is why a script that reads declares `async def`."""

def send_to(instance: str, command: str, message: Any = ...) -> Awaitable[Any]:
    """Send a message to another adapter instance, e.g. `send_to("telegram.0", "send", {...})`."""

log: Log
"""The script's log."""

script_id: str
"""The full id of this script, e.g. `script.py.lights`."""

script_name: str
"""The last segment of the script's id."""

adapter: Any
"""The engine itself, for what the API above does not cover."""
