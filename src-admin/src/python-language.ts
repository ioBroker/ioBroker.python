/**
 * What Monaco knows about a logic script beyond its colours: completions, and where the problems
 * are.
 *
 * The completions come from the engine's own stub, so the editor offers exactly the API the engine
 * installs -- see `completions.ts`. The problems come from the engine itself, because the only
 * thing that can say whether a script compiles is the Python that will run it; this module just
 * puts the answer on the right lines.
 */
import * as monaco from './monaco';
import { parseStub, resolveChain, type Api, type Entry } from './completions';
import stub from '../../python/iobpython/scripting.pyi?raw';

const API: Api = parseStub(stub);

/** Owner of the markers this module sets, so it never clears anyone else's. */
const OWNER = 'python-engine';

/** One problem, as the engine reports it. */
export interface Problem {
    message: string;
    line: number;
    column: number;
    endLine: number;
    endColumn: number;
    code: string;
    severity: string;
}

/**
 * The type a chain like `event.state.` starts in.
 *
 * A handler's parameter is an Event. Which name that is varies -- `event`, `obj`, `e` -- so it is
 * read off the enclosing `def` rather than guessed, by walking back to the nearest one and taking
 * its first parameter. Anything else starts at module level, where `log` is the only name that
 * leads anywhere.
 */
function startType(model: monaco.editor.ITextModel, line: number, root: string): string {
    for (let at = line; at > 0; at--) {
        const text = model.getLineContent(at);
        const def = /^\s*(?:async\s+)?def\s+\w+\s*\(\s*([A-Za-z_]\w*)/.exec(text);
        if (def) {
            return def[1] === root ? 'Event' : '';
        }
    }
    return '';
}

function toCompletion(entry: Entry, range: monaco.IRange): monaco.languages.CompletionItem {
    return {
        label: entry.name,
        kind: entry.callable ? monaco.languages.CompletionItemKind.Function : monaco.languages.CompletionItemKind.Field,
        detail: entry.detail,
        documentation: entry.doc ? { value: entry.doc } : undefined,
        // A call gets its parentheses and the cursor between them; an attribute is just the name.
        insertText: entry.callable ? `${entry.name}($0)` : entry.name,
        insertTextRules: entry.callable ? monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet : undefined,
        range,
    };
}

let registered = false;

/** Register the completion provider once, whatever number of editors come and go. */
export function registerPythonLanguage(): void {
    if (registered) {
        return;
    }
    registered = true;

    monaco.languages.registerCompletionItemProvider('python', {
        triggerCharacters: ['.'],
        provideCompletionItems: (model, position) => {
            const upToCursor = model.getValueInRange({
                startLineNumber: position.lineNumber,
                startColumn: 1,
                endLineNumber: position.lineNumber,
                endColumn: position.column,
            });

            // Nothing is offered inside a comment or an unclosed string -- least of all while the
            // object id in `@on("...")` is being typed, which is most of what a script contains.
            const bare = upToCursor.replace(/\\./g, '');
            if (bare.includes('#') || (bare.match(/["']/g) || []).length % 2 === 1) {
                return { suggestions: [] };
            }

            // After a dot: complete the members of whatever the chain in front of it resolves to.
            const chain = /([A-Za-z_]\w*(?:\s*\.\s*[A-Za-z_]\w*)*)\s*\.\s*(\w*)$/.exec(upToCursor);
            if (chain) {
                const parts = chain[1].split('.').map(part => part.trim());
                // A chain rooted in the handler's parameter starts as an Event; anything else
                // starts at module level, where `log` is the only name that leads on.
                const handler = startType(model, position.lineNumber, parts[0]);
                const type = handler ? resolveChain(API, parts.slice(1), handler) : resolveChain(API, parts, '');
                const members = API.members[type];
                if (!members) {
                    return { suggestions: [] };
                }
                const written = chain[2];
                const range: monaco.IRange = {
                    startLineNumber: position.lineNumber,
                    startColumn: position.column - written.length,
                    endLineNumber: position.lineNumber,
                    endColumn: position.column,
                };
                return { suggestions: members.map(entry => toCompletion(entry, range)) };
            }

            // Otherwise the names a script starts with.
            const word = model.getWordUntilPosition(position);
            const range: monaco.IRange = {
                startLineNumber: position.lineNumber,
                startColumn: word.startColumn,
                endLineNumber: position.lineNumber,
                endColumn: word.endColumn,
            };
            return { suggestions: API.globals.map(entry => toCompletion(entry, range)) };
        },
    });
}

/** Underline what the engine found wrong with a script, or clear it when there is nothing. */
export function setProblems(model: monaco.editor.ITextModel, problems: Problem[]): void {
    monaco.editor.setModelMarkers(
        model,
        OWNER,
        problems.map(problem => ({
            message: problem.code ? `${problem.message} (${problem.code})` : problem.message,
            severity: problem.severity === 'error' ? monaco.MarkerSeverity.Error : monaco.MarkerSeverity.Warning,
            startLineNumber: problem.line,
            startColumn: problem.column,
            endLineNumber: problem.endLine,
            endColumn: problem.endColumn,
        })),
    );
}
