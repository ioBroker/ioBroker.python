# Python scripts

A script is ordinary Python. Nothing has to be imported: `on`, `schedule`, `on_stop`, `set_state`,
`get_state`, `send_to`, `log`, `script_id`, `script_name` and `adapter` are already there when the
script starts.

```python
@on("hue.0.lamp.level")
def dim(event):
    if event.state.val > 80:
        set_state("hue.0.lamp.on", True)
```

The API is deliberately shaped like the javascript adapter's, because most people writing these
scripts already know that one.

## Sync or async

Handlers may be `def` or `async def`.

Writes return a task. That is what makes both spellings work: a plain `def` handler fires and
forgets, an `async def` handler can await the same call.

Reads must be awaited. A script that reads other states declares its handler `async def` -- that is
the whole rule.

```python
@on("hue.0.lamp.on")
async def report(event):
    level = await get_state("hue.0.lamp.level")
    log.info(f"lamp is now {event.state.val} at {level.val}")
```

## One process

All scripts of one instance share a single process and run as asyncio tasks. A script that blocks
stalls its neighbours -- exactly as a `while True` in a JavaScript script stalls the javascript
adapter. Never call `time.sleep()`; use `await asyncio.sleep()` in an `async def` handler.

The engine reports the culprit: a handler that holds the loop longer than
`Warn when a script blocks longer than` seconds is logged with the state change it was handling.

## on

Runs a handler whenever a matching state changes.

```python
@on("hue.0.lamp.level")
def one(event): ...

@on("hue.0.*")            # * is the only wildcard
def many(event): ...

on("hue.0.lamp.on", handler)   # or without the decorator
```

The handler receives an event object. The older `(id, state)` and `(id, state, old)` spellings are
still dispatched, so scripts written against them keep running.

## The event object

Its names are the javascript adapter's `EventObj`, adapted to Python.

| Property | Meaning |
| --- | --- |
| `id` | The state's id |
| `state` | The new state; alias of `new_state` |
| `old_state` | The state before this change, or `None` |
| `obj` | The object behind the id, `{}` when it has none |
| `common`, `native` | Shorthand for the object's two sections |
| `name` | The object's name, in the host's language |
| `channel_id`, `channel_name` | The parent channel, or `None` |
| `device_id`, `device_name` | The parent's parent, or `None` |
| `enum_ids`, `enum_names` | The enums the id belongs to, inherited from its parents |

Everything past the two states is resolved from the object tree on first access and remembered, so a
handler that only reads `event.state.val` pays for nothing else.

A state itself carries `val`, `ack`, `ts`, `lc`, `q`, `from_`, `user`, `expire` and `c`. `ack` is the
one that matters: `False` is a command towards a device, `True` a confirmed reading. Confusing the
two builds feedback loops.

## schedule

Runs a handler on a cron schedule of five fields -- minute, hour, day of month, month, day of week.

```python
@schedule("0 22 * * *")
def night():
    set_state("hue.0.lamp.on", False)
```

Each field takes `*`, a number, a list `1,3,5`, a range `9-17`, a step `*/15`, or a range with a
step `9-17/2`. In the day-of-week field both `0` and `7` mean Sunday. There is no seconds field.

The clock button in the toolbar opens a wizard; with the cursor in an existing expression it opens
on that one and corrects it in place.

## on_stop

Runs when the script is stopped, disabled, or reloaded after an edit. Use it to undo whatever the
script set up.

```python
@on_stop
def cleanup():
    log.info("going away")
```

## set_state, get_state, send_to

```python
set_state("hue.0.lamp.on", True)            # a command   (ack=False)
set_state("hue.0.lamp.on", True, ack=True)  # a reading   (ack=True)

state = await get_state("hue.0.lamp.level")  # needs async def
send_to("telegram.0", "send", {"text": "hello"})
```

All three return a task. Await it, or ignore it and let it run -- a failure is logged against the
script either way.

## log

`log.debug`, `log.info`, `log.warn` and `log.error`. Every line is tagged with the script's name and
appears in the log pane below the editor, coloured by severity.

```python
log.info(f"{event.id} is now {event.state.val}")
```

`log.debug` only reaches the log when the instance's log level allows it.

## Editor

| | |
| --- | --- |
| `Ctrl`/`Cmd` + `S` | Save |
| `Tab` | Four spaces |
| `{}` | Pick an object id; with the cursor on one, it opens on that id and replaces it |
| Clock | Cron wizard, likewise on the expression under the cursor |

The tab reopens where it was left: the same script, the same open folders, both panes scrolled where
they were.
