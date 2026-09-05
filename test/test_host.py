"""The script host end to end: a script object in the database becomes running logic."""

from __future__ import annotations

from support import (
    drive_state,
    put_instance,
    put_script,
    script_object,
    wait_for_state,
    wait_until,
)

DOUBLER = """
@on("trigger.0.value")
def react(id, state):
    set_state("result.0.doubled", state.val * 2, ack=True)
"""

ASYNC_READER = """
@on("trigger.0.go")
async def react(id, state):
    other = await get_state("trigger.0.value")
    set_state("result.0.echo", other.val, ack=True)
"""


class TestRunningScripts:
    async def test_a_script_reacts_to_a_state_change(self, db, start_host) -> None:
        await put_script(db, script_object("script.py.doubler", DOUBLER))

        await start_host()
        await drive_state(db, "trigger.0.value", 21)

        result = await wait_for_state(db, "result.0.doubled")
        assert result is not None, "the script never reacted"
        assert result["val"] == 42
        assert result["ack"] is True
        # The write came from the host, so the rest of the system can see who did it.
        assert result["from"] == "system.adapter.python.0"

    async def test_a_script_added_while_running_is_picked_up(self, db, start_host) -> None:
        host = await start_host()
        assert host._scripts == {}

        await put_script(db, script_object("script.py.late", DOUBLER))

        assert await wait_until(lambda: _has(host, "script.py.late")), "script was not picked up"
        await drive_state(db, "trigger.0.value", 5)
        result = await wait_for_state(db, "result.0.doubled")
        assert result is not None and result["val"] == 10

    async def test_an_async_handler_may_read_other_states(self, db, start_host) -> None:
        await put_script(db, script_object("script.py.reader", ASYNC_READER))
        await start_host()
        await drive_state(db, "trigger.0.value", "hello")

        await drive_state(db, "trigger.0.go", True)

        result = await wait_for_state(db, "result.0.echo")
        assert result is not None and result["val"] == "hello"


EVENT = """
@on("trigger.0.value")
def react(event):
    set_state("result.0.event", f"{event.id}={event.state.val}", ack=True)
"""

EVENT_PREVIOUS = """
@on("trigger.0.value")
def react(event):
    old = event.old_state
    set_state("result.0.previous", "none" if old is None else old.val, ack=True)
"""

LEGACY_THREE = """
@on("trigger.0.value")
def react(id, state, old):
    set_state("result.0.legacy3", "none" if old is None else old.val, ack=True)
"""


class TestEventObject:
    """A handler takes one event object, the way an `on()` callback does in the javascript
    adapter. `test_event.py` covers the object itself; these check it reaches a real script."""

    async def test_a_handler_receives_the_event(self, db, start_host) -> None:
        await put_script(db, script_object("script.py.ev", EVENT))
        await start_host()

        await drive_state(db, "trigger.0.value", 7)

        result = await wait_for_state(db, "result.0.event")
        assert result is not None and result["val"] == "trigger.0.value=7"


class TestPreviousState:
    """`old_state` on the event -- the counterpart of `oldState` in the javascript adapter."""

    async def test_the_first_change_has_no_previous_value(self, db, start_host) -> None:
        await put_script(db, script_object("script.py.prev", EVENT_PREVIOUS))
        await start_host()

        await drive_state(db, "trigger.0.value", 1)

        result = await wait_for_state(db, "result.0.previous")
        assert result is not None and result["val"] == "none"

    async def test_the_second_change_sees_the_first(self, db, start_host) -> None:
        await put_script(db, script_object("script.py.prev", EVENT_PREVIOUS))
        await start_host()
        await drive_state(db, "trigger.0.value", 1)
        assert await wait_until(lambda: _has_value(db, "result.0.previous", "none"))

        await drive_state(db, "trigger.0.value", 2)

        assert await wait_until(lambda: _has_value(db, "result.0.previous", 1)), (
            "the handler did not receive the previous value"
        )

    async def test_the_two_parameter_shape_still_works(self, db, start_host) -> None:
        # The spelling this adapter used before the event object. Scripts in the wild use it, so
        # it stays dispatched.
        await put_script(db, script_object("script.py.doubler", DOUBLER))
        await start_host()

        await drive_state(db, "trigger.0.value", 3)

        result = await wait_for_state(db, "result.0.doubled")
        assert result is not None and result["val"] == 6

    async def test_the_three_parameter_shape_still_works(self, db, start_host) -> None:
        await put_script(db, script_object("script.py.legacy3", LEGACY_THREE))
        await start_host()

        await drive_state(db, "trigger.0.value", 1)

        result = await wait_for_state(db, "result.0.legacy3")
        assert result is not None and result["val"] == "none"


