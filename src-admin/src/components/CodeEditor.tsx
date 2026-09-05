import { useEffect, useImperativeHandle, useRef, type JSX, type Ref } from 'react';
import { Box, useTheme } from '@mui/material';
import * as monaco from '../monaco';
import { registerPythonLanguage, setProblems, type Problem } from '../python-language';
import EditorWorker from 'monaco-editor/esm/vs/editor/editor.worker.js?worker';

/**
 * The script editor: Monaco, one model per open script.
 *
 * A model per script is what makes the tabs cheap. Undo history, cursor, selection, folding and
 * scroll position all live on the model and its view state, so switching tabs is a `setModel` call
 * and everything the user had is still there when they come back -- none of it has to be mirrored
 * into React state and restored by hand.
 *
 * Models outlive this component: they belong to the open tabs, not to whatever is on screen, and
 * are disposed by `forgetModel` when a tab is closed.
 */

// Monaco asks for a worker per language service. Python needs none -- its highlighting is a Monarch
// grammar that runs on the main thread -- but the editor core still wants its own worker for
// word-based suggestions and link detection, and without this it logs an error and does without.
self.MonacoEnvironment = { getWorker: () => new EditorWorker() };

// Completions are a property of the language, not of any one editor, so they are registered as
// soon as this module is loaded rather than per mounted editor.
registerPythonLanguage();

const MODELS = new Map<string, monaco.editor.ITextModel>();
const VIEW_STATES = new Map<string, monaco.editor.ICodeEditorViewState | null>();

function modelFor(id: string, source: string): monaco.editor.ITextModel {
    const existing = MODELS.get(id);
    if (existing && !existing.isDisposed()) {
        return existing;
    }
    // The uri only has to be unique and end in .py; nothing resolves it.
    const model = monaco.editor.createModel(source, 'python', monaco.Uri.parse(`inmemory://script/${id}.py`));

    MODELS.set(id, model);
    return model;
}

/**
 * Underline what the engine found wrong with a script.
 *
 * By id rather than through the mounted editor: the answer arrives from the adapter a moment after
 * the question, by which time the user may have switched tabs, and the markers belong to the model
 * either way -- they are there when the tab comes back.
 */
export function showProblems(id: string, problems: Problem[]): void {
    const model = MODELS.get(id);
    if (model && !model.isDisposed()) {
        setProblems(model, problems);
    }
}

/** Drop a closed tab's model, so its text and undo history do not outlive the tab. */
export function forgetModel(id: string): void {
    MODELS.get(id)?.dispose();
    MODELS.delete(id);
    VIEW_STATES.delete(id);
}

/** What the toolbar needs to reach into the editor for. */
export interface CodeEditorHandle {
    /** The selection as offsets into the text, or null when there is no editor. */
    selection: () => { start: number; end: number } | null;
    /** Replace a range, as an edit -- so it lands on the undo stack instead of resetting it. */
    replace: (start: number, end: number, text: string) => void;
    undo: () => void;
    redo: () => void;
    scrollTop: () => number;
    setScrollTop: (at: number) => void;
    focus: () => void;
}

interface CodeEditorProps {
    /** The script on screen. Changing it switches models, not contents. */
    id: string;
    value: string;
    onChange: (value: string) => void;
    onSave: () => void;
    /** Fires while the text scrolls, so the position can be remembered. */
    onScroll?: () => void;
    ref?: Ref<CodeEditorHandle>;
}

