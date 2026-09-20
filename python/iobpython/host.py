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
import threading
import time
import traceback
from typing import Any

from iobroker import Adapter

from .check import check_source
from .event import Event, ObjectTree
from .formatting import format_source
from .scheduler import CronError, CronExpression, run_cron
from .script import Script, log_tag
from .secrets import SecretsStore, is_secret_id

__all__ = ["ScriptHost"]

#: What `common.engineType` must say for a script to be ours. Mirrors the existing
#: 'Javascript/js' / 'TypeScript/ts' spelling.
ENGINE_TYPE = "Python/py"

#: A single handler blocking the loop for longer than this is reported. Overridden by
#: ``native.blockedWarnSeconds`` from the instance configuration.
_BLOCKED_WARN_SECONDS = 2.0

#: How often the loop says it is alive, and how often the watchdog thread checks that it did.
_TICK_SECONDS = 1.0


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
        # The object tree an Event resolves names, channels and enums against. Held in the
        # process for the same reason the JS engine holds it: those properties have to answer
        # while a handler runs, and an await per attribute would make scripts read nothing like
        # their JavaScript counterparts. The cost is one full read at startup.
        self._tree = ObjectTree()
        #: The central credential store, handed to the scripts as `SECRETS`.
        self.secrets = SecretsStore(self)
        self._blocked_warn = _BLOCKED_WARN_SECONDS
        #: Scripts whose body has not returned yet, by id. Held so the task is not collected while
        #: it waits, and so stopping such a script does not leave it behind.
        self._pending: dict[str, asyncio.Task] = {}
        #: When the loop last said it was alive, read by the watchdog thread.
        self._tick = 0.0
        self._ticker: asyncio.Task | None = None
        self._watchdog: threading.Thread | None = None
        self._watchdog_stop = threading.Event()

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

        self._start_watchdog()

        system = await self.get_foreign_object("system.config")
        self._tree.language = ((system or {}).get("common") or {}).get("language") or "en"
        self._tree.load(await self.get_object_list())
        self.log.info(f"{len(self._tree.objects)} object(s) cached, {len(self._tree.enum_ids)} enum(s)")

        # Everything, not just scripts: an Event resolves names, channels and enums from the
        # cache, so it has to follow every object, exactly as the JS engine does.
        await self.subscribe_foreign_objects("*")

        # After the subscription above, so a credential edited in between is not missed: the
        # change arrives as an object event and updates what was just read.
        await self.secrets.load(self.config.get("enableSecrets") is not False)

        for obj in await self.get_object_view("system", "script"):
            await self._sync(obj["_id"], obj)

        await self._report()
        self.log.info(f"{len(self._scripts)} script(s) running")

    async def on_unload(self) -> None:
        self.secrets.clear()
        self._watchdog_stop.set()
        if self._ticker is not None:
            self._ticker.cancel()
            self._ticker = None

        for id in list(self._scripts):
            await self._stop(id)

    # -- Watchdog ---------------------------------------------------------

    def _start_watchdog(self) -> None:
        """Watch the event loop from a thread, and say so when it stops running.

        Deliberately not a coroutine. The case worth reporting is the one where nothing on the loop
        runs any more -- a handler that blocks, a script body that never returns -- and a watchdog
        living on that loop would be as stuck as everything else, which is exactly why this used to
        go unreported: the instance went yellow in admin, every stop ended in the controller killing
        the process, and no line anywhere said why.

        The loop's only part is to write a timestamp once a second. The thread reads it and compares
        it against its own clock.
        """
        self._tick = time.monotonic()
        self._ticker = asyncio.create_task(self._tick_loop())
        self._watchdog = threading.Thread(target=self._watch_loop, name="loop-watchdog", daemon=True)
        self._watchdog.start()

    async def _tick_loop(self) -> None:
        """Tell the watchdog the loop is alive, once a second."""
        while not self._watchdog_stop.is_set():
            self._tick = time.monotonic()
            await asyncio.sleep(_TICK_SECONDS)

    def _watch_loop(self) -> None:
        """Report a loop that has stopped ticking, and report when it comes back.

        Runs in its own thread. Logging from here reaches stdout, which the controller captures --
        the route that does not need the loop.
        """
        reported = False

        while not self._watchdog_stop.wait(_TICK_SECONDS):
            blocked = time.monotonic() - self._tick

            if blocked > self._blocked_warn:
                if not reported:
                    self.log.warn(
                        f"the event loop has been blocked for {blocked:.1f}s -- no script reacts, "
                        "no status is reported and the controller cannot stop this instance while "
                        "it lasts; a handler or a script body is not returning"
                    )
                    reported = True
            elif reported:
                self.log.info(f"the event loop is running again after {blocked:.1f}s")
                reported = False

    async def on_object_change(self, id: str, obj: dict[str, Any] | None) -> None:
        self._tree.apply(id, obj)

        # Credentials, so that editing one in the admin UI reaches the running scripts at once.
        if is_secret_id(id):
            if obj:
                await self.secrets.update(id, obj)
            else:
                self.secrets.remove(id)
            return

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

        event = Event(id, state, previous, self._tree)

        for script in list(self._scripts.values()):
            await script.dispatch(event)

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
        elif msg.command == "checkScript":
            # The editor asks before saving, so the check runs against what is on screen rather
            # than against the stored object.
            message = msg.message if isinstance(msg.message, dict) else {}
            await self.reply(msg, await self._check(message.get("source") or ""))
        elif msg.command == "formatScript":
            # Likewise unsaved text: the button formats what the user is looking at, and the
            # result goes back to the editor, not to the object.
            message = msg.message if isinstance(msg.message, dict) else {}
            await self.reply(msg, await self._format(message.get("source") or ""))
        elif msg.command == "getSecrets":
            # Which credentials exist and what their fields are called, so an editor can offer the
            # available expressions. The decrypted values never leave this process.
            await self.reply(
                msg,
                {
                    "enabled": self.config.get("enableSecrets") is not False,
                    "secrets": self.secrets.structure(),
                },
            )

    async def _check(self, source: str) -> dict[str, Any]:
        """Compile and lint a script off the event loop.

        `check_source` spawns ruff and waits for it. Doing that inline would block every other
        script for as long as it takes -- the very thing the watchdog exists to complain about --
        so it goes to a thread and the loop keeps running.
        """
        return await asyncio.to_thread(check_source, source)

    async def _format(self, source: str) -> dict[str, Any]:
        """Reformat a script off the event loop, for the same reason the check runs there."""
        return await asyncio.to_thread(format_source, source)

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
                f"{log_tag(obj.get('_id'))} assigned to this Python engine but its engineType is "
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

        # The body runs in a worker thread rather than on the loop. It is user code, and the shape
        # a user reaches for first is a loop of its own -- `while True: ... time.sleep(5)`. On the
        # loop that single script freezes the whole adapter: no heartbeat, so admin shows the
        # instance yellow; no pump, so `sigKill` is never answered and every stop ends with the
        # controller killing the process. In a thread it costs that script and nothing else.
        loading = asyncio.create_task(asyncio.to_thread(script.load))

        try:
            await asyncio.wait_for(asyncio.shield(loading), timeout=self._blocked_warn)
        except asyncio.TimeoutError:
            self.log.warn(
                f"{log_tag(id)} is still running its module body after {self._blocked_warn:g}s -- "
                "a script body registers its handlers and returns; work that runs for as long as "
                "the script does belongs in a handler, in schedule(), or in a task of its own"
            )
            # Finish this start whenever the body returns, if it ever does. Everything else -- the
            # other scripts, the status reporting, stopping this instance -- carries on meanwhile.
            self._pending[id] = asyncio.create_task(self._finish_start(id, script, loading))
            return
        except Exception:  # noqa: BLE001
            self.log.error(f"{log_tag(id)} could not be started:\n{traceback.format_exc()}")
            return

        await self._finish_start(id, script, None)

    async def _finish_start(self, id: str, script: Script, loading: asyncio.Task | None) -> None:
        """Register what the script body asked for: its triggers, its schedules, its subscriptions.

        :param id: the script's object id
        :param script: the script whose body has run, or is still running
        :param loading: the body still running in its thread, or ``None`` when it has returned
        """
        if loading is not None:
            try:
                await loading
            except Exception:  # noqa: BLE001
                self.log.error(f"{log_tag(id)} could not be started:\n{traceback.format_exc()}")
                return
            finally:
                self._pending.pop(id, None)

            self.log.info(f"{log_tag(id)} finished its module body")

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
            f"{log_tag(id)} started "
            f"({len(script.handlers)} trigger(s), {len(crons)} schedule(s))"
        )

    async def _stop(self, id: str) -> None:
        for task in self._crons.pop(id, []):
            task.cancel()

        script = self._scripts.pop(id, None)
        if script is None:
            return

        await script.stop()
        self.log.info(f"{log_tag(id)} stopped")

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
