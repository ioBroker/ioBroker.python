import { createRef, type JSX } from 'react';
import ReactSplit, { GutterTheme, SplitDirection } from '@devbookhq/splitter';
import { StyledEngineProvider, ThemeProvider } from '@mui/material/styles';
import {
    Box,
    Button,
    CssBaseline,
    Dialog,
    DialogActions,
    DialogContent,
    DialogContentText,
    DialogTitle,
    IconButton,
    InputAdornment,
    MenuItem,
    Paper,
    TextField,
    Toolbar,
    Tooltip,
    Typography,
} from '@mui/material';
import {
    AutoFixHigh as IconFormat,
    Cancel as IconCancel,
    Check as IconCheck,
    Clear as IconClear,
    Close as IconClose,
    CreateNewFolder as IconAddFolder,
    DataObject as IconSelectId,
    GpsFixed as IconLocate,
    NoteAdd as IconAddScript,
    Pause as IconPause,
    PlayArrow as IconPlay,
    Redo as IconRedo,
    RestartAlt as IconRestart,
    Save as IconSave,
    Schedule as IconCron,
    HelpOutlined as IconHelp,
    Search as IconSearch,
    UnfoldLess as IconCollapse,
    UnfoldMore as IconExpand,
    Undo as IconUndo,
    Visibility as IconShowLog,
} from '@mui/icons-material';
import {
    AdminConnection,
    DialogCron,
    DialogSelectID,
    GenericApp,
    I18n,
    Loader,
    type GenericAppProps,
    type GenericAppState,
} from '@iobroker/gui-components';

import { CodeEditor, forgetModel, showProblems, type CodeEditorHandle } from './components/CodeEditor';
import { ScriptTabs } from './components/ScriptTabs';
import { DocDialog } from './components/DocDialog';
import { parseLog, type RawLog } from './log';
import type { Problem } from './python-language';
import { FOLLOW, LogPane } from './components/LogPane';
import { ScriptTree } from './components/ScriptTree';
import {
    allFolderIds,
    buildTree,
    ENGINE_TYPE,
    PREFIX,
    TEMPLATE,
    type FolderObject,
    type LogLine,
    type ScriptObject,
    type TreeNode,
} from './types';

import enLang from './i18n/en.json';
import deLang from './i18n/de.json';
import ruLang from './i18n/ru.json';

/** Remembered pane sizes; a corrupt or missing entry falls back to the default. */
function readSizes(key: string, fallback: [number, number]): [number, number] {
    try {
        const stored = window.localStorage.getItem(key);
        if (stored) {
            const parsed = JSON.parse(stored) as unknown;
            if (Array.isArray(parsed) && parsed.length === 2 && parsed.every(n => typeof n === 'number')) {
                return parsed as [number, number];
            }
        }
    } catch {
        // a broken entry must not keep the tab from opening
    }
    return fallback;
}

/** Where the tab was when it was last closed, so it can open there again. */
interface Session {
    /** The open tabs, in order. */
    tabs: string[];
    selected: string;
    expanded: string[];
    editorScroll: number;
    treeScroll: number;
}

/**
 * Keep the newest `limit` lines *per source* rather than per log.
 *
 * A single cap over everything makes the per-script view unreliable in exactly the case it is
 * wanted: one chatty script pushes a quiet one out entirely, so opening that quiet script shows an
 * empty pane although it did log. Counting per source costs one pass over a list that is already
 * bounded, and bounds memory at `limit` times the number of sources that have spoken.
 *
 * @param lines the whole buffer, oldest first
 * @param limit how many lines to keep for each script, and for the engine
 */
function trimPerSource(lines: LogLine[], limit: number): LogLine[] {
    const counts = new Map<string, number>();
    const kept: LogLine[] = [];

    for (let i = lines.length - 1; i >= 0; i--) {
        const source = lines[i].script ?? '';
        const seen = (counts.get(source) ?? 0) + 1;

        if (seen <= limit) {
            counts.set(source, seen);
            kept.push(lines[i]);
        }
    }

    return kept.reverse();
}

const SESSION_KEY = 'python.session';

/** Every instance's alive flag, as one subscription. */
const ALIVE_PATTERN = 'system.adapter.python.*.alive';

function readSession(): Partial<Session> {
    try {
        const stored = window.localStorage.getItem(SESSION_KEY);
        if (stored) {
            const parsed: unknown = JSON.parse(stored);
            if (parsed && typeof parsed === 'object') {
                return parsed as Partial<Session>;
            }
        }
    } catch {
        // a broken entry must not keep the tab from opening
    }
    return {};
}

/**
 * An ioBroker ID as it appears in the source: no whitespace or quotes, and at least one dot.
 *
 * The dot is what keeps `state`, `id` and other plain Python words from being offered to the
 * picker as if they were object IDs.
 */
