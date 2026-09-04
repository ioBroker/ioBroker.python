/** What `common.engineType` must say for a script to belong to this engine. */
export const ENGINE_TYPE = 'Python/py';

/** Python scripts live in their own branch; `script.js.*` belongs to the javascript adapter. */
export const PREFIX = 'script.py.';

export const TEMPLATE = `# A Python logic script.
# on, schedule, set_state, get_state, send_to, log and on_stop are provided --
# there is nothing to import.

@on("system.adapter.admin.0.alive")
def react(id, state):
    log.info(f"{id} is now {state.val}")
`;

/**
 * A script object as this adapter uses it.
 *
 * ioBroker's own `ScriptCommon.engineType` is still a closed union of four JavaScript-ish values,
 * so `Python/py` does not type-check against it yet -- see the README's "What is missing".
 */
export interface ScriptObject extends Omit<ioBroker.ScriptObject, 'common'> {
    common: Omit<ioBroker.ScriptCommon, 'engineType'> & { engineType: string };
}

export interface LogLine {
    id: number;
    ts: number;
    message: string;
    severity: string;
}
