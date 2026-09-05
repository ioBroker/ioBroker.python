/**
 * The engine's API, read out of the stub the Python package ships.
 *
 * `scripting.pyi` is the one written description of what a logic script is given, and it is there
 * for editors outside this tab anyway. Parsing it here rather than repeating it as a second list
 * means the two cannot drift: whatever is added to the stub shows up in the editor.
 *
 * The parser only understands the shapes the stub actually uses -- a module-level `def`, a `class`
 * with annotated attributes and methods, a module-level annotated name, each optionally followed by
 * a docstring. That is the deal recorded at the top of the stub, and it is what keeps this small.
 */

/** One thing that can be completed. */
export interface Entry {
    name: string;
    /** A method or function, as opposed to an attribute. */
    callable: boolean;
    /** The signature or type, shown to the right of the name. */
    detail: string;
    /** The docstring, shown in the details pane. */
    doc: string;
    /** The stub class this resolves to, when it is one -- what makes `event.state.val` work. */
    type: string;
}

export interface Api {
    /** Names a script has without writing anything: `on`, `log`, `script_id` ... */
    globals: Entry[];
    /** Members per stub class, e.g. `Log` -> debug/info/warn/error. */
    members: Record<string, Entry[]>;
}

const DEF = /^(\s*)def\s+([A-Za-z_]\w*)\s*\((.*?)\)\s*->\s*(.+?):\s*$/;
const ATTR = /^(\s*)([A-Za-z_]\w*)\s*:\s*(.+?)\s*$/;
const CLASS = /^class\s+([A-Za-z_]\w*)[^:]*:\s*$/;

/**
 * The stub class a type annotation refers to, or '' when it is not one of ours.
 *
 * Only the leading name matters: `State | None` and `Awaitable[State | None]` both lead to State,
 * which is what makes a chain like `event.old_state.val` resolve.
 */
function classOf(annotation: string, classes: Set<string>): string {
    const found = annotation.match(/[A-Za-z_]\w*/g) || [];
    return found.find(name => classes.has(name)) || '';
}

/** The docstring that follows a declaration, joined into one line of prose. */
function docAt(lines: string[], at: number): { doc: string; next: number } {
    const first = (lines[at] || '').trim();
    if (!first.startsWith('"""')) {
        return { doc: '', next: at };
    }
    const body: string[] = [];
    const opened = first.slice(3);
    if (opened.endsWith('"""') && opened.length >= 3) {
        return { doc: opened.slice(0, -3).trim(), next: at + 1 };
    }
    body.push(opened);
    let line = at + 1;
    for (; line < lines.length; line++) {
        const text = lines[line];
        const end = text.indexOf('"""');
        if (end !== -1) {
            body.push(text.slice(0, end));
            line++;
            break;
        }
        body.push(text);
    }
    // Blank lines separate paragraphs and are kept; everything else is unwrapped, because the
    // stub is hard-wrapped at a width that has nothing to do with the popup's.
    const paragraphs = body
        .join('\n')
        .split(/\n\s*\n/)
        .map(part =>
            part
                .split('\n')
                .map(item => item.trim())
                .join(' ')
                .trim(),
        )
        .filter(Boolean);
    return { doc: paragraphs.join('\n\n'), next: line };
}

export function parseStub(stub: string): Api {
    const lines = stub.split(/\r?\n/);

    // Two passes: the class names have to be known before an annotation can be resolved against
    // them, and a class may be referred to before it is declared.
    const classes = new Set<string>();
    lines.forEach(line => {
        const match = CLASS.exec(line);
        if (match) {
            classes.add(match[1]);
        }
    });

    const api: Api = { globals: [], members: {} };
    let current = '';

    for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        if (!line.trim() || line.trimStart().startsWith('#')) {
            continue;
        }

        const asClass = CLASS.exec(line);
        if (asClass) {
            current = asClass[1];
            api.members[current] = [];
            // Skip the class's own docstring, so it is not read as the first member's.
            i = docAt(lines, i + 1).next - 1;
            continue;
        }

        const asDef = DEF.exec(line);
        const asAttr = asDef ? null : ATTR.exec(line);
        const match = asDef || asAttr;
        if (!match) {
            continue;
        }

        const indented = !!match[1];
        // A declaration back at column zero has left the class it was in.
        if (!indented) {
            current = '';
        }
        const target = indented && current ? api.members[current] : api.globals;
        if (!target) {
            continue;
        }

        const { doc, next } = docAt(lines, i + 1);
        i = next - 1;

        if (asDef) {
            // `self` is how the stub says "method"; it is never typed by the caller.
            const args = asDef[3]
                .split(',')
                .map(part => part.trim())
                .filter(part => part && part !== 'self')
                .join(', ');
            target.push({
                name: asDef[2],
                callable: true,
                detail: `(${args}) -> ${asDef[4].trim()}`,
                doc,
                type: classOf(asDef[4], classes),
            });
        } else if (asAttr) {
            target.push({
                name: asAttr[2],
                callable: false,
                detail: asAttr[3],
                doc,
                type: classOf(asAttr[3], classes),
            });
        }
    }

    return api;
}

/**
 * What `a.b.c` resolves to, as a stub class name.
 *
 * `start` is the type the chain begins in: a handler's parameter is an Event, and anything else
 * starts at module level, where `log` is a Log and the rest resolve to nothing.
 */
export function resolveChain(api: Api, parts: string[], start: string): string {
    let type = start;
    for (const part of parts) {
        const from = type ? api.members[type] : api.globals;
        const entry = from?.find(item => item.name === part);
        if (!entry) {
            return '';
        }
        type = entry.type;
    }
    return type;
}
