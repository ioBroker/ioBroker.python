# An example logic script. Paste the body into a script object's `common.source`
# (or the script editor) -- everything below is what a user writes.
#
# The names `on`, `schedule`, `set_state`, `get_state`, `send_to`, `log` and
# `on_stop` are injected by the host; there is nothing to import.
#
# A handler receives one event object, the same information the javascript
# adapter's `on()` callback gets, under the same names adapted to Python.


@on("hue.0.lamp.level")
def dim(event):
    """Turn the lamp on as soon as somebody dims it above 80%."""
    if event.state.val > 80:
        set_state("hue.0.lamp.on", True)
        log.info(f"{event.name} reached {event.state.val}")


@on("hue.0.lamp.level")
def only_on_a_real_change(event):
    """`old_state` is None for the first change the engine sees after starting."""
    if event.old_state is not None and event.state.val != event.old_state.val:
        log.info(f"{event.old_state.val} -> {event.state.val}")


@on("sensor.0.*.motion")
def anywhere(event):
    """One handler for many states -- `*` is the only wildcard.

    The event knows where the state sits in the tree, so the message can name the
    room rather than repeating the id.
    """
    if event.state.val:
        log.info(f"motion in {event.channel_name or event.id} ({', '.join(event.enum_names)})")


@schedule("0 22 * * *")
def night():
    """Every day at 22:00."""
    set_state("hue.0.lamp.on", False)


@on("button.0.pressed")
async def report(event):
    """An async handler may read other states; a plain `def` one may only write."""
    level = await get_state("hue.0.lamp.level")
    log.info(f"button pressed while {level.val}")
    send_to("telegram.0", "send", {"text": f"Lamp is at {level.val}%"})


@on_stop
def cleanup():
    """Runs when the script is disabled, edited or the adapter shuts down."""
    log.info("lights script going away")