const OBJECT_ID = /^[^\s"'`]+\.[^\s"'`]+$/;

/**
 * A cron expression: five or six space-separated fields of digits, `*`, ranges, steps and lists.
 *
 * The two patterns cannot collide -- an ID has no spaces, a cron has nothing else -- so each
 * toolbar button only ever finds the kind of value it writes.
 */
const CRON = /^[\d*/,\-?A-Za-z]+(?:\s+[\d*/,\-?A-Za-z]+){4,5}$/;

/** A place a dialog's answer goes, and whatever is already written there. */
interface Spot {
    /** The value found there, without its quotes; '' when there is nothing to correct. */
    text: string;
    start: number;
    end: number;
}

interface AppProps extends GenericAppProps {
    version: string;
}

interface AppState extends GenericAppState {
    scripts: Record<string, ScriptObject>;
    folders: Record<string, FolderObject>;
    /** Scripts open in the editor, in tab order. */
    tabs: string[];
    selected: string;
    /** The text being edited, per open tab -- so a tab keeps unsaved work while another is shown. */
    sources: Record<string, string>;
    running: string[];
    /** Every python instance on the box. Scripts are shown for all of them at once. */
    instances: string[];
    logs: LogLine[];
    maxLogLines: number;
    expanded: string[];
    filter: string;
    showFilter: boolean;
    /** Open dialog: the value it starts on and the range its answer replaces. */
    showSelectId: Spot | null;
    showCron: Spot | null;
    newScript: string | null;
    newFolder: string | null;
    confirmDelete: { id: string; isFolder: boolean } | null;
    /** Tab whose unsaved changes are about to be thrown away, waiting to be confirmed. */
    closingTab: string | null;
    /** Script being renamed or reassigned to another instance. */
    editScript: { id: string; name: string; instance: string } | null;
    /** Percentages, persisted so the layout survives a reload. */
    splitSizes: [number, number];
    logSizes: [number, number];
    /** Which instances are running: an unstarted one runs none of its scripts. */
    alive: Record<string, boolean>;
    /** Folder that new scripts and folders are created in; '' is the top level. */
    activeFolder: string;
    /** Folder currently hovered during a drag, for the drop highlight. */
    dragOver: string | null;
    /** Log pane: show only one script's lines; '' is all of them. */
    logFilter: string;
    /** Log pane: follow the newest line, sit beside the editor, or be out of the way. */
    autoScroll: boolean;
    logOnRight: boolean;
    hideLog: boolean;
    /** The help, and whether its contents list is open. */
    showDoc: boolean;
    docContents: boolean;
    /** Why the formatter refused, when it did. Never a silent no-op. */
    formatError: string | null;
    /** True while the engine is formatting, so the button cannot be pressed twice. */
    formatting: boolean;
}

export default class App extends GenericApp<AppProps, AppState> {
    private readonly editor = createRef<CodeEditorHandle>();
    private readonly treePane = createRef<HTMLDivElement>();
    private pollTimer: ReturnType<typeof setInterval> | null = null;
    private scrollTimer: ReturnType<typeof setTimeout> | null = null;
    private checkTimer: ReturnType<typeof setTimeout> | null = null;
    private logCounter = 0;

    /** Where the tab was left last time; read once, then kept in step with the UI. */
    private session: Partial<Session> = readSession();

    /** Last value handed to admin, so the global is only written when the answer changes. */
    private reportedUnsaved = false;

    constructor(props: AppProps) {
        super(props, {
            // @ts-expect-error the settings type wants the class, the value is the class
            Connection: AdminConnection,
            translations: { en: enLang, de: deLang, ru: ruLang },
            // A tab manages objects, it does not edit this instance's own configuration.
            bottomButtons: false,
            socket: { autoSubscribeLog: true },
        });

        this.state = {
            ...this.state,
            scripts: {},
            folders: {},
            tabs: [],
            selected: '',
            sources: {},
            running: [],
            instances: [],
            logs: [],
            maxLogLines: 300,
            expanded: [],
            filter: '',
            showFilter: false,
            showSelectId: null,
            showCron: null,
            newScript: null,
            newFolder: null,
            confirmDelete: null,
            closingTab: null,
            editScript: null,
            alive: {},
            activeFolder: '',
            dragOver: null,
            logFilter: window.localStorage.getItem('python.logFilter') ?? FOLLOW,
            autoScroll: window.localStorage.getItem('python.autoScroll') !== 'false',
            logOnRight: window.localStorage.getItem('python.logOnRight') === 'true',
            hideLog: window.localStorage.getItem('python.hideLog') === 'true',
            showDoc: false,
            formatError: null,
            formatting: false,
            docContents: window.localStorage.getItem('python.docContents') !== 'false',
            splitSizes: readSizes('python.splitSizes', [22, 78]),
            logSizes: readSizes('python.logSizes', [75, 25]),
        };
    }

    /**
     * Whether the editor differs from what is stored.
     *
     * Derived, never remembered: a flag set on the first keystroke stays set even after the text
     * is typed back to the original, so Save and Cancel would keep offering to save nothing.
     */
    private isChanged(id: string): boolean {
        const { scripts, sources } = this.state;
        return !!id && !!scripts[id] && sources[id] !== undefined && sources[id] !== (scripts[id].common.source || '');
    }

    private get changed(): boolean {
        return this.isChanged(this.state.selected);
    }

    /**
     * The instance that runs a script, e.g. `python.0`.
     *
     * It is a property of the script -- `common.engine` -- not of the tab. That is what lets one
     * editor manage every instance's scripts at once, the way ioBroker.javascript does, and it is
     * why there is no instance picker in the header any more: the answer is per script, and it is
     * changed on the script itself.
     */
    private engineOf(id: string): string {
        return (this.state.scripts[id]?.common.engine || '').replace('system.adapter.', '');
    }

    /** The instance a new script is created in: the first one, or none if there is none. */
    private get defaultInstance(): string {
        return this.state.instances[0] || '';
    }

    /** The text of the open script, or '' when there is none. */
    private get source(): string {
        return this.state.sources[this.state.selected] ?? '';
    }

    /** Flip a remembered layout switch: state and localStorage always move together. */
    private toggle(key: 'autoScroll' | 'logOnRight' | 'hideLog' | 'docContents'): void {
        const next = !this.state[key];
        window.localStorage.setItem(`python.${key}`, String(next));
        this.setState({ [key]: next } as unknown as Pick<AppState, typeof key>);
    }

    /** Merge one piece of the remembered session and write the lot back. */
    private saveSession(patch: Partial<Session>): void {
        this.session = { ...this.session, ...patch };
        try {
            window.localStorage.setItem(SESSION_KEY, JSON.stringify(this.session));
        } catch {
            // a full or blocked storage must not break editing
        }
    }

    /**
     * Remember where both panes are scrolled to.
     *
     * Scrolling fires per frame, so the write waits until the pane comes to rest -- and it reads
     * both panes at once, because either one may have moved.
     */
    private readonly rememberScroll = (): void => {
        if (this.scrollTimer) {
            clearTimeout(this.scrollTimer);
        }
        this.scrollTimer = setTimeout(() => {
            this.scrollTimer = null;
            this.saveSession({
                editorScroll: this.editor.current?.scrollTop() || 0,
                treeScroll: this.treePane.current?.scrollTop || 0,
            });
        }, 300);
    };

    /**
     * Put both panes back where they were.
     *
     * Two frames: the first lets React commit the restored script and the open folders, the second
     * runs once that content has a height -- setting scrollTop before it does silently clamps to 0.
     *
     * The positions come in as arguments, not off `this.session`: opening a script runs through
     * componentDidUpdate first, and that resets the remembered editor scroll to the top.
     */
    private restoreScroll(editorScroll: number, treeScroll: number): void {
        requestAnimationFrame(() =>
            requestAnimationFrame(() => {
                this.editor.current?.setScrollTop(editorScroll);
                if (this.treePane.current) {
                    this.treePane.current.scrollTop = treeScroll;
                }
            }),
        );
    }

    /** Whether any open tab holds work that is not stored. */
    private get anyUnsaved(): boolean {
        return this.state.tabs.some(id => this.isChanged(id));
    }

    /**
     * Tell admin that something is unsaved.
     *
     * Admin installs a setter on its own `configNotSaved` and, while it is true, refuses to
     * navigate to another of its tabs -- it puts up its own "data not stored" dialog instead.
     * Reaching up through `window.parent` is the whole contract: this tab is an iframe, the global
     * is the only channel admin offers, and it is exactly what ioBroker.javascript writes to.
     */
    private reportUnsaved(): void {
        const unsaved = this.anyUnsaved;
        if (unsaved === this.reportedUnsaved) {
            return;
        }
        this.reportedUnsaved = unsaved;
        try {
            (window.parent as unknown as { configNotSaved?: boolean }).configNotSaved = unsaved;
        } catch {
            // Opened on its own rather than inside admin: there is nobody to tell.
        }
    }

    /** The browser's own guard, for closing or reloading the page rather than changing tab. */
    private readonly onBrowserClose = (event: BeforeUnloadEvent): void => {
        if (this.anyUnsaved) {
            // Browsers show their own wording now; what still counts is that the event is cancelled.
            event.preventDefault();
            event.returnValue = I18n.t('Configuration not saved.');
        }
    };

    /**
     * Have the engine check the open script, once the typing stops.
     *
     * The check runs where the script will run: the same interpreter, the same `compile()` the
     * engine calls when it loads a script, and ruff from the same environment. Nothing in the
     * browser could give that answer, and an answer from a different Python would be worse than
     * none. The delay is what keeps it from being asked on every keystroke.
     */
    private scheduleCheck(): void {
        if (this.checkTimer) {
            clearTimeout(this.checkTimer);
        }
        const { selected } = this.state;
        if (!selected || !this.engineOf(selected)) {
            return;
        }
        const source = this.source;
        this.checkTimer = setTimeout(() => {
            this.checkTimer = null;
            void this.runCheck(selected, source);
        }, 600);
    }

    private async runCheck(id: string, source: string): Promise<void> {
        try {
            const result = await this.socket.sendTo<{ problems?: Problem[] }>(this.engineOf(id), 'checkScript', {
                source,
            });
            showProblems(id, Array.isArray(result?.problems) ? result.problems : []);
        } catch {
            // A stopped engine cannot check anything. Leaving the previous markers would be
            // claiming they are still true, so they go.
            showProblems(id, []);
        }
    }

    /**
     * Rewrite the open script the way ruff would write it.
     *
     * The same reasoning as the check: the formatter that matters is the one in the environment
     * the script runs in, so the engine does it and the browser only asks. What comes back is
     * applied as one edit over the whole document -- undoable with a single Ctrl+Z, and refused
     * outright if the engine reports a syntax error, because half-formatted code helps nobody.
     */
    private async formatScript(): Promise<void> {
        const { selected, formatting } = this.state;
        const engine = selected ? this.engineOf(selected) : '';
        if (!engine || formatting) {
            return;
        }

        this.setState({ formatting: true });
        try {
            const result = await this.socket.sendTo<{ source?: string; error?: string }>(engine, 'formatScript', {
                source: this.source,
            });
            if (result?.error) {
                this.setState({ formatError: result.error });
            } else if (typeof result?.source === 'string') {
                this.editor.current?.replaceAll(result.source);
            }
        } catch (error) {
            // A stopped engine never answers, and sendTo waits forever rather than rejecting; what
            // lands here is the connection saying no.
            this.setState({ formatError: error instanceof Error ? error.message : String(error) });
        } finally {
            this.setState({ formatting: false });
        }
    }

    componentDidMount(): void {
        super.componentDidMount();
        window.addEventListener('beforeunload', this.onBrowserClose);
    }

    componentDidUpdate(_prevProps: AppProps, prevState: AppState): void {
        // Admin has to hear about the first unsaved keystroke and about the last one being saved,
        // and both of those arrive here.
        this.reportUnsaved();

        // Every path that opens a script or folds a folder ends here, so this is the one place
        // that has to keep the stored session in step -- no call site can forget to.
        if (prevState.selected !== this.state.selected) {
            this.saveSession({ selected: this.state.selected, editorScroll: 0 });
        }
        if (prevState.expanded !== this.state.expanded) {
            this.saveSession({ expanded: this.state.expanded });
        }
        if (prevState.tabs !== this.state.tabs) {
            this.saveSession({ tabs: this.state.tabs });
        }
        // A new script on screen, or a changed one: ask again. Also on the first arrival of an
        // instance, which is when the engine becomes reachable at all.
        if (
            prevState.selected !== this.state.selected ||
            prevState.sources[this.state.selected] !== this.state.sources[this.state.selected] ||
            prevState.instances !== this.state.instances
        ) {
            this.scheduleCheck();
        }
    }

    onConnectionReady(): void {
        void this.init();
    }

    async componentWillUnmount(): Promise<void> {
        if (this.pollTimer) {
            clearInterval(this.pollTimer);
            this.pollTimer = null;
        }
        if (this.scrollTimer) {
            clearTimeout(this.scrollTimer);
            this.scrollTimer = null;
        }
        if (this.checkTimer) {
            clearTimeout(this.checkTimer);
            this.checkTimer = null;
        }
        window.removeEventListener('beforeunload', this.onBrowserClose);
        // Leaving the flag set would block admin's navigation for the rest of the session.
        try {
            (window.parent as unknown as { configNotSaved?: boolean }).configNotSaved = false;
        } catch {
            // not inside admin
        }
        await this.socket.requireLog(false);

        this.socket?.unregisterLogHandler(this.onLog);
        this.socket?.unsubscribeState(ALIVE_PATTERN, this.onAlive);
        super.componentWillUnmount?.();
    }

    // -- data ---------------------------------------------------------------

    private async init(): Promise<void> {
        const found = await this.socket.getAdapterInstances('python');
        const instances = found.map(obj => obj._id.replace('system.adapter.', ''));

        const { scripts, folders } = await this.load();
        await this.socket.subscribeObject(`${PREFIX}*`, this.onObjectChange);

        let maxLogLines = 300;
        if (instances.length) {
            const config = await this.socket.getObject(`system.adapter.${instances[0]}`);
            maxLogLines = Number(config?.native?.maxLogLines) || 300;
        }

        // Reopen where the tab was left. A script that has since been deleted, or a first visit,
        // falls back to nothing selected and every folder open.
        // Reopen every tab that still exists -- a script deleted meanwhile simply does not come
        // back, and a first visit opens nothing.
        const stored = Array.isArray(this.session.tabs) ? this.session.tabs : [];
        const tabs = stored.filter(id => scripts[id]);
        const selected = this.session.selected && scripts[this.session.selected] ? this.session.selected : '';
        if (selected && !tabs.includes(selected)) {
            tabs.push(selected);
        }
        const sources: Record<string, string> = {};
        tabs.forEach(id => (sources[id] = scripts[id].common.source || ''));
        const { editorScroll = 0, treeScroll = 0 } = this.session;

        this.setState(
            {
                scripts,
                folders,
                instances,
                maxLogLines,
                tabs,
                selected,
                sources,
                expanded: Array.isArray(this.session.expanded)
                    ? this.session.expanded
                    : allFolderIds(buildTree(scripts, folders, '')),
            },
            () => {
                void this.refreshRunning();
                this.restoreScroll(editorScroll, treeScroll);
            },
        );
        this.pollTimer = setInterval(() => void this.refreshRunning(), 5000);
        await this.watchInstances(instances);

        // Last, and in this order: the handler drops anything it cannot attribute to an instance,
        // so asking for the log before `instance` is in state would throw the first lines away.
        this.socket.registerLogHandler(this.onLog);
        await this.socket.requireLog(true);
    }

    /**
     * Follow every instance's `alive`, so the toolbar can tell "script stopped" from "engine
     * stopped" -- for whichever instance the open script belongs to.
     *
     * One pattern subscription rather than one per instance: instances can be added while the tab
     * is open, and a pattern covers those without anything having to notice.
     */
    private async watchInstances(instances: string[]): Promise<void> {
        const alive: Record<string, boolean> = {};
        await Promise.all(
            instances.map(async instance => {
                const state = await this.socket.getState(`system.adapter.${instance}.alive`);
                alive[instance] = !!state?.val;
            }),
        );
        this.setState({ alive });
        await this.socket.subscribeState(ALIVE_PATTERN, this.onAlive);
    }

    private readonly onAlive = (id: string, state: ioBroker.State | null | undefined): void => {
        const instance = id.replace(/^system\.adapter\./, '').replace(/\.alive$/, '');
        if (this.state.alive[instance] === !!state?.val) {
            return;
        }
        this.setState({ alive: { ...this.state.alive, [instance]: !!state?.val } });
    };

    private async load(): Promise<{
        scripts: Record<string, ScriptObject>;
        folders: Record<string, FolderObject>;
    }> {
        const [scriptObjects, channelObjects] = await Promise.all([
            this.socket.getObjectViewSystem('script', PREFIX, `${PREFIX}香`),
            this.socket.getObjectViewSystem('channel', PREFIX, `${PREFIX}香`),
        ]);

        const scripts: Record<string, ScriptObject> = {};
        Object.values(scriptObjects || {}).forEach(obj => {
            const script = obj as unknown as ScriptObject;
            if (script?.common?.engineType === ENGINE_TYPE) {
                scripts[script._id] = script;
            }
        });

        const folders: Record<string, FolderObject> = {};
        Object.values(channelObjects || {}).forEach(obj => {
            const folder = obj as unknown as FolderObject;
            folders[folder._id] = folder;
        });

        return { scripts, folders };
    }

    private readonly onObjectChange = (id: string, obj: ioBroker.Object | null | undefined): void => {
        const scripts = { ...this.state.scripts };
        const folders = { ...this.state.folders };

        if (!obj) {
            delete scripts[id];
            delete folders[id];
        } else if (obj.type === 'channel') {
            folders[id] = obj as FolderObject;
        } else if ((obj as unknown as ScriptObject).common?.engineType === ENGINE_TYPE) {
            scripts[id] = obj as unknown as ScriptObject;
        } else {
            delete scripts[id];
        }

        if (!this.state.tabs.includes(id)) {
            this.setState({ scripts, folders });
        } else if (!scripts[id]) {
            // Deleted elsewhere: the tab goes with it, unsaved or not -- there is nothing left to
            // save it back into.
            const tabs = this.state.tabs.filter(tab => tab !== id);
            const sources = { ...this.state.sources };
            delete sources[id];
            forgetModel(id);
            this.setState({
                scripts,
                folders,
                tabs,
                sources,
                selected: this.state.selected === id ? tabs[tabs.length - 1] || '' : this.state.selected,
            });
        } else if (!this.isChanged(id)) {
            // Follow an edit made elsewhere -- but never overwrite what is being typed here.
            this.setState({
                scripts,
                folders,
                sources: {
                    ...this.state.sources,
                    [id]: scripts[id].common.source || '',
                },
            });
        } else {
            this.setState({ scripts, folders });
        }
    };

    private readonly onLog = (message: RawLog): void => {
        // One socket message can carry several records: what the host forwards is a chunk of the
        // process's stdout, not a single line. See log.ts for why `from` cannot do the filtering.
        const parsed = parseLog(message, this.state.instances);
        if (!parsed.length) {
            return;
        }

        const logs = [...this.state.logs];

        for (const { continuation, ...entry } of parsed) {
            const previous = logs[logs.length - 1];

            // A headerless line joins the entry above it, keeping that entry's script and severity.
            // The host forwards the process's stdout line by line, so a traceback arrives as one
            // message per frame, each without the header that says which script raised it and at
            // what level. On its own every frame becomes an unattributed info line -- filtered
            // away the moment the pane shows one script, which is exactly when it is wanted.
            if (continuation && previous) {
                logs[logs.length - 1] = { ...previous, message: `${previous.message}
${entry.message}` };
            } else {
                logs.push({ id: ++this.logCounter, ...entry });
            }
        }

        this.setState({ logs: trimPerSource(logs, this.state.maxLogLines) });
    };

    private async refreshRunning(): Promise<void> {
        // Each instance is asked for its own scripts and the answers are pooled: which instance a
        // script runs in is already visible in the tree, what the dot says is whether it runs.
        const lists = await Promise.all(
            this.state.instances.map(async instance => {
                try {
                    const running = await this.socket.sendTo<string[]>(instance, 'listScripts', null);
                    return Array.isArray(running) ? running : [];
                } catch {
                    // That instance may simply be stopped; its dots go grey and that is the message.
                    return [];
                }
            }),
        );
        this.setState({ running: lists.flat() });
    }

    // -- editing ------------------------------------------------------------

    /**
     * Open a script, or bring its tab forward if it is already open.
     *
     * Nothing is asked here any more: an edited script keeps its changes in its own tab, so
     * switching away costs nothing. The question moved to `closeTab`, which is where work is
     * actually about to be lost.
     */
    private select(id: string): void {
        const { scripts, tabs, sources } = this.state;
        if (!scripts[id]) {
            return;
        }
        this.setState({
            tabs: tabs.includes(id) ? tabs : [...tabs, id],
            selected: id,
            sources: sources[id] === undefined ? { ...sources, [id]: scripts[id].common.source || '' } : sources,
            activeFolder: '',
        });
    }

    /**
     * Close a tab, asking first when it holds unsaved work.
     *
     * `force` is the answer coming back from that dialog.
     */
    private closeTab(id: string, force = false): void {
        if (!force && this.isChanged(id)) {
            this.setState({ closingTab: id });
            return;
        }
        const tabs = this.state.tabs.filter(tab => tab !== id);
        const sources = { ...this.state.sources };
        delete sources[id];
        forgetModel(id);

        // Show the neighbour the closed tab was covering, the way an editor does.
        let selected = this.state.selected;
        if (selected === id) {
            const at = this.state.tabs.indexOf(id);
            selected = tabs[Math.min(at, tabs.length - 1)] || '';
        }
        this.setState({ tabs, sources, selected, closingTab: null });
    }

    private edit(source: string): void {
        // Monaco owns the undo history now -- one model per tab, so it survives a tab switch.
        const { selected } = this.state;
        if (selected) {
            this.setState({ sources: { ...this.state.sources, [selected]: source } });
        }
    }

    private step(delta: number): void {
        if (delta < 0) {
            this.editor.current?.undo();
        } else {
            this.editor.current?.redo();
        }
    }

    private cancel(): void {
        const { selected, scripts } = this.state;
        this.setState({
            sources: {
                ...this.state.sources,
                [selected]: scripts[selected]?.common.source || '',
            },
        });
    }

    /** Expand every folder above the open script, so it is visible in the tree. */
    private locate(): void {
        const { selected } = this.state;
        if (!selected) {
            return;
        }
        const parts = selected.substring(PREFIX.length).split('.');
        parts.pop();
        const expanded = [...this.state.expanded];
        let id = '';
        parts.forEach(part => {
            id = id ? `${id}.${part}` : part;
            const full = PREFIX + id;
            if (!expanded.includes(full)) {
                expanded.push(full);
            }
        });
        this.setState({ expanded }, () =>
            // after the folders have opened, put the row where it can be seen
            requestAnimationFrame(() =>
                document.querySelector(`[data-row-id="${CSS.escape(selected)}"]`)?.scrollIntoView({ block: 'nearest' }),
            ),
        );
    }

    /** Hand the range to the editor, which applies it as an edit -- undoable like any other. */
    private replaceRange(start: number, end: number, text: string): void {
        this.editor.current?.replace(start, end, text);
    }

    /**
     * Where a toolbar dialog's answer goes, and the value already sitting there.
     *
     * A selection wins over the caret: picking a value with text selected overwrites it, the way
     * any editor behaves. With nothing selected we read the string literal around the caret, so
     * pressing a button inside `@on("system.adapter.admin.0.alive")` corrects that value instead of
     * dropping a second one beside it.
     *
     * `isMatch` decides what the button recognises as its own kind of value. When nothing matches,
     * `text` comes back empty and the range is whatever was selected -- the caller then writes its
     * full form there rather than correcting something that was never a cron or an ID.
     */
    private spotAtCursor(isMatch: (text: string) => boolean): Spot | null {
        const at = this.editor.current?.selection();
        if (!at) {
            return null;
        }
        const { source } = this;
        const { start, end } = at;

        if (start === end) {
            // Nothing selected -- look for a string literal on this line that spans the caret.
            const from = source.lastIndexOf('\n', start - 1) + 1;
            const lineEnd = source.indexOf('\n', start);
            const line = source.slice(from, lineEnd === -1 ? source.length : lineEnd);
            const strings = /"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'/g;
            let match: RegExpExecArray | null;
            while ((match = strings.exec(line)) !== null) {
                const at = from + match.index;
                if (at <= start && start <= at + match[0].length) {
                    const text = match[0].slice(1, -1);
                    if (isMatch(text)) {
                        return { text, start: at, end: at + match[0].length };
                    }
                    break;
                }
            }
            return { text: '', start, end };
        }

        // A selection: read it as a quoted value, growing over the quotes on either side and
        // stripping any it caught itself, so the answer replaces one pair instead of nesting a
        // second one inside it. The wider range only counts if what it holds actually matches --
        // otherwise exactly what the user selected is what gets overwritten.
        let from = start;
        let to = end;
        while (from > 0 && (source[from - 1] === '"' || source[from - 1] === "'")) {
            from--;
        }
        while (to < source.length && (source[to] === '"' || source[to] === "'")) {
            to++;
        }
        const text = source
            .slice(from, to)
            .replace(/^["']+/, '')
            .replace(/["']+$/, '');
        return isMatch(text) ? { text, start: from, end: to } : { text: '', start, end };
    }

    // -- object actions ------------------------------------------------------

    private async save(): Promise<void> {
        const { selected, scripts } = this.state;
        const source = this.source;
        if (!selected) {
            return;
        }
        const obj = JSON.parse(JSON.stringify(scripts[selected])) as ScriptObject;
        obj.common.source = source;
        try {
            await this.socket.setObject(selected, obj as unknown as ioBroker.SettableObject);
            // Reflect the new source locally straight away: `changed` compares against it, and
            // waiting for the subscription to echo the write back would leave Save and Cancel on
            // screen for a moment after a successful save.
            this.setState({ scripts: { ...this.state.scripts, [selected]: obj } });
        } catch (error) {
            this.showError(I18n.t('Could not save: %s', (error as Error).message));
        }
    }

    private async setEnabled(id: string, enabled: boolean): Promise<void> {
        const obj = JSON.parse(JSON.stringify(this.state.scripts[id])) as ScriptObject;
        obj.common.enabled = enabled;
        try {
            await this.socket.setObject(id, obj as unknown as ioBroker.SettableObject);
        } catch (error) {
            this.showError(I18n.t('Could not save: %s', (error as Error).message));
        }
    }

    private async restart(): Promise<void> {
        const { selected } = this.state;
        const instance = this.engineOf(selected);
        if (!instance || !selected) {
            return;
        }
        await this.socket.sendTo(instance, 'reloadScript', { id: selected });
        await this.refreshRunning();
    }

    private cleanName(raw: string): string {
        return raw.replace(/[^A-Za-z0-9_.\-]/g, '_').replace(/^\.+|\.+$/g, '');
    }

    /**
     * Validate a name while it is being typed.
     *
     * Both namespaces are checked, not just the one being created: a script and a folder are both
     * objects and cannot share an id, so a script named like an existing folder would collide.
     * Returns the id the item would get, so the dialog can show where it actually lands -- which
     * also makes the sanitising visible instead of surprising.
     */
    private checkName(raw: string): { id: string; problem: string | null } {
        const name = this.cleanName(raw);
        if (!raw.trim()) {
            return { id: '', problem: null }; // nothing typed yet: not an error, just not ready
        }
        if (!name) {
            return { id: '', problem: I18n.t('That name has no usable characters.') };
        }

        const folder = this.currentFolder();
        const id = PREFIX + (folder ? `${folder}.${name}` : name);

        if (this.state.scripts[id]) {
            return { id, problem: I18n.t('A script with that name already exists.') };
        }
        if (this.state.folders[id]) {
            return { id, problem: I18n.t('A folder with that name already exists.') };
        }
        return { id, problem: null };
    }

    /**
     * Where a new script or folder lands.
     *
     * A picked folder wins -- that is the only way to reach an *empty* one, since it holds no
     * script to select. Otherwise it follows the open script, so "New" lands next to what you are
     * looking at. A dotted name still works and creates the folders it names.
     */
    private currentFolder(): string {
        if (this.state.activeFolder) {
            return this.state.activeFolder.substring(PREFIX.length);
        }
        const { selected } = this.state;
        if (!selected) {
            return '';
        }
        const parts = selected.substring(PREFIX.length).split('.');
        parts.pop();
        return parts.join('.');
    }

    private async createScript(rawName: string): Promise<void> {
        const name = this.cleanName(rawName);
        if (!name) {
            return this.showError(I18n.t('That name has no usable characters.'));
        }
        if (!this.defaultInstance) {
            return this.showError(I18n.t('There is no python instance to assign the script to.'));
        }

        const folder = this.currentFolder();
        const id = PREFIX + (folder ? `${folder}.${name}` : name);
        if (this.state.scripts[id]) {
            return this.showError(I18n.t('A script with that name already exists.'));
        }

        const obj = {
            _id: id,
            type: 'script' as const,
            common: {
                name: name.split('.').pop() as string,
                engineType: ENGINE_TYPE,
                engine: `system.adapter.${this.defaultInstance}`,
                source: TEMPLATE,
                enabled: false,
                debug: false,
                verbose: false,
            },
            native: {},
        };
        try {
            await this.socket.setObject(id, obj as unknown as ioBroker.SettableObject);
            this.setState({
                tabs: this.state.tabs.includes(id) ? this.state.tabs : [...this.state.tabs, id],
                selected: id,
                sources: { ...this.state.sources, [id]: TEMPLATE },
            });
        } catch (error) {
            this.showError(I18n.t('Could not create the script: %s', (error as Error).message));
        }
    }

    private async createFolder(rawName: string): Promise<void> {
        const name = this.cleanName(rawName);
        if (!name) {
            return this.showError(I18n.t('That name has no usable characters.'));
        }
        const parent = this.currentFolder();
        const id = PREFIX + (parent ? `${parent}.${name}` : name);
        if (this.state.folders[id]) {
            return this.showError(I18n.t('A folder with that name already exists.'));
        }

        const obj = {
            _id: id,
            type: 'channel' as const,
            common: { name: name.split('.').pop() as string },
            native: {},
        };
        try {
            await this.socket.setObject(id, obj as unknown as ioBroker.SettableObject);
            this.setState({ expanded: [...this.state.expanded, id] });
        } catch (error) {
            this.showError(I18n.t('Could not create the folder: %s', (error as Error).message));
        }
    }

    /**
     * Move a script into another folder, or to the top level when `targetFolder` is ''.
     *
     * ioBroker has no rename: the object is written under the new id and the old one deleted. The
     * new one is created first on purpose -- if the delete then failed the script would exist
     * twice, which a user can fix, while the other order could lose it outright.
     */
    private async writeAs(scriptId: string, newId: string, change: (obj: ScriptObject) => void): Promise<void> {
        const obj = this.state.scripts[scriptId];
        if (!obj) {
            return;
        }
        const next = JSON.parse(JSON.stringify(obj)) as ScriptObject;
        next._id = newId;
        change(next);

        if (newId === scriptId) {
            await this.socket.setObject(newId, next as unknown as ioBroker.SettableObject);
            return;
        }
        if (this.state.scripts[newId] || this.state.folders[newId]) {
            throw new Error(I18n.t('%s already exists there', newId.substring(PREFIX.length)));
        }
        await this.socket.setObject(newId, next as unknown as ioBroker.SettableObject);
        this.followRename(scriptId, newId);
        await this.socket.delObject(scriptId);
    }

    /**
     * Carry an open tab over to the script's new id.
     *
     * Done before the old object is deleted, so the delete's echo does not arrive looking like
     * "the script being edited disappeared" and close the tab with the user's work in it.
     */
    private followRename(oldId: string, newId: string): void {
        const { tabs, sources, selected } = this.state;
        if (!tabs.includes(oldId)) {
            return;
        }
        const next = { ...sources };
        next[newId] = next[oldId];
        delete next[oldId];
        forgetModel(oldId);
        this.setState({
            tabs: tabs.map(id => (id === oldId ? newId : id)),
            sources: next,
            selected: selected === oldId ? newId : selected,
        });
    }

    private async moveScript(scriptId: string, targetFolder: string): Promise<void> {
        const name = scriptId.substring(PREFIX.length).split('.').pop() as string;
        const folder = targetFolder ? targetFolder.substring(PREFIX.length) : '';
        const newId = PREFIX + (folder ? `${folder}.${name}` : name);

        if (newId === scriptId) {
            return; // dropped where it already was
        }
        try {
            await this.writeAs(scriptId, newId, () => undefined);
        } catch (error) {
            this.showError(I18n.t('Could not move: %s', (error as Error).message));
        }
    }

    /** Apply the pencil dialog: a new name, a different instance, or both. */
    private async applyScriptEdit(): Promise<void> {
        const edit = this.state.editScript;
        if (!edit) {
            return;
        }
        const parts = edit.id.substring(PREFIX.length).split('.');
        parts.pop();
        const newId = PREFIX + [...parts, this.cleanName(edit.name)].join('.');
        try {
            await this.writeAs(edit.id, newId, obj => {
                obj.common.engine = `system.adapter.${edit.instance}`;
            });
            this.setState({ editScript: null });
        } catch (error) {
            this.showError(I18n.t('Could not rename: %s', (error as Error).message));
        }
    }

    private async remove(): Promise<void> {
        const target = this.state.confirmDelete;
        if (!target) {
            return;
        }
        try {
            await this.socket.delObject(target.id);
            // The object subscription closes the tab; this only dismisses the dialog.
            this.setState({ confirmDelete: null });
        } catch (error) {
            this.setState({ confirmDelete: null });
            this.showError(I18n.t('Could not delete: %s', (error as Error).message));
        }
    }

    // -- render -------------------------------------------------------------

    private renderNameDialog(
        which: 'newScript' | 'newFolder',
        title: string,
        submit: (name: string) => Promise<void>,
    ): JSX.Element | null {
        const value = this.state[which];
        if (value === null) {
            return null;
        }
        const close = (): void => this.setState({ [which]: null } as unknown as Pick<AppState, typeof which>);
        const { id, problem } = this.checkName(value);
        const accept = (): void => {
            if (problem || !id) {
                return;
            }
            close();
            void submit(value);
        };

        return (
            // disableRestoreFocus: on close MUI hands focus back to the toolbar button that opened
            // the dialog. Enter is handled while the key is still down, so the very next auto-repeat
            // landed on that button and opened the dialog again. Focus must not go back there.
            <Dialog open maxWidth="xs" fullWidth onClose={close} disableRestoreFocus>
                <DialogTitle>{title}</DialogTitle>
                {/* A real form rather than an onKeyDown handler: Enter then triggers exactly one
                    submit, and preventDefault stops the browser acting on the keystroke again. */}
                <form
                    onSubmit={event => {
                        event.preventDefault();
                        accept(); // guards on the same validation the button is disabled by
                    }}
                >
                    <DialogContent>
                        <TextField
                            autoFocus
                            fullWidth
                            variant="standard"
                            label={I18n.t('Name')}
                            error={!!problem}
                            // While it is valid, show the id it will get: that makes both the
                            // target folder and the sanitising of odd characters visible before
                            // anything is created.
                            helperText={problem || (id ? id : I18n.t('Dots create folders'))}
                            slotProps={{
                                formHelperText: {
                                    sx: { fontFamily: problem ? undefined : 'monospace' },
                                },
                            }}
                            value={value}
                            onChange={event =>
                                this.setState({
                                    [which]: event.target.value,
                                } as unknown as Pick<AppState, typeof which>)
                            }
                        />
                    </DialogContent>
                    {/* ioBroker order: the action first, Cancel always rightmost -- the same as
                        gui-components' own DialogConfirm. */}
                    <DialogActions>
                        <Button
                            type="submit"
                            variant="contained"
                            color="primary"
                            startIcon={<IconCheck />}
                            disabled={!id || !!problem}
                        >
                            {I18n.t('Create')}
                        </Button>
                        <Button
                            type="button"
                            variant="contained"
                            color="grey"
                            startIcon={<IconClose />}
                            onClick={close}
                        >
                            {I18n.t('Cancel')}
                        </Button>
                    </DialogActions>
                </form>
            </Dialog>
        );
    }

    private renderDialogs(): JSX.Element {
        const { showSelectId, showCron, confirmDelete } = this.state;

        return (
            <>
                {showSelectId ? (
                    <DialogSelectID
                        socket={this.socket}
                        theme={this.state.theme}
                        types={['state']}
                        // Icons are served from admin's root, but this tab lives under
                        // /adapter/python/ -- without the prefix every adapter icon in the picker
                        // resolves against the tab's own path and renders as a broken image.
                        imagePrefix="../.."
                        dialogName="pythonScriptState"
                        title={I18n.t('Pick a state')}
                        // Whatever ID the caret was on, so the picker opens on it instead of at
                        // the root -- and its answer then replaces that ID rather than doubling it.
                        selected={showSelectId.text || undefined}
                        // system.* is hidden outside expert mode, so an ID from there would open
                        // the picker on a branch it otherwise refuses to show.
                        expertMode={showSelectId.text.startsWith('system.') || undefined}
                        onClose={() => this.setState({ showSelectId: null })}
                        onOk={id => {
                            this.setState({ showSelectId: null });
                            const picked = Array.isArray(id) ? id[0] : id;
                            if (picked) {
                                this.replaceRange(showSelectId.start, showSelectId.end, `"${picked}"`);
                            }
                        }}
                    />
                ) : null}

                {showCron ? (
                    <DialogCron
                        theme={this.state.theme}
                        // Open on the expression the caret was in, so an existing schedule can be
                        // adjusted in the wizard instead of retyped from scratch.
                        cron={showCron.text || '0 22 * * *'}
                        title={I18n.t('Schedule')}
                        onClose={() => this.setState({ showCron: null })}
                        onOk={cron => {
                            this.setState({ showCron: null });
                            // Five fields only: the engine's parser is a plain cron, no seconds.
                            const fields = (cron || '').trim().split(/\s+/);
                            const value = fields.slice(-5).join(' ');
                            // An expression that was already there is corrected inside its own
                            // quotes; a fresh one needs the decorator written around it.
                            this.replaceRange(
                                showCron.start,
                                showCron.end,
                                showCron.text ? `"${value}"` : `@schedule("${value}")\n`,
                            );
                        }}
                    />
                ) : null}

                {this.state.showDoc ? (
                    <DocDialog
                        showContents={this.state.docContents}
                        onToggleContents={() => this.toggle('docContents')}
                        onClose={() => this.setState({ showDoc: false })}
                    />
                ) : null}

                {/* The formatter's refusals, in a dialog of this app: ruff's own wording says
                    where the script stops parsing, and that is worth reading rather than
                    flashing past in a toast. */}
                {this.state.formatError ? (
                    <Dialog
                        open
                        maxWidth="sm"
                        fullWidth
                        disableRestoreFocus
                        onClose={() => this.setState({ formatError: null })}
                    >
                        <DialogTitle>{I18n.t('Cannot format the script')}</DialogTitle>
                        <DialogContent>
                            <DialogContentText sx={{ fontFamily: 'monospace', whiteSpace: 'pre-wrap' }}>
                                {this.state.formatError}
                            </DialogContentText>
                        </DialogContent>
                        <DialogActions>
                            <Button
                                variant="contained"
                                color="grey"
                                startIcon={<IconClose />}
                                autoFocus
                                onClick={() => this.setState({ formatError: null })}
                            >
                                {I18n.t('Close')}
                            </Button>
                        </DialogActions>
                    </Dialog>
                ) : null}

                {this.renderNameDialog('newScript', I18n.t('New script'), name => this.createScript(name))}
                {this.renderNameDialog('newFolder', I18n.t('New folder'), name => this.createFolder(name))}

                {confirmDelete ? (
                    <Dialog
                        open
                        maxWidth="xs"
                        disableRestoreFocus
                        onClose={() => this.setState({ confirmDelete: null })}
                    >
                        <DialogTitle>
                            {confirmDelete.isFolder ? I18n.t('Delete folder') : I18n.t('Delete script')}
                        </DialogTitle>
                        <DialogContent>
                            <DialogContentText>{I18n.t('Delete %s?', confirmDelete.id)}</DialogContentText>
                        </DialogContent>
                        <DialogActions>
                            <Button
                                color="error"
                                variant="contained"
                                startIcon={<IconCheck />}
                                onClick={() => void this.remove()}
                            >
                                {I18n.t('Delete')}
                            </Button>
                            <Button
                                variant="contained"
                                color="grey"
                                startIcon={<IconClose />}
                                autoFocus
                                onClick={() => this.setState({ confirmDelete: null })}
                            >
                                {I18n.t('Cancel')}
                            </Button>
                        </DialogActions>
                    </Dialog>
                ) : null}

                {/* Closing a tab is the only place unsaved work can still be lost, so it is the
                    only place that asks -- and it asks in a dialog of this app, not the browser's
                    own, which cannot be styled, cannot be themed and blocks the whole page. */}
                {/* The pencil's dialog. Name and instance together, because both are things about
                    the script rather than in it, and both are changed the same way: ioBroker has
                    no rename, so the object is rewritten under its new id either way. */}
                {this.state.editScript ? (
                    <Dialog open maxWidth="xs" fullWidth onClose={() => this.setState({ editScript: null })}>
                        {/* A form, so Enter in the name field applies -- the same shape the new
                            script/folder dialog uses, and the same guard: submitting is refused on
                            exactly what disables the button. */}
                        <Box
                            component="form"
                            onSubmit={event => {
                                event.preventDefault();
                                if (this.cleanName(this.state.editScript?.name || '')) {
                                    void this.applyScriptEdit();
                                }
                            }}
                        >
                            <DialogTitle>{I18n.t('Script settings')}</DialogTitle>
                            <DialogContent>
                                <TextField
                                    autoFocus
                                    fullWidth
                                    variant="standard"
                                    margin="dense"
                                    label={I18n.t('Name')}
                                    value={this.state.editScript.name}
                                    onChange={event =>
                                        this.setState({
                                            editScript: {
                                                ...this.state.editScript!,
                                                name: event.target.value,
                                            },
                                        })
                                    }
                                />
                                <TextField
                                    select
                                    fullWidth
                                    variant="standard"
                                    margin="dense"
                                    label={I18n.t('Instance')}
                                    helperText={I18n.t('Which engine runs this script')}
                                    value={this.state.editScript.instance}
                                    onChange={event =>
                                        this.setState({
                                            editScript: {
                                                ...this.state.editScript!,
                                                instance: event.target.value,
                                            },
                                        })
                                    }
                                >
                                    {this.state.instances.map(id => (
                                        <MenuItem key={id} value={id}>
                                            {id}
                                        </MenuItem>
                                    ))}
                                </TextField>
                            </DialogContent>
                            <DialogActions>
                                <Button
                                    type="submit"
                                    variant="contained"
                                    color="primary"
                                    startIcon={<IconCheck />}
                                    disabled={!this.cleanName(this.state.editScript.name)}
                                >
                                    {I18n.t('Apply')}
                                </Button>
                                <Button
                                    type="button"
                                    variant="contained"
                                    color="grey"
                                    startIcon={<IconClose />}
                                    onClick={() => this.setState({ editScript: null })}
                                >
                                    {I18n.t('Cancel')}
                                </Button>
                            </DialogActions>
                        </Box>
                    </Dialog>
                ) : null}

                {this.state.closingTab ? (
                    <Dialog open maxWidth="xs" disableRestoreFocus onClose={() => this.setState({ closingTab: null })}>
                        <DialogTitle>{I18n.t('Discard the unsaved changes?')}</DialogTitle>
                        <DialogContent>
                            <DialogContentText>
                                {I18n.t(
                                    '%s has changes that were never saved. Closing the tab throws them away.',
                                    this.state.closingTab.substring(PREFIX.length),
                                )}
                            </DialogContentText>
                        </DialogContent>
                        <DialogActions>
                            <Button
                                color="error"
                                variant="contained"
                                startIcon={<IconCheck />}
                                onClick={() => this.closeTab(this.state.closingTab as string, true)}
                            >
                                {I18n.t('Discard')}
                            </Button>
                            <Button
                                variant="contained"
                                color="grey"
                                startIcon={<IconClose />}
                                autoFocus
                                onClick={() => this.setState({ closingTab: null })}
                            >
                                {I18n.t('Cancel')}
                            </Button>
                        </DialogActions>
                    </Dialog>
                ) : null}
            </>
        );
    }

    private renderSidebar(tree: TreeNode[]): JSX.Element {
        const { expanded, filter, showFilter, scripts, running, selected } = this.state;

        return (
            <Paper
                square
                elevation={0}
                sx={{
                    // The splitter owns the width now; fill whatever pane it gives us.
                    width: '100%',
                    height: '100%',
                    display: 'flex',
                    flexDirection: 'column',
                    minHeight: 0,
                }}
            >
                <Toolbar variant="dense" sx={{ gap: 0.5, minHeight: 42, px: 1 }}>
                    <Tooltip title={I18n.t('New script')}>
                        <IconButton size="small" onClick={() => this.setState({ newScript: 'my_script' })}>
                            <IconAddScript fontSize="small" />
                        </IconButton>
                    </Tooltip>
                    <Tooltip title={I18n.t('New folder')}>
                        <IconButton size="small" onClick={() => this.setState({ newFolder: 'folder' })}>
                            <IconAddFolder fontSize="small" />
                        </IconButton>
                    </Tooltip>
                    <Tooltip title={I18n.t('Expand all')}>
                        <IconButton size="small" onClick={() => this.setState({ expanded: allFolderIds(tree) })}>
                            <IconExpand fontSize="small" />
                        </IconButton>
                    </Tooltip>
                    <Tooltip title={I18n.t('Collapse all')}>
                        <IconButton size="small" onClick={() => this.setState({ expanded: [] })}>
                            <IconCollapse fontSize="small" />
                        </IconButton>
                    </Tooltip>
                    <Box sx={{ flex: 1 }} />
                    <Tooltip title={I18n.t('Search')}>
                        <IconButton
                            size="small"
                            color={showFilter ? 'primary' : 'default'}
                            onClick={() => this.setState({ showFilter: !showFilter, filter: '' })}
                        >
                            <IconSearch fontSize="small" />
                        </IconButton>
                    </Tooltip>
                </Toolbar>

                {showFilter ? (
                    <Box sx={{ px: 1, pb: 1 }}>
                        <TextField
                            autoFocus
                            fullWidth
                            size="small"
                            variant="standard"
                            placeholder={I18n.t('Search')}
                            value={filter}
                            onChange={event => this.setState({ filter: event.target.value })}
                            slotProps={{
                                input: {
                                    endAdornment: filter ? (
                                        <InputAdornment position="end">
                                            <IconButton size="small" onClick={() => this.setState({ filter: '' })}>
                                                <IconClear fontSize="small" />
                                            </IconButton>
                                        </InputAdornment>
                                    ) : null,
                                },
                            }}
                        />
                    </Box>
                ) : null}

                {/* Dropping anywhere that is not a folder row means the top level -- that is how
                    a script gets back out of a folder. */}
                <Box
                    ref={this.treePane}
                    sx={{ flex: 1, overflowY: 'auto', minHeight: 0 }}
                    onScroll={this.rememberScroll}
                    onDragOver={event => {
                        event.preventDefault();
                        event.dataTransfer.dropEffect = 'move';
                    }}
                    onDrop={event => {
                        event.preventDefault();
                        this.setState({ dragOver: null });
                        const dragged = event.dataTransfer.getData('text/plain');
                        if (dragged) {
                            void this.moveScript(dragged, '');
                        }
                    }}
                >
                    <ScriptTree
                        nodes={tree}
                        running={running}
                        selected={selected}
                        expanded={expanded}
                        onToggleFolder={id =>
                            this.setState({
                                expanded: expanded.includes(id)
                                    ? expanded.filter(item => item !== id)
                                    : [...expanded, id],
                            })
                        }
                        activeFolder={this.state.activeFolder}
                        onPickFolder={id => this.setState({ activeFolder: id })}
                        onNewInFolder={id => this.setState({ activeFolder: id, newScript: 'my_script' })}
                        dragOver={this.state.dragOver}
                        onDragOverFolder={id => this.setState({ dragOver: id })}
                        onMove={(scriptId, target) => void this.moveScript(scriptId, target)}
                        onSelect={id => this.select(id)}
                        onEdit={id =>
                            this.setState({
                                editScript: {
                                    id,
                                    name: id.split('.').pop() as string,
                                    instance: this.engineOf(id) || this.defaultInstance,
                                },
                            })
                        }
                        onToggleEnabled={(id, enabled) => void this.setEnabled(id, enabled)}
                        onDelete={(id, isFolder) => this.setState({ confirmDelete: { id, isFolder } })}
                        canDeleteFolder={node =>
                            node.kind === 'folder' &&
                            node.total === 0 &&
                            !Object.keys(scripts).some(id => id.startsWith(`${node.id}.`))
                        }
                    />
                </Box>
            </Paper>
        );
    }

    private renderEditor(): JSX.Element {
        const { selected, scripts, running } = this.state;
        // Whether *this script's* engine is up, not "the" engine: two scripts side by side in the
        // tree can belong to instances in different states.
        const instanceAlive = !!this.state.alive[this.engineOf(selected)];
        const source = this.source;
        const changed = this.changed;
        const enabled = !!scripts[selected]?.common.enabled;
        const isRunning = running.includes(selected);

        const tabs = (
            <ScriptTabs
                tabs={this.state.tabs}
                selected={selected}
                isChanged={id => this.isChanged(id)}
                onSelect={id => this.select(id)}
                onClose={id => this.closeTab(id)}
            />
        );

        if (!selected || !scripts[selected]) {
            return (
                <>
                    {tabs}
                    <Box
                        sx={{
                            flex: 1,
                            display: 'flex',
                            alignItems: 'center',
                            justifyContent: 'center',
                            color: 'text.secondary',
                            p: 3,
                            textAlign: 'center',
                        }}
                    >
                        <Typography>{I18n.t('Select a script on the left, or create one.')}</Typography>
                    </Box>
                </>
            );
        }

        return (
            <>
                {tabs}
                <Toolbar
                    variant="dense"
                    sx={{
                        gap: 0.5,
                        borderBottom: 1,
                        borderColor: 'divider',
                        flexWrap: 'wrap',
                    }}
                >
                    <Tooltip title={I18n.t('Locate script in the list')}>
                        <IconButton size="small" onClick={() => this.locate()}>
                            <IconLocate fontSize="small" />
                        </IconButton>
                    </Tooltip>

                    {/* The run controls are the mirror of Save/Cancel and appear only when there is
                        nothing to save -- the same rule ioBroker.javascript follows: you are either
                        editing or steering, never both. Restarting a script whose source differs
                        from what is stored would run the old one and look like a bug. */}
                    {!changed ? (
                        <>
                            {instanceAlive ? (
                                <Tooltip title={I18n.t('Restart script')}>
                                    <IconButton size="small" onClick={() => void this.restart()}>
                                        <IconRestart fontSize="small" />
                                    </IconButton>
                                </Tooltip>
                            ) : null}

                            <Tooltip title={enabled ? I18n.t('Pause script') : I18n.t('Run script')}>
                                <IconButton size="small" onClick={() => void this.setEnabled(selected, !enabled)}>
                                    {enabled ? (
                                        <IconPause
                                            fontSize="small"
                                            sx={{
                                                color: isRunning ? 'success.main' : 'warning.main',
                                            }}
                                        />
                                    ) : (
                                        <IconPlay fontSize="small" sx={{ color: 'error.main' }} />
                                    )}
                                </IconButton>
                            </Tooltip>

                            {/* Say which of the three reasons it is, instead of leaving a grey dot
                                to be interpreted. */}
                            {!enabled ? (
                                <Typography variant="caption" color="text.secondary">
                                    {I18n.t('Script is not running')}
                                </Typography>
                            ) : !instanceAlive ? (
                                <Typography variant="caption" color="warning.main">
                                    {I18n.t('Instance is disabled')}
                                </Typography>
                            ) : !isRunning ? (
                                <Typography variant="caption" color="warning.main">
                                    {I18n.t('Enabled, but the engine did not start it -- check the log')}
                                </Typography>
                            ) : null}
                        </>
                    ) : null}

                    {/* Only while there is something to save -- an always-present pair of dead
                        buttons is noise, and their appearing is itself the "unsaved" signal. */}
                    {changed ? (
                        <>
                            <Button
                                size="small"
                                variant="contained"
                                color="warning"
                                startIcon={<IconSave />}
                                onClick={() => void this.save()}
                            >
                                {I18n.t('Save')}
                            </Button>
                            <Button
                                size="small"
                                variant="outlined"
                                startIcon={<IconCancel />}
                                onClick={() => this.cancel()}
                            >
                                {I18n.t('Cancel')}
                            </Button>
                        </>
                    ) : null}

                    {/* Always enabled: the answer lives on Monaco's model and would only be read
                        at render time, which is not when it changes. Both are no-ops with an empty
                        stack, and Ctrl+Z is the way most of this is reached anyway. */}
                    <Tooltip title={I18n.t('Undo')}>
                        <IconButton size="small" onClick={() => this.step(-1)}>
                            <IconUndo fontSize="small" />
                        </IconButton>
                    </Tooltip>
                    <Tooltip title={I18n.t('Redo')}>
                        <IconButton size="small" onClick={() => this.step(1)}>
                            <IconRedo fontSize="small" />
                        </IconButton>
                    </Tooltip>

                    <Box sx={{ flex: 1 }} />
                    {/* Without the engine prefix: every script in this tab carries it, so it is
                        the one part of the id that never tells the user anything. */}
                    <Typography variant="caption" sx={{ fontFamily: 'monospace', mr: 1 }}>
                        {selected.startsWith(PREFIX) ? selected.substring(PREFIX.length) : selected}
                    </Typography>

                    {/* Formatting needs the engine, because the formatter lives in its Python
                        environment -- so the button says that rather than doing nothing. The span
                        is what lets a disabled button still carry its tooltip. */}
                    <Tooltip
                        title={
                            instanceAlive
                                ? I18n.t('Format the script (Shift+Alt+F)')
                                : I18n.t('Instance is disabled')
                        }
                    >
                        <span>
                            <IconButton
                                size="small"
                                disabled={!instanceAlive || this.state.formatting}
                                onClick={() => void this.formatScript()}
                            >
                                <IconFormat fontSize="small" />
                            </IconButton>
                        </span>
                    </Tooltip>

                    <Tooltip title={I18n.t('Insert object ID')}>
                        <IconButton
                            size="small"
                            onClick={() =>
                                this.setState({
                                    showSelectId: this.spotAtCursor(id => OBJECT_ID.test(id)),
                                })
                            }
                        >
                            <IconSelectId fontSize="small" />
                        </IconButton>
                    </Tooltip>
                    <Tooltip title={I18n.t('Create or edit CRON')}>
                        <IconButton
                            size="small"
                            onClick={() =>
                                this.setState({
                                    showCron: this.spotAtCursor(cron => CRON.test(cron)),
                                })
                            }
                        >
                            <IconCron fontSize="small" />
                        </IconButton>
                    </Tooltip>
                    <Tooltip title={I18n.t('Documentation')}>
                        <IconButton size="small" onClick={() => this.setState({ showDoc: true })}>
                            <IconHelp fontSize="small" />
                        </IconButton>
                    </Tooltip>
                </Toolbar>

                <CodeEditor
                    id={selected}
                    value={source}
                    ref={this.editor}
                    onChange={value => this.edit(value)}
                    onSave={() => void this.save()}
                    onFormat={() => void this.formatScript()}
                    onScroll={this.rememberScroll}
                />
            </>
        );
    }

    /**
     * Editor, and the log beside or below it -- or the editor alone when the log is hidden.
     *
     * `SplitDirection.Horizontal` puts the two side by side, which is what "log on the right"
     * means; Vertical stacks them.
     */
    private renderEditorAndLog(gutterTheme: GutterTheme): JSX.Element {
        const { logs, instances, hideLog, logOnRight, autoScroll, logFilter } = this.state;

        const editor = (
            <Box
                sx={{
                    height: '100%',
                    display: 'flex',
                    flexDirection: 'column',
                    minWidth: 0,
                    minHeight: 0,
                }}
            >
                {this.renderEditor()}
            </Box>
        );

        if (hideLog) {
            // A small handle in the corner, the way the javascript adapter brings its log back --
            // otherwise hiding the log is a one-way door.
            return (
                <Box sx={{ position: 'relative', height: '100%' }}>
                    {editor}
                    <Tooltip title={I18n.t('Show logs')}>
                        <Box
                            onClick={() => this.toggle('hideLog')}
                            sx={{
                                position: 'absolute',
                                right: 3,
                                bottom: 0,
                                zIndex: 10,
                                width: 26,
                                height: 20,
                                display: 'flex',
                                alignItems: 'center',
                                justifyContent: 'center',
                                cursor: 'pointer',
                                borderRadius: '5px 5px 0 0',
                                bgcolor: 'action.selected',
                            }}
                        >
                            <IconShowLog sx={{ fontSize: 16 }} />
                        </Box>
                    </Tooltip>
                </Box>
            );
        }

        const log = (
            <LogPane
                lines={logs}
                instances={instances}
                filter={logFilter}
                current={this.state.selected}
                onFilter={filter => {
                    // Remembered like the layout switches: a filter that resets on every reload is
                    // one the user has to set again every time they come back to the same problem.
                    window.localStorage.setItem('python.logFilter', filter);
                    this.setState({ logFilter: filter });
                }}
                autoScroll={autoScroll}
                onToggleAutoScroll={() => this.toggle('autoScroll')}
                onRight={logOnRight}
                onToggleLayout={() => this.toggle('logOnRight')}
                onHide={() => this.toggle('hideLog')}
                onClear={() => this.setState({ logs: [] })}
            />
        );

        return (
            <ReactSplit
                // Remounting on a layout change is deliberate: the splitter reads initialSizes once,
                // and the same percentages mean widths in one direction and heights in the other.
                key={logOnRight ? 'right' : 'below'}
                direction={logOnRight ? SplitDirection.Horizontal : SplitDirection.Vertical}
                initialSizes={this.state.logSizes}
                minWidths={logOnRight ? [320, 200] : undefined}
                minHeights={logOnRight ? undefined : [120, 60]}
                gutterTheme={gutterTheme}
                onResizeFinished={(_pair, sizes) => {
                    const next = sizes as [number, number];
                    this.setState({ logSizes: next });
                    window.localStorage.setItem('python.logSizes', JSON.stringify(next));
                }}
            >
                {editor}
                {log}
            </ReactSplit>
        );
    }

    render(): JSX.Element {
        if (!this.state.loaded) {
            return (
                <StyledEngineProvider injectFirst>
                    <ThemeProvider theme={this.state.theme}>
                        <Loader themeType={this.state.themeType} />
                    </ThemeProvider>
                </StyledEngineProvider>
            );
        }

        const { scripts, folders, filter } = this.state;
        const tree = buildTree(scripts, folders, filter);
        const gutterTheme = this.state.themeType === 'dark' ? GutterTheme.Dark : GutterTheme.Light;

        return (
            <StyledEngineProvider injectFirst>
                <ThemeProvider theme={this.state.theme}>
                    <CssBaseline />
                    <Box sx={{ height: '100%', display: 'flex', flexDirection: 'column' }}>
                        {/* No instance picker: every python instance's scripts are in this one
                            tree, and which instance runs a script is a property of the script --
                            the badge in front of its name, changed through its own dialog. */}
                        <Toolbar variant="dense" sx={{ gap: 1, borderBottom: 1, borderColor: 'divider' }}>
                            <Box component="img" src="./python.svg" alt="" sx={{ width: 24, height: 24 }} />
                            <Typography sx={{ fontWeight: 600 }}>{I18n.t('Python scripts')}</Typography>
                            <Box sx={{ flex: 1 }} />
                            {!this.state.instances.length ? (
                                <Typography variant="caption" color="warning.main">
                                    {I18n.t('no python instance')}
                                </Typography>
                            ) : null}
                        </Toolbar>

                        <Box sx={{ flex: 1, minHeight: 0, '& .__dbk__gutter': { zIndex: 1 } }}>
                            <ReactSplit
                                direction={SplitDirection.Horizontal}
                                initialSizes={this.state.splitSizes}
                                minWidths={[200, 320]}
                                gutterTheme={gutterTheme}
                                onResizeFinished={(_pair, sizes) => {
                                    const next = sizes as [number, number];
                                    this.setState({ splitSizes: next });
                                    window.localStorage.setItem('python.splitSizes', JSON.stringify(next));
                                }}
                            >
                                {this.renderSidebar(tree)}

                                {this.renderEditorAndLog(gutterTheme)}
                            </ReactSplit>
                        </Box>
                    </Box>

                    {this.renderDialogs()}
                    {this.renderError()}
                    {this.renderToast()}
                </ThemeProvider>
            </StyledEngineProvider>
        );
    }
}
