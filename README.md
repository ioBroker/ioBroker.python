# ioBroker.python

Write ioBroker logic scripts in Python.

This is what `ioBroker.javascript` is for JavaScript. Scripts are ordinary ioBroker `script`
objects, so the existing script tree and editor keep working; what decides who runs a script is
`common.engine`, exactly as it already does when several `javascript.N` instances share one tree.

> **Status: prototype.** The runtime works and is covered by tests. There is no admin UI yet — see
> [What is missing](#what-is-missing).

## Why the adapter is itself written in Python

Since js-controller 8 an adapter may declare `common.platform: "Python"`, and the controller starts
it from the virtual environment py-controller maintains. This adapter does exactly that and talks
to the states and objects databases through the [Python SDK](https://github.com/ioBroker/iobroker-python).

That is the whole design argument: **nothing bridges between Node.js and Python at runtime.** Had
the Python scripts been bolted onto the javascript adapter instead, that Node process would have had
to spawn Python children, supervise them and tunnel the whole script API over IPC — rebuilding what
js-controller already does natively.

## What a script looks like

The API deliberately reads like the javascript adapter's, because the people writing these scripts
already know that one. Nothing is imported; the host injects the names.

```python
@on("hue.0.lamp.level")
def dim(id, state):
    if state.val > 80:
        set_state("hue.0.lamp.on", True)
        log.info(f"lamp on, level is {state.val}")

@schedule("0 22 * * *")
def night():
    set_state("hue.0.lamp.on", False)
```

| Name | Meaning |
| --- | --- |
| `on(pattern, handler)` | run on every matching state change; `*` is the only wildcard. Usable as a decorator. |
| `schedule(cron, handler)` | five-field cron: `minute hour day month weekday`. |
| `set_state(id, val, ack=False)` | write a state. |
| `get_state(id)` | read a state — **must be awaited**, so the handler must be `async def`. |
| `send_to(instance, command, message)` | message another adapter. |
| `log.info` / `.warn` / `.error` / `.debug` | logging, tagged with the script name. |
| `on_stop(handler)` | cleanup when the script is stopped, disabled or edited. |

### Sync or async — the one rule

Handlers may be `def` or `async def`. Writes return a task, which is what makes both spellings
work: a plain `def` handler fires and forgets, an `async def` one can `await` the same call. Reads
must be awaited. So: **a script that only writes can stay `def`; a script that reads other states
declares that handler `async def`.**

```python
@on("button.0.pressed")
async def report(id, state):
    level = await get_state("hue.0.lamp.level")
    log.info(f"lamp was at {level.val}")
```

See [`examples/lights.py`](examples/lights.py).

## How a script is assigned to this engine

A `script` object is picked up when all of this holds:

```jsonc
{
  "type": "script",
  "common": {
    "engine": "system.adapter.python.0",  // routes it here
    "engineType": "Python/py",            // refused if it says Javascript/js
    "enabled": true,
    "source": "..."
  }
}
```

Everything else in the tree is left alone, so this adapter and the javascript adapter can share
`script.*` without stepping on each other. Editing the source restarts the script; disabling it
stops it; both happen live through the object subscription.

## Process model

All scripts share this one process and run as asyncio tasks. A process per script would cost
30–50 MB **and its own pair of database connections** each, which does not fit the machines ioBroker
runs on.

The trade is that a script which blocks stalls its neighbours — exactly as a `while(true)` in a
JavaScript script stalls the javascript adapter today, so it is a trade users already live with.
The host at least names the culprit: a dispatch taking longer than two seconds is logged with the
state that triggered it. A compile error or a raising handler is contained and never takes the host
or the other scripts down.

## Development

```bash
pip install -e ".[dev]"     # plus the SDK: pip install -e ../iobroker-python
pytest                      # needs a Redis on 127.0.0.1:6379, database 15 is flushed
ruff check .
```

The tests run a real `ScriptHost` against a real database: a script object goes in, a state change
goes in, and the state the script wrote comes out.

## What is missing

Honest list, in the order I would tackle it:

1. **Admin UI.** The runtime is the cheap part; the editor is the project. The cheapest path is to
   let the existing javascript script editor manage `Python/py` scripts — that needs
   `engineType: 'Python/py'` added to `ScriptCommon` in js-controller's `types-dev/objects.d.ts`
   (today a closed union of four JS-ish values) and the admin UI to tolerate it.
2. **`unsubscribe` in the SDK.** When a script stops, its state patterns stay subscribed for the
   life of the process — harmless but wasteful. The SDK has no `unsubscribe_foreign_states` yet.
3. **Per-script dependencies.** `doc/PYTHON.md` gives py-controller one environment per *adapter*,
   which leaves no room for a script that wants `numpy`. Needs a decision before it becomes a
   support question.
4. **Blocking-script isolation.** Sub-interpreters (PEP 684/734) would give real per-script
   isolation in one process, but `concurrent.interpreters` is 3.14 stdlib and the SDK targets 3.10+.
   An opt-in "run this script in its own process" flag is the pragmatic interim.

## License

MIT