export function CodeEditor({ id, value, onChange, onSave, onScroll, ref }: CodeEditorProps): JSX.Element {
    const host = useRef<HTMLDivElement>(null);
    const editor = useRef<monaco.editor.IStandaloneCodeEditor | null>(null);
    const shown = useRef<string>('');
    /** Set while this component writes to the model, so its own edit is not reported as the user's. */
    const applying = useRef(false);

    // The callbacks are read through refs: they are rebuilt on every render, and re-subscribing
    // Monaco's listeners that often would throw away the editor's state with them.
    const handlers = useRef({ onChange, onSave, onScroll });
    handlers.current = { onChange, onSave, onScroll };

    const dark = useTheme().palette.mode === 'dark';

    useEffect(() => {
        if (!host.current) {
            return undefined;
        }
        // Created with its model rather than with `model: null` and a `setModel` afterwards: an
        // editor that starts without one paints its first lines before it has a tokenizer to ask,
        // and those lines keep the colourless tokens they were given until something else forces a
        // full re-render.
        const created = monaco.editor.create(host.current, {
            model: modelFor(id, value),
            language: 'python',
            theme: dark ? 'vs-dark' : 'vs',
            automaticLayout: true,
            fontSize: 13,
            fontFamily: 'ui-monospace, "Cascadia Code", Consolas, "Courier New", monospace',
            minimap: { enabled: false },
            scrollBeyondLastLine: false,
            renderWhitespace: 'selection',
            // Python is indentation, so make it visible and make a stray tab obvious.
            insertSpaces: true,
            tabSize: 4,
            renderLineHighlight: 'line',
            fixedOverflowWidgets: true,
        });
        editor.current = created;
        created.restoreViewState(VIEW_STATES.get(id) || null);
        shown.current = id;

        const changed = created.onDidChangeModelContent(() => {
            if (!applying.current) {
                handlers.current.onChange(created.getValue());
            }
        });
        const scrolled = created.onDidScrollChange(() => handlers.current.onScroll?.());

        // Ctrl/Cmd+S has to be taken from the browser, which would otherwise offer to save the page.
        created.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, () => handlers.current.onSave());

        return () => {
            changed.dispose();
            scrolled.dispose();
            // Keep the view state of whatever was on screen: the component is unmounted whenever the
            // log pane changes side, and the tab should not lose its place over a layout switch.
            if (shown.current) {
                VIEW_STATES.set(shown.current, created.saveViewState());
            }
            // The models belong to the tabs and are deliberately left alone.
            created.setModel(null);
            created.dispose();
            editor.current = null;
            // Without this a remount would find `shown` already naming the model it is about to
            // show, skip the switch below, and come up on the editor's own empty document.
            shown.current = '';
        };
    }, []);

    // Only on a *change*. The editor is created with the right theme already, and calling setTheme
    // again rebuilds the token colour map underneath lines that have just been painted -- they keep
    // the colourless tokens they were given and nothing marks them for repaint.
    const themeApplied = useRef('');
    useEffect(() => {
        const next = dark ? 'vs-dark' : 'vs';
        if (themeApplied.current && themeApplied.current !== next) {
            monaco.editor.setTheme(next);
        }
        themeApplied.current = next;
    }, [dark]);

    // Switch models when the tab changes, remembering where the outgoing one was.
    useEffect(() => {
        const current = editor.current;
        if (!current || !id) {
            return;
        }
        if (shown.current && shown.current !== id) {
            VIEW_STATES.set(shown.current, current.saveViewState());
        }
        if (shown.current !== id) {
            current.setModel(modelFor(id, value));
            current.restoreViewState(VIEW_STATES.get(id) || null);
            shown.current = id;
        }
    }, [id, value]);

    // Text changed from outside -- a reload from another admin session, or Cancel putting the stored
    // source back. Applied as an edit over the whole document so the change can be undone.
    useEffect(() => {
        const model = editor.current?.getModel();
        if (model && model.getValue() !== value) {
            applying.current = true;
            model.pushEditOperations([], [{ range: model.getFullModelRange(), text: value }], () => null);
            applying.current = false;
        }
    }, [value]);

    useImperativeHandle(
        ref,
        (): CodeEditorHandle => ({
            selection: () => {
                const current = editor.current;
                const model = current?.getModel();
                const range = current?.getSelection();
                if (!model || !range) {
                    return null;
                }
                return {
                    start: model.getOffsetAt(range.getStartPosition()),
                    end: model.getOffsetAt(range.getEndPosition()),
                };
            },
            replace: (start, end, text) => {
                const current = editor.current;
                const model = current?.getModel();
                if (!current || !model) {
                    return;
                }
                const range = monaco.Range.fromPositions(model.getPositionAt(start), model.getPositionAt(end));
                current.executeEdits('toolbar', [{ range, text, forceMoveMarkers: true }]);
                current.focus();
            },
            undo: () => editor.current?.trigger('toolbar', 'undo', null),
            redo: () => editor.current?.trigger('toolbar', 'redo', null),
            scrollTop: () => editor.current?.getScrollTop() || 0,
            setScrollTop: at => editor.current?.setScrollTop(at),
            focus: () => editor.current?.focus(),
        }),
        [],
    );

    return <Box ref={host} sx={{ flex: '1 1 auto', minHeight: 0, minWidth: 0 }} />;
}
