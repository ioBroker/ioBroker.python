# An example logic script. Paste the body into a script object's `common.source`
# (or the script editor) -- everything below is what a user writes.
#
# The names `on`, `schedule`, `set_state`, `get_state`, `send_to`, `log` and
# `on_stop` are injected by the host; there is nothing to import.


@on("hue.0.lamp.level")
def dim(id, state):
    """Turn the lamp on as soon as somebody dims it above 80%."""
    if state.val > 80:
        set_state("hue.0.lamp.on", True)
        log.info(f"lamp turned on because level reached {state.val}")


@on("sensor.0.*.motion")
def anywhere(id, state):
    """One handler for many states -- `*` is the only wildcard."""
    if state.val:
        log.info(f"motion at {id}")


@schedule("0 22 * * *")
def night():
    """Every day at 22:00."""
    set_state("hue.0.lamp.on", False)


@on("button.0.pressed")
async def report(id, state):
    """An async handler may read other states; a plain `def` one may only write."""
    level = await get_state("hue.0.lamp.level")
    log.info(f"button pressed while the lamp was at {level.val}")
    send_to("telegram.0", "send", {"text": f"Lamp is at {level.val}%"})


@on_stop
def cleanup():
    """Runs when the script is disabled, edited or the adapter shuts down."""
    log.info("lights script going away")
