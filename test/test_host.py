"""The script host end to end: a script object in the database becomes running logic."""

from __future__ import annotations

from support import drive_state, put_script, script_object, wait_for_state, wait_until

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


class TestReporting:
    async def test_the_number_of_running_scripts_is_published(self, db, start_host) -> None:
        await put_script(db, script_object("script.py.one", DOUBLER))
        await start_host()

        running = await wait_for_state(db, "python.0.scriptsRunning")

        assert running is not None and running["val"] == 1


async def _has(host, id: str) -> bool:
    return id in host._scripts


async def _lacks(host, id: str) -> bool:
    return id not in host._scripts


async def _source_contains(host, id: str, needle: str) -> bool:
    script = host._scripts.get(id)
    return script is not None and needle in script.source
