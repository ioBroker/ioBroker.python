"""One user logic script: its compiled code, the API it sees, and its lifecycle.

The API deliberately reads like the javascript adapter's, because the people who will write these
scripts already know that one::

    @on("hue.0.lamp.level")
    def dim(event):
        if event.state.val > 80:
            set_state("hue.0.lamp.on", True)
        # event also carries id, old_state, name, channel_name, device_name, enum_names, ...

    @schedule("0 22 * * *")
    def night():
        set_state("hue.0.lamp.on", False)

Handlers may be ``def`` or ``async def``. Writes (``set_state``, ``send_to``) return a task, which
is what makes both spellings work: a plain ``def`` handler fires and forgets, an ``async def`` one
can ``await`` the same call. Reads (``get_state``) must be awaited, so a script that reads other
states declares its handler ``async def`` -- that is the whole rule.
"""

from __future__ import annotations

import asyncio
import inspect
import re
import traceback
from typing import Any, Awaitable, Callable

from .selectors import SelectorError, build_predicate

__all__ = ["Script", "compile_pattern", "log_tag"]


def log_tag(script_id: str) -> str:
    """The prefix that ties a log line to one script.

    The full object id, not the script's name: two scripts in different folders may be called the
    same thing, and a log line that cannot be attributed to exactly one script is one the log pane
    cannot filter. Bracketed and leading, so the pane can strip it with an anchored match instead of
    searching the text for something that looks like an id -- a message that merely *mentions* a
    script must not be filed under it.
    """
    return f"[{script_id}]"


def _takes_the_event(handler: Callable[..., Any]) -> bool:
    """Whether the handler can be called with the one argument it is going to get.

    Checked once, when the handler is registered, so a signature the engine can never satisfy is
    refused where the user is looking -- rather than raising the same TypeError on every state
    change for as long as the script runs.
    """
    try:
        inspect.signature(handler).bind(None)
    except TypeError:
        return False
    except ValueError:
        return True  # signature unreadable; let the call itself decide

    return True


def compile_pattern(pattern: str) -> re.Pattern[str]:
    """Turn an ioBroker id pattern (``*`` is the only wildcard) into a regex.

    Everything else is escaped: an id like ``sonoff.0.DVES_1A2B`` contains no regex metacharacters,
    but ``system.adapter.x.0`` does -- an unescaped dot would match any character and quietly widen
    the subscription.
    """
    return re.compile("^" + ".*".join(re.escape(part) for part in pattern.split("*")) + "$")


def _compile_id(pattern: str | re.Pattern[str] | list[str]) -> tuple[set[str], Callable[[str], bool]]:
    """What to subscribe to, and how to recognise a matching id.

    The two are not the same thing. A wildcard id is both -- it says what to ask the database for
    and what to accept. A regular expression says only the second, so the subscription has to widen
    to everything and the regex does the deciding; that costs traffic, which is why an id pattern is
    the better tool whenever it can express the same set.

    :param pattern: an id with ``*``, a list of them, or a compiled regular expression
    :returns: the patterns to subscribe to, and a test for one id
    """
    if isinstance(pattern, re.Pattern):
        return {"*"}, lambda id: bool(pattern.search(id))

    patterns = [pattern] if isinstance(pattern, str) else list(pattern)
    compiled = [compile_pattern(one) for one in patterns]

    if len(compiled) == 1:
        single = compiled[0]
        return set(patterns), lambda id: bool(single.match(id))

    return set(patterns), lambda id: any(one.match(id) for one in compiled)


