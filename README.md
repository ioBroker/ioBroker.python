# ioBroker.python

Write ioBroker logic scripts in Python.

This is what `ioBroker.javascript` is for JavaScript. Scripts are ordinary ioBroker `script`
objects, so the existing script tree and editor keep working; what decides who runs a script is
`common.engine`, exactly as it already does when several `javascript.N` instances share one tree.

> **Status: prototype.** The runtime works and is covered by tests. The admin UI is written but has
> not yet been opened in a running admin — see [The admin UI](#the-admin-ui).

## Requirements

- **js-controller with Python support.** The `common.platform: "Python"` start path.
- **The `py-controller` adapter, on the same host.** This is not optional. js-controller only ever
  *checks* whether a Python environment exists — it never builds one. Without py-controller there is
  no virtual environment, so the instance is never started and the log says
  `Python environment is missing … Install the "py-controller" adapter`.

  It belongs in `common.dependencies` (same host) rather than `globalDependencies` (any host),
  because the environment lives at `<iobroker-data>/py/<adapterName>/` — host-local state, like
  `node_modules`. **It is not declared in `io-package.json` yet**: `iobroker.py-controller` is not
  published, and depending on a package that does not exist would make this adapter impossible to
  add. Once it ships, the entry is:

  ```json
  "dependencies": [{ "js-controller": ">7.2.2" }, { "py-controller": ">=0.1.0" }]
  ```

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

| Name                                       | Meaning                                                                              |
|--------------------------------------------|--------------------------------------------------------------------------------------|
| `on(pattern, handler)`                     | run on every matching state change; `*` is the only wildcard. Usable as a decorator. |
| `schedule(cron, handler)`                  | five-field cron: `minute hour day month weekday`.                                    |
| `set_state(id, val, ack=False)`            | write a state.                                                                       |
| `get_state(id)`                            | read a state — **must be awaited**, so the handler must be `async def`.              |
| `send_to(instance, command, message)`      | message another adapter.                                                             |
| `log.info` / `.warn` / `.error` / `.debug` | logging, tagged with the script name.                                                |
| `on_stop(handler)`                         | cleanup when the script is stopped, disabled or edited.                              |

### The previous value

A handler declared with a **third parameter** is given the state as it was before the change — the
counterpart of `oldState` in the javascript adapter. It is `None` for the first change the engine
sees after starting.

```python
@on("hue.0.lamp.level")
def dim(id, state, old):
    if old is not None and state.val > old.val:
        log.info(f"level rose from {old.val} to {state.val}")
```

Opt-in by design: two-parameter handlers are dispatched exactly as before, so the extra argument
costs nothing to a script that does not ask for it. The previous value is remembered by the engine,
not by the SDK — the same division ioBroker makes, where adapter-core reports a change and the
script engine is what remembers what came before.

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

A `script` object is picked up when all of these hold:

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

## The admin UI

Two pieces, both declared the way `ioBroker.javascript` declares its own
(`adminUI: { "config": "json", "tab": "html" }`):

- **Instance settings** — `admin/jsonConfig.json`, rendered by admin. Two settings, both of which
  actually do something: how long a script may block before the engine complains, and how many log
  lines the tab keeps.
- **The "Python scripts" tab** — built from `src-admin/` into `admin/tab.html`, deliberately shaped
  like the javascript adapter's editor: a folder tree with per-row start/stop, delete and edit, an
  editor with Python syntax highlighting, save/cancel/undo/redo, a state picker and a cron editor
  that insert at the caret, and a live log pane filtered to the selected instance.

### Folders and the script tree

Folders are real `channel` objects (`script.py.<folder>`), exactly as the javascript adapter stores
them — so an **empty folder exists and survives a reload** rather than being inferred from dotted
ids. The tree shows both: folder objects, and folders implied by a script's id, so a script never
disappears because its folder object is missing. A folder can only be deleted when it is empty.

The row buttons mirror the javascript adapter's — start/stop, delete, edit — with one deliberate
difference. There, the play/pause icon reflects `common.enabled`, which is as much as it can know.
Here the button still toggles `enabled`, but its **colour reports what the engine actually does**:
green when the script really runs, **amber when it is enabled but not running** — a script that
failed to compile, which the javascript adapter has no way to show. Running state comes from the
adapter's own `listScripts` messagebox command, polled every five seconds.

The tab is a **React app** in `src-admin/`, on the same stack `ioBroker.javascript` uses — React 19,
MUI 9, `@iobroker/gui-components`, Vite — and it builds into `admin/`:

```bash
npm run install-admin   # once
npm run build           # src-admin -> admin/tab.html + admin/assets
npm run start-admin     # vite dev server on :3000, data proxied from a real ioBroker on :8081
```

Two components come straight from `@iobroker/gui-components` and are what make the editor more than
a text box:

- **`DialogSelectID`** — the state picker. It inserts the chosen id **at the caret**, as a quoted
  string, which is what you need inside `@on(...)`.
- **`DialogCron`** — the schedule editor, with the simple/complex/wizard modes. It inserts a whole
  `@schedule("…")` decorator line, trimmed to the five fields the engine's cron parser accepts.

The sidebar and the log pane are on draggable splitters (`@devbookhq/splitter`, the same library the
javascript adapter uses), and the sizes are remembered in `localStorage`. Save and Cancel appear
only while there is something to save — their showing up *is* the unsaved-changes signal, so no pair
of dead buttons sits in the toolbar. Dialog buttons follow the ioBroker order taken from
gui-components' own `DialogConfirm`: the action first, **Cancel always rightmost**.

The app extends `GenericApp` with `Connection: AdminConnection`, `bottomButtons: false` (a tab
manages objects, it does not edit this instance's config) and `socket: { autoSubscribeLog: true }` —
that last one is what feeds the log pane, via `registerLogHandler`. Script changes arrive live
through `subscribeObject('script.py.*')`, and an edit made elsewhere is followed *unless* you have
unsaved changes in the editor.

The code editor is deliberately **not** Monaco: a highlighted `<pre>` sits under a transparent
`<textarea>`. Monaco would have to be bundled or fetched, and an ioBroker box is often offline. The
invariant the technique needs — the rendered text with tags stripped must equal the source exactly,
or the overlay drifts from the caret — is verified, see below.

The bundle is one ~1.5 MB chunk (440 kB gzipped) because React, MUI and gui-components are bundled
rather than shared with admin through **module federation**, which is what the javascript adapter
does. A self-contained bundle in an iframe always works; federation is an optimisation that cannot
be verified without a running admin. `moduleFederationShared` from gui-components is the way to add
it later.

> **Not yet opened in a live admin.** What *was* verified: `io-package.json` validates against
> js-controller's schema, the app type-checks under `strict` and builds clean, and the syntax
> highlighter provably never loses or misescapes a character. The socket handshake is the part to
> smoke-test first — it is the standard `AdminConnection`, loaded through the same two script tags
> the javascript adapter's tab uses, so if it fails it fails the same way that one would.

### Linting your own scripts

A logic script is executed with `on`, `schedule`, `set_state`, `log` and friends already in its
namespace, so a linter reading it as a standalone file reports undefined names. Tell ruff about
them:

```toml
[tool.ruff.lint]
builtins = ["on", "schedule", "on_stop", "set_state", "get_state", "send_to", "log"]
```

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
pip install -e "./python[dev]"   # the adapter package; pulls the SDK from PyPI
pytest                      # needs a Redis on 127.0.0.1:6379, database 15 is flushed
ruff check .
```

The tests run a real `ScriptHost` against a real database: a script object goes in, a state change
goes in, and the state the script wrote comes out.

### Where the Python packaging lives

`python/pyproject.toml` is the Python counterpart of `package.json`: it names the package, its
version and its one dependency (the SDK, published on PyPI as `iobroker`), and says which backend
builds it. It sits next to the module rather than in the repository root because that is where
py-controller looks -- it runs `uv pip install .` from `python/` and hashes that file to notice
dependency changes.

The `pyproject.toml` in the root holds **only** tool configuration (pytest, ruff), whose paths are
relative to it, so it stays where those tools are run from.

`npm run test:package` validates package.json and io-package.json against the ioBroker schema. That
matters more here than for an ordinary adapter, because this one declares `common.platform: "Python"`
and a `main` pointing into `python/` — fields almost nothing else uses, so a mistake in them would
surface only when the controller refuses to start an instance.

**There is no `@iobroker/testing` integration test, and there cannot be one yet.** That harness empties
the data directory before every single test (`clearDBDir`), and a Python adapter's virtual
environment lives inside it at `iobroker-data/py/<adapter>/venv`. Without an environment js-controller
refuses to start the instance, so the harness's mandatory "The adapter starts" test waits for an
`alive` that never arrives. The harness would have to learn about Python adapters first. The runtime
is covered instead by the pytest suite above, which starts a real host against a real database.

## What is missing

Honest list, in the order I would tackle it:

1. **Smoke-test the tab in a running admin.** See the warning above — the connection handshake is
   the one part that could not be exercised here.
2. **Declare the `py-controller` dependency** once that adapter is published — see
   [Requirements](#requirements). Until then the prerequisite exists but is undeclared, so a missing
   py-controller shows up as an instance that never starts rather than as a refused installation.
3. **`engineType: 'Python/py'` in js-controller.** `ScriptCommon.engineType` in
   `types-dev/objects.d.ts` is a closed union of four JS-ish values, and `ScriptOrChannel` hardwires
   the `script.js.` prefix. Nothing breaks without it — the javascript adapter warns
   `Unknown engine type` and skips ours, and this adapter uses `script.py.*` — but the type is
   wrong until Python is in it.
4. **`unsubscribe` in the SDK.** When a script stops, its state patterns stay subscribed for the
   life of the process — harmless but wasteful. The SDK has no `unsubscribe_foreign_states` yet.
5. **Per-script dependencies.** `doc/PYTHON.md` gives py-controller one environment per *adapter*,
   which leaves no room for a script that wants `numpy`. Needs a decision before it becomes a
   support question.
6. **Blocking-script isolation.** Sub-interpreters (PEP 684/734) would give real per-script
   isolation in one process, but `concurrent.interpreters` is 3.14 stdlib and the SDK targets 3.10+.
   An opt-in "run this script in its own process" flag is the pragmatic interim.
7. **Editor niceties.** No autocomplete, no folder tree (dots in the name are shown as a path), no
   rename. All cheap to add once the tab is proven to work.

## Trademark

`admin/python.png` is the official Python logo, downloaded **unaltered** from python.org and used to
refer to the Python programming language. The PSF's
[trademark policy](https://www.python.org/psf/trademarks/) allows this: *"Non-commercial uses to
promote the Python programming language are allowed, as are all nominative uses"*, and it names
*"use of freely distributable derived logos as icons for files and executables"* explicitly.

Two things follow from that and should not be changed casually. The shape must stay as it is — the
policy only expects colours to vary — which is why the file is shipped byte-for-byte as downloaded
rather than redrawn. And the permission rests on this adapter being freely distributed:
**any commercial use needs prior written permission from the PSF.**

Python and the Python logo are trademarks of the Python Software Foundation. This adapter is not
affiliated with or endorsed by the PSF.

## License

MIT (the adapter's own code; see [Trademark](#trademark) for the logo)
