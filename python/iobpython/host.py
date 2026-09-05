"""The adapter: a host that runs the Python logic scripts assigned to this instance.

Scripts are ordinary ioBroker ``script`` objects -- the same object type the javascript adapter
uses -- routed by ``common.engine``. An instance runs exactly the scripts whose ``engine`` names it,
which is how several engines already share one script tree, and it means the existing script
editor can manage Python scripts without knowing anything about Python.

All scripts share this one process and run as asyncio tasks. That is deliberate: a process per
script would cost 30-50 MB and its own pair of database connections each, which does not fit the
machines ioBroker runs on. The trade is that a script which blocks stalls its neighbours -- exactly
as a ``while(true)`` in a JavaScript script stalls the javascript adapter today, so it is a trade
users already live with. The watchdog below at least names the culprit.
"""

from __future__ import annotations

import asyncio
import time
import traceback
from typing import Any

from iobroker import Adapter

from .scheduler import CronError, CronExpression, run_cron
from .script import Script

__all__ = ["ScriptHost"]

#: What `common.engineType` must say for a script to be ours. Mirrors the existing
#: 'Javascript/js' / 'TypeScript/ts' spelling.
ENGINE_TYPE = "Python/py"

#: A single handler blocking the loop for longer than this is reported. Overridden by
#: ``native.blockedWarnSeconds`` from the instance configuration.
_BLOCKED_WARN_SECONDS = 2.0


class ScriptHost(Adapter):
    """Runs every enabled Python script whose ``common.engine`` points at this instance."""

    def __init__(self, name: str = "python", instance: int | None = None) -> None:
        super().__init__(name, instance=instance)
        self._scripts: dict[str, Script] = {}
        self._crons: dict[str, list[asyncio.Task]] = {}
        self._subscribed: set[str] = set()
        # Last value seen per id, so a handler can be given the previous state -- the
        # counterpart of `oldState` in the javascript adapter. Kept here rather than in the SDK
        # because that is where ioBroker keeps it too: adapter-core reports a change, the script
        # engine is what remembers what came before. Bounded by the ids actually delivered.
        self._previous: dict[str, Any] = {}
        self._blocked_warn = _BLOCKED_WARN_SECONDS

    # -- Lifecycle --------------------------------------------------------

    async def on_ready(self) -> None:
        try:
            self._blocked_warn = float(self.config.get("blockedWarnSeconds") or _BLOCKED_WARN_SECONDS)
        except (TypeError, ValueError):
            self.log.warn(
                f"blockedWarnSeconds is not a number ({self.config.get('blockedWarnSeconds')!r}); "
                f"using {_BLOCKED_WARN_SECONDS}s"
            )
            self._blocked_warn = _BLOCKED_WARN_SECONDS

        # Noticing a script being added, edited, enabled or disabled is the whole point.
        await self.subscribe_foreign_objects("script.*")

        for obj in await self.get_object_view("system", "script"):
            await self._sync(obj["_id"], obj)

        await self._report()
        self.log.info(f"{len(self._scripts)} script(s) running")

    async def on_unload(self) -> None:
        for id in list(self._scripts):
            await self._stop(id)

    async def on_object_change(self, id: str, obj: dict[str, Any] | None) -> None:
        if not id.startswith("script."):
            return
        await self._sync(id, obj)
        await self._report()

    async def on_state_change(self, id: str, state: Any) -> None:
        started = time.monotonic()

        previous = self._previous.get(id)
        if state is None:
            self._previous.pop(id, None)  # deleted: there is nothing to compare against next time
        else:
            self._previous[id] = state

        for script in list(self._scripts.values()):
            await script.dispatch(id, state, previous)

        blocked = time.monotonic() - started
        if blocked > self._blocked_warn:
            # Without this the symptom is "the other scripts went quiet", with no hint where.
            self.log.warn(f"handling {id} blocked the host for {blocked:.1f}s")

    async def on_message(self, msg: Any) -> None:
        if msg.command == "listScripts":
            await self.reply(msg, sorted(self._scripts))
        elif msg.command == "reloadScript":
            id = (msg.message or {}).get("id") if isinstance(msg.message, dict) else msg.message
            obj = await self.get_foreign_object(id) if id else None
            if obj:
                await self._stop(id)
                await self._sync(id, obj)
                await self.reply(msg, {"reloaded": id})
            else:
                await self.reply(msg, {"error": f"no such script: {id}"})

    # -- Script management ------------------------------------------------

    def _ours(self, obj: dict[str, Any] | None) -> bool:
        """Whether this instance is supposed to be running that script."""
        if not obj or obj.get("type") != "script":
            return False
        common = obj.get("common") or {}
        if common.get("engine") != self.instance_id or not common.get("enabled"):
            return False

        engine_type = common.get("engineType")
        if engine_type and engine_type != ENGINE_TYPE:
            # Running JavaScript source through compile() would fail with a SyntaxError that
            # tells the user nothing about the real mistake.
            self.log.warn(
                f"{obj.get('_id')} is assigned to this Python engine but its engineType is "
                f"{engine_type!r}; expected {ENGINE_TYPE!r} -- ignoring it"
            )
            return False

        return True

    async def _sync(self, id: str, obj: dict[str, Any] | None) -> None:
        """Bring one script's running state in line with its object."""
        wanted = self._ours(obj)
        running = self._scripts.get(id)
        source = ((obj or {}).get("common") or {}).get("source") or ""

        # A changed source means restart: there is no way to patch a running script sensibly.
        if running is not None and (not wanted or running.source != source):
            await self._stop(id)
            running = None

        if wanted and running is None:
            await self._start(id, source)

    async def _start(self, id: str, source: str) -> None:
        script = Script(id, source, self)

        try:
            script.load()
        except Exception:  # noqa: BLE001
            self.log.error(f"{id} could not be started:\n{traceback.format_exc()}")
            return

        for pattern in sorted(script.patterns):
            await self._ensure_subscribed(pattern)

        crons: list[asyncio.Task] = []
        for expression, handler in script.schedules:
            try:
                CronExpression(expression)  # fail here, not inside the task
            except CronError as exc:
                script.log_error(f"ignoring schedule {expression!r}: {exc}")
                continue
            crons.append(
                asyncio.create_task(
                    run_cron(expression, lambda h=handler, s=script: s.invoke(h))
                )
            )
        self._crons[id] = crons

        self._scripts[id] = script
        self.log.info(
            f"script {script.name} started "
            f"({len(script.handlers)} trigger(s), {len(crons)} schedule(s))"
        )

    async def _stop(self, id: str) -> None:
        for task in self._crons.pop(id, []):
            task.cancel()

        script = self._scripts.pop(id, None)
        if script is None:
            return

        await script.stop()
        self.log.info(f"script {script.name} stopped")

    async def _ensure_subscribed(self, pattern: str) -> None:
        # Never unsubscribed: the SDK has no unsubscribe yet, so a pattern stays for the life of
        # the process. Harmless (the dispatch below finds no handler) but it does cost traffic --
        # the first thing to fix once the SDK grows unsubscribe_foreign_states.
        if pattern in self._subscribed:
            return
        await self.subscribe_foreign_states(pattern)
        self._subscribed.add(pattern)

    async def _report(self) -> None:
        await self.set_state("scriptsRunning", len(self._scripts), ack=True)
        await self.set_state("info.connection", True, ack=True)