class Script:
    """A single logic script, compiled from a ``script.*`` object's ``common.source``."""

    def __init__(self, id: str, source: str, host: Any) -> None:
        self.id = id
        self.name = id.split(".")[-1]
        self.source = source
        self._host = host

        #: Filled while the script body runs, applied by the host afterwards.
        self.patterns: set[str] = set()
        #: (id matcher, extra condition or None, handler); the handler gets the event, nothing else
        self.handlers: list[tuple[Callable[[str], bool], Callable[[Any], bool] | None, Callable[..., Any]]] = []
        self.schedules: list[tuple[str, Callable[..., Any]]] = []

        self._stop_handlers: list[Callable[..., Any]] = []
        self._tasks: set[asyncio.Task] = set()
        self._namespace: dict[str, Any] = {}

    # -- The API a script sees --------------------------------------------

    def _spawn(self, coro: Awaitable[Any], what: str) -> asyncio.Task:
        """Run ``coro`` in the background and report a failure against this script.

        Returning the task is what lets the same call be awaited or ignored.
        """
        task = asyncio.ensure_future(coro)
        self._tasks.add(task)

        def done(finished: asyncio.Task) -> None:
            self._tasks.discard(finished)
            if not finished.cancelled() and finished.exception() is not None:
                self.log_error(f"{what} failed: {finished.exception()}")

        task.add_done_callback(done)
        return task

    def _build_namespace(self) -> dict[str, Any]:
        host = self._host

        def on(
            pattern: str | re.Pattern[str] | list[str],
            handler: Callable[..., Any] | None = None,
            **conditions: Any,
        ) -> Any:
            """Run ``handler(event)`` whenever a matching state is written.

            ``pattern`` is an id with ``*``, a list of them, or a compiled regular expression.
            Keyword conditions narrow it further -- ``val_gt=80``, ``ack=True``, ``change="ne"``.
            """

            def register(fn: Callable[..., Any]) -> Callable[..., Any]:
                if not _takes_the_event(fn):
                    self.log_error(
                        f"{getattr(fn, '__name__', fn)!r} cannot be a trigger for {pattern!r}: "
                        f"a handler takes one argument, the event"
                    )
                    return fn

                try:
                    predicate = build_predicate(conditions)
                except SelectorError as exc:
                    # Refused, not ignored. A mistyped condition that is quietly dropped turns into
                    # a trigger that fires far too often, and nothing says why.
                    self.log_error(f"{getattr(fn, '__name__', fn)!r} has an unusable condition: {exc}")
                    return fn

                subscriptions, matches = _compile_id(pattern)
                self.patterns.update(subscriptions)
                self.handlers.append((matches, predicate, fn))
                return fn

            return register(handler) if handler is not None else register

        def schedule(expression: str, handler: Callable[..., Any] | None = None) -> Any:
            """Run ``handler()`` on a cron schedule (``minute hour day month weekday``)."""

            def register(fn: Callable[..., Any]) -> Callable[..., Any]:
                self.schedules.append((expression, fn))
                return fn

            return register(handler) if handler is not None else register

        def on_stop(handler: Callable[..., Any]) -> Callable[..., Any]:
            """Run ``handler()`` when the script is stopped, disabled or reloaded."""
            self._stop_handlers.append(handler)
            return handler

        def set_state(id: str, val: Any, ack: bool = False) -> asyncio.Task:
            return self._spawn(host.set_foreign_state(id, val, ack=ack), f"set_state({id!r})")

        def get_state(id: str) -> asyncio.Task:
            return self._spawn(host.get_foreign_state(id), f"get_state({id!r})")

        def send_to(instance: str, command: str, message: Any = None) -> asyncio.Task:
            return self._spawn(host.send_to(instance, command, message), f"send_to({instance!r})")

        return {
            "__name__": f"script.{self.name}",
            "on": on,
            "schedule": schedule,
            "on_stop": on_stop,
            "set_state": set_state,
            "get_state": get_state,
            "send_to": send_to,
            "log": _ScriptLog(self),
            "script_id": self.id,
            "script_name": self.name,
            "adapter": host,
        }

    # -- Logging ----------------------------------------------------------

    def log_error(self, message: str) -> None:
        self._host.log.error(f"{log_tag(self.id)} {message}")

    # -- Lifecycle --------------------------------------------------------

    def load(self) -> None:
        """Compile and run the script body, which registers its handlers.

        The script id becomes the code object's filename, so a traceback names the script the user
        edits rather than ``<string>``.
        """
        code = compile(self.source, f"<{self.id}>", "exec")
        self._namespace = self._build_namespace()
        exec(code, self._namespace)  # noqa: S102 - running user scripts is the whole point

    async def dispatch(self, event: Any) -> None:
        """Offer a state change to this script's handlers."""
        for matches, predicate, handler in self.handlers:
            # Id first: it is the cheap test, and it rejects most events before a condition has to
            # touch the event's lazy properties -- reading `channel_name` builds it.
            if matches(event.id) and (predicate is None or predicate(event)):
                await self.invoke(handler, event)

    async def invoke(self, handler: Callable[..., Any], *args: Any) -> None:
        """Call a handler, sync or async, without letting it take the host down."""
        try:
            result = handler(*args)
            if asyncio.iscoroutine(result):
                await result
        except Exception:  # noqa: BLE001
            self.log_error(f"handler {getattr(handler, '__name__', handler)!r} raised:\n{traceback.format_exc()}")

    async def stop(self) -> None:
        """Run the script's cleanup hooks and drop everything it started."""
        for handler in self._stop_handlers:
            await self.invoke(handler)

        for task in list(self._tasks):
            task.cancel()
        self._tasks.clear()
        self.handlers.clear()
        self._stop_handlers.clear()
        self._namespace.clear()


class _ScriptLog:
    """The script's ``log``, tagged with the script id so a log line names its origin."""

    def __init__(self, script: Script) -> None:
        self._script = script

    def _emit(self, level: str, message: Any) -> None:
        getattr(self._script._host.log, level)(f"{log_tag(self._script.id)} {message}")

    def debug(self, message: Any) -> None:
        self._emit("debug", message)

    def info(self, message: Any) -> None:
        self._emit("info", message)

    def warn(self, message: Any) -> None:
        self._emit("warn", message)

    def error(self, message: Any) -> None:
        self._emit("error", message)
