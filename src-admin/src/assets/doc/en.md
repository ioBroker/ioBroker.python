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

Runs a handler whenever a matching state is written.

```python
@on("hue.0.lamp.level")
def one(event): ...

@on("hue.0.*")            # * is the only wildcard
def many(event): ...

on("hue.0.lamp.on", handler)   # or without the decorator
```

The handler receives an event object. The older `(id, state)` and `(id, state, old)` spellings are
still dispatched, so scripts written against them keep running.

Written, not changed: the handler runs on every write that reaches it, including one that writes the
same value again. The javascript adapter's `on('some.id', cb)` is short for `{ change: 'ne' }` and
fires only on a real change, so a script ported from there runs more often here than it used to.
Compare the two states when that matters:

```python
@on("hue.0.lamp.level")
def only_on_a_real_change(event):
    if event.old_state is None or event.state.val != event.old_state.val:
        log.info(f"changed to {event.state.val}")
```

The argument is an id pattern, not a pattern object: there is no `{id: ..., change: 'any', valGt: 5}`
form. Filter inside the handler.

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

`old_state` is `None` for the first change the engine sees after starting -- there is nothing it
could have remembered yet. `state` is `None` when the state was deleted.

A state itself is an object, not a bare value:

| Attribute | Meaning |
| --- | --- |
| `val` | The value |
| `ack` | `False` is a command towards a device, `True` a confirmed reading |
| `ts` | When it was written, milliseconds since the epoch |
| `lc` | Last change -- only moves forward when `val` actually changed |
| `q` | Quality, `0` is good |
| `from_` | Who wrote it, e.g. `system.adapter.hue.0`; the underscore is because `from` is a keyword |
| `user` | The user it was written as |
| `c` | Free-text comment |

`ack` is the one that matters. Confusing the two builds feedback loops.

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

## Coming from JavaScript

| javascript adapter | here |
| --- | --- |
| `obj.state`, `obj.newState` | `event.state`, `event.new_state` |
| `obj.oldState` | `event.old_state` |
| `obj.channelName`, `obj.deviceName` | `event.channel_name`, `event.device_name` |
| `obj.enumNames` | `event.enum_names` |
| `getState(id)` | `await get_state(id)` |
| `setState(id, v, ack)` | `set_state(id, v, ack)` |
| `sendTo(...)` | `send_to(...)` |
| `schedule('0 22 * * *', fn)` | `@schedule("0 22 * * *")` |
| `onStop(fn)` | `@on_stop` |

Not here yet: `setTimeout` and `setInterval`, pattern objects in `on()`, and the `change: 'ne'`
default described above.

## Common mistakes

**`state.oldVal` does not exist.** It does not exist in the javascript adapter either -- there,
`oldVal` is a *pattern selector* (`on({id: '...', oldVal: 5}, ...)`) deciding when to fire, not a
property of a state. The previous value is `event.old_state.val`:

```python
if event.old_state is not None:
    log.info(f"was {event.old_state.val}")
```

**Forgetting `await` on `get_state`.** Without it you hold an unfinished task instead of a value.
Declare the handler `async def` and await the call.

**Importing the API.** `on`, `log`, `set_state` and the rest are already there; an `import` line for
them fails.

**`time.sleep()`.** It stops every other script in the instance. Use `await asyncio.sleep()` in an
`async def` handler.

## Editor

| | |
| --- | --- |
| `Ctrl`/`Cmd` + `S` | Save |
| `Tab` | Four spaces |
| `{}` | Pick an object id; with the cursor on one, it opens on that id and replaces it |
| Clock | Cron wizard, likewise on the expression under the cursor |

The tab reopens where it was left: the same script, the same open folders, both panes scrolled where
they were.
