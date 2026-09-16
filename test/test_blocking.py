"""A script body that does not return blocks its own thread, not the whole adapter.

The first shape a user reaches for is a loop of their own -- ``while True: ... time.sleep(5)`` at
module level. While the body ran on the event loop, that single script froze everything: no
heartbeat, so admin showed the instance yellow; no pump, so ``sigKill`` went unanswered and every
stop ended with the controller killing the process; and no message anywhere naming the cause.

No database here on purpose. What is under test is where the body runs and what the host does while
it runs, and neither needs one -- the single step that would, subscribing a trigger, is stubbed.
"""

from __future__ import annotations

import asyncio
import time

from iobpython.host import ScriptHost

#: Long enough to outlast the host's patience set below, short enough for a test to wait for.
BODY_SECONDS = 0.6

SLOW = f"""
import time

time.sleep({BODY_SECONDS})


def react(event):
    pass


on("demo.0.trigger", react)
"""


class _Log:
    """Records what the host logs instead of writing it anywhere."""

    def __init__(self) -> None:
        self.lines: list[tuple[str, str]] = []

    def __getattr__(self, level: str):
        return lambda message, **kw: self.lines.append((level, message))


def _host() -> ScriptHost:
    """A host with nothing behind it: no databases, no connections, just the script machinery."""
    host = ScriptHost("python", instance=0)
    host.log = _Log()
    host._blocked_warn = 0.1
    # The one step in starting a script that would need a database.
    host._ensure_subscribed = lambda pattern: asyncio.sleep(0)

    return host


class TestABodyThatKeepsRunning:
    async def test_the_start_returns_while_the_body_still_runs(self) -> None:
        host = _host()

        began = time.monotonic()
        await host._start("script.py.slow", SLOW)
        took = time.monotonic() - began

        assert took < BODY_SECONDS, "the host waited for the body instead of leaving it to its thread"
        assert host._scripts == {}, "nothing may be registered before the body has returned"
        assert any(
            level == "warn" and "script.py.slow" in message and "module body" in message
            for level, message in host.log.lines
        ), f"the script that is blocking was not named: {host.log.lines}"

        await host._pending["script.py.slow"]

    async def test_the_event_loop_keeps_running_meanwhile(self) -> None:
        # The point of the whole change: everything else -- the heartbeat, the pumps, the other
        # scripts -- carries on while one script's body does not return.
        host = _host()
        ticks = 0

        async def tick() -> None:
            nonlocal ticks
            while True:
                ticks += 1
                await asyncio.sleep(0.02)

        ticker = asyncio.create_task(tick())
        try:
            await host._start("script.py.slow", SLOW)
            await host._pending["script.py.slow"]
        finally:
            ticker.cancel()

        assert ticks > 5, f"the event loop stalled while the body ran ({ticks} tick(s))"

    async def test_what_the_body_registered_is_picked_up_when_it_returns(self) -> None:
        # A slow start is not a failed one: a body that takes its time -- reading a file, waiting
        # for a device -- still gets its triggers, just later.
        host = _host()

        await host._start("script.py.slow", SLOW)
        await host._pending["script.py.slow"]

        assert "script.py.slow" in host._scripts
        assert any(
            level == "info" and "finished its module body" in message
            for level, message in host.log.lines
        ), f"the late start was not reported: {host.log.lines}"
