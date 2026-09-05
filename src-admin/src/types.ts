/** What `common.engineType` must say for a script to belong to this engine. */
export const ENGINE_TYPE = 'Python/py';

/** Python scripts live in their own branch; `script.js.*` belongs to the javascript adapter. */
export const PREFIX = 'script.py.';

export const TEMPLATE = `# A Python logic script.
# on, schedule, set_state, get_state, send_to, log and on_stop are provided --
# there is nothing to import.
#
# The handler receives one event object: id, state, old_state, name,
# channel_name, device_name, enum_names, common, native.

@on("system.adapter.admin.0.alive")
def react(event):
    log.info(f"{event.id} is now {event.state.val}")
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

/**
 * A folder, stored as a `channel` object -- the same way the javascript adapter stores them, so the
 * two script trees look and behave alike. Folders are real objects rather than something inferred
 * from dotted ids: that is what lets an empty folder exist and survive a reload.
 */
export type FolderObject = ioBroker.ChannelObject;

export interface LogLine {
    id: number;
    ts: number;
    message: string;
    severity: string;
    /**
     * Full id of the script the line belongs to, e.g. `script.py.lights`.
     *
     * Undefined for the engine's own lines -- the ones that belong to the instance rather than to
     * any single script, such as its startup and the object cache it builds.
     */
    script?: string;
}

export interface TreeFolder {
    kind: 'folder';
    id: string;
    name: string;
    children: TreeNode[];
    /** Scripts anywhere below this folder -- what the count badge shows. */
    total: number;
}

export interface TreeScript {
    kind: 'script';
    id: string;
    name: string;
    obj: ScriptObject;
}

export type TreeNode = TreeFolder | TreeScript;

/** The instance number a script is assigned to, for the `[0]` badge. */
export function instanceOf(obj: ScriptObject): number {
    const match = /\.(\d+)$/.exec(obj.common.engine || '');
    return match ? Number(match[1]) : 0;
}

/**
 * Build the tree shown in the sidebar.
 *
 * Folders come from two places: real `channel` objects (so an empty one still shows) and the dotted
 * parts of script ids (so a script never disappears because its folder object is missing).
 */
export function buildTree(
    scripts: Record<string, ScriptObject>,
    folders: Record<string, FolderObject>,
    filter: string,
): TreeNode[] {
    const needle = filter.trim().toLowerCase();
    const roots: TreeFolder = { kind: 'folder', id: '', name: '', children: [], total: 0 };
    const byId = new Map<string, TreeFolder>([['', roots]]);

    const folderAt = (path: string[]): TreeFolder => {
        let current = roots;
        let id = '';
        for (const part of path) {
            id = id ? `${id}.${part}` : part;
            let next = byId.get(id);
            if (!next) {
                next = { kind: 'folder', id: PREFIX + id, name: part, children: [], total: 0 };
                byId.set(id, next);
                current.children.push(next);
            }
            current = next;
        }
        return current;
    };

    Object.keys(folders)
        .sort()
        .forEach(id => folderAt(id.substring(PREFIX.length).split('.')));

    Object.keys(scripts)
        .sort()
        .forEach(id => {
            const parts = id.substring(PREFIX.length).split('.');
            const name = parts.pop() as string;
            if (needle && !name.toLowerCase().includes(needle) && !id.toLowerCase().includes(needle)) {
                return;
            }
            folderAt(parts).children.push({ kind: 'script', id, name, obj: scripts[id] });
        });

    const sort = (folder: TreeFolder): number => {
        let total = 0;
        folder.children.forEach(child => {
            total += child.kind === 'folder' ? sort(child) : 1;
        });
        folder.children.sort((a, b) => {
            if (a.kind !== b.kind) {
                return a.kind === 'folder' ? -1 : 1; // folders first, like the javascript adapter
            }
            return a.name.localeCompare(b.name);
        });
        folder.total = total;
        return total;
    };
    sort(roots);

    return roots.children;
}

/** Every folder id in the tree -- used by "expand all". */
export function allFolderIds(nodes: TreeNode[]): string[] {
    const ids: string[] = [];
    const walk = (list: TreeNode[]): void =>
        list.forEach(node => {
            if (node.kind === 'folder') {
                ids.push(node.id);
                walk(node.children);
            }
        });
    walk(nodes);
    return ids;
}