class TestRouting:
    async def test_a_script_for_another_engine_is_ignored(self, db, start_host) -> None:
        # This is what lets a Python engine and the javascript adapter share one script tree.
        await put_script(
            db,
            script_object("script.py.foreign", DOUBLER, engine="system.adapter.javascript.0"),
        )

        host = await start_host()

        assert host._scripts == {}

    async def test_a_disabled_script_is_not_run(self, db, start_host) -> None:
        await put_script(db, script_object("script.py.off", DOUBLER, enabled=False))

        host = await start_host()

        assert host._scripts == {}

    async def test_a_javascript_script_assigned_here_is_refused(self, db, start_host) -> None:
        # Compiling JavaScript as Python would fail with a SyntaxError that explains nothing.
        obj = script_object("script.py.wrong", "console.log('hi');")
        obj["common"]["engineType"] = "Javascript/js"
        await put_script(db, obj)

        host = await start_host()

        assert host._scripts == {}


class TestLifecycle:
    async def test_disabling_a_script_stops_it(self, db, start_host) -> None:
        await put_script(db, script_object("script.py.toggle", DOUBLER))
        host = await start_host()
        assert await wait_until(lambda: _has(host, "script.py.toggle"))

        await put_script(db, script_object("script.py.toggle", DOUBLER, enabled=False))

        assert await wait_until(lambda: _lacks(host, "script.py.toggle")), "script kept running"

    async def test_editing_the_source_reloads_the_script(self, db, start_host) -> None:
        await put_script(db, script_object("script.py.edit", DOUBLER))
        host = await start_host()
        assert await wait_until(lambda: _has(host, "script.py.edit"))

        tripled = DOUBLER.replace("state.val * 2", "state.val * 3").replace("doubled", "tripled")
        await put_script(db, script_object("script.py.edit", tripled))
        assert await wait_until(
            lambda: _source_contains(host, "script.py.edit", "* 3")
        ), "the edit was not applied"

        await drive_state(db, "trigger.0.value", 5)
        result = await wait_for_state(db, "result.0.tripled")
        assert result is not None and result["val"] == 15

    async def test_a_broken_script_does_not_take_the_host_down(self, db, start_host) -> None:
        await put_script(db, script_object("script.py.broken", "this is not python"))
        await put_script(db, script_object("script.py.healthy", DOUBLER))

        host = await start_host()

        assert "script.py.broken" not in host._scripts
        assert await wait_until(lambda: _has(host, "script.py.healthy"))
        await drive_state(db, "trigger.0.value", 4)
        assert (await wait_for_state(db, "result.0.doubled"))["val"] == 8

    async def test_a_raising_handler_does_not_stop_the_others(self, db, start_host) -> None:
        await put_script(
            db,
            script_object(
                "script.py.raiser",
                '@on("trigger.0.value")\ndef boom(id, state):\n    raise RuntimeError("nope")\n',
            ),
        )
        await put_script(db, script_object("script.py.doubler", DOUBLER))

        await start_host()
        await drive_state(db, "trigger.0.value", 7)

        result = await wait_for_state(db, "result.0.doubled")
        assert result is not None and result["val"] == 14


class TestConfiguration:
    """The instance settings page is only worth having if the settings do something."""

    async def test_the_blocked_warning_threshold_is_taken_from_the_config(
        self, db, start_host
    ) -> None:
        await put_instance(db, {"blockedWarnSeconds": 5})

        host = await start_host()

        assert host._blocked_warn == 5.0

    async def test_a_nonsense_threshold_falls_back(self, db, start_host) -> None:
        await put_instance(db, {"blockedWarnSeconds": "soon"})

        host = await start_host()

        assert host._blocked_warn == 2.0

    async def test_the_default_applies_without_a_config(self, db, start_host) -> None:
        host = await start_host()

        assert host._blocked_warn == 2.0


class TestReporting:
    async def test_the_number_of_running_scripts_is_published(self, db, start_host) -> None:
        await put_script(db, script_object("script.py.one", DOUBLER))
        await start_host()

        running = await wait_for_state(db, "python.0.scriptsRunning")

        assert running is not None and running["val"] == 1


async def _has_value(client, id: str, expected) -> bool:
    state = await wait_for_state(client, id, timeout=0.1)
    return state is not None and state["val"] == expected


async def _has(host, id: str) -> bool:
    return id in host._scripts


async def _lacks(host, id: str) -> bool:
    return id not in host._scripts


async def _source_contains(host, id: str, needle: str) -> bool:
    script = host._scripts.get(id)
    return script is not None and needle in script.source
