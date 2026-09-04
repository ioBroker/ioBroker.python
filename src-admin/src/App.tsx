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
    Search as IconSearch,
    UnfoldLess as IconCollapse,
    UnfoldMore as IconExpand,
    Undo as IconUndo,
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

import { CodeEditor } from './components/CodeEditor';
import { LogPane } from './components/LogPane';
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

interface AppProps extends GenericAppProps {
    version: string;
}

interface AppState extends GenericAppState {
    scripts: Record<string, ScriptObject>;
    folders: Record<string, FolderObject>;
    selected: string;
    source: string;
    running: string[];
    instances: string[];
    instance: string;
    logs: LogLine[];
    maxLogLines: number;
    expanded: string[];
    filter: string;
    showFilter: boolean;
    showSelectId: boolean;
    showCron: boolean;
    newScript: string | null;
    newFolder: string | null;
    confirmDelete: { id: string; isFolder: boolean } | null;
    /** Percentages, persisted so the layout survives a reload. */
    splitSizes: [number, number];
    logSizes: [number, number];
    /** Whether the engine instance is running at all -- an unstarted instance runs nothing. */
    instanceAlive: boolean;
    /** Folder that new scripts and folders are created in; '' is the top level. */
    activeFolder: string;
}

export default class App extends GenericApp<AppProps, AppState> {
    private readonly editor = createRef<HTMLTextAreaElement>();
    private pollTimer: ReturnType<typeof setInterval> | null = null;
    private logCounter = 0;
    private aliveId = '';

    /** Undo history for the open script; entries coalesce while typing. */
    private history: string[] = [];
    private historyAt = 0;
    private lastEdit = 0;

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
            selected: '',
            source: '',
            running: [],
            instances: [],
            instance: '',
            logs: [],
            maxLogLines: 300,
            expanded: [],
            filter: '',
            showFilter: false,
            showSelectId: false,
            showCron: false,
            newScript: null,
            newFolder: null,
            confirmDelete: null,
            instanceAlive: false,
            activeFolder: '',
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
    private get changed(): boolean {
        const { selected, scripts, source } = this.state;
        return !!selected && !!scripts[selected] && source !== (scripts[selected].common.source || '');
    }

    onConnectionReady(): void {
        void this.init();
    }

    componentWillUnmount(): void {
        if (this.pollTimer) {
            clearInterval(this.pollTimer);
        }
        this.socket?.unregisterLogHandler(this.onLog);
        if (this.aliveId) {
            this.socket?.unsubscribeState(this.aliveId, this.onAlive);
        }
        super.componentWillUnmount?.();
    }

    // -- data ---------------------------------------------------------------

    private async init(): Promise<void> {
        const found = await this.socket.getAdapterInstances('python');
        const instances = found.map(obj => obj._id.replace('system.adapter.', ''));

        const { scripts, folders } = await this.load();
        await this.socket.subscribeObject(`${PREFIX}*`, this.onObjectChange);
        this.socket.registerLogHandler(this.onLog);

        let maxLogLines = 300;
        if (instances.length) {
            const config = await this.socket.getObject(`system.adapter.${instances[0]}`);
            maxLogLines = Number(config?.native?.maxLogLines) || 300;
        }

        this.setState(
            {
                scripts,
                folders,
                instances,
                instance: instances[0] || '',
                maxLogLines,
                expanded: allFolderIds(buildTree(scripts, folders, '')),
            },
            () => void this.refreshRunning(),
        );
        this.pollTimer = setInterval(() => void this.refreshRunning(), 5000);
        await this.watchInstance(instances[0] || '');
    }

    /** Follow `<instance>.alive`, so the toolbar can tell "script stopped" from "engine stopped". */
    private async watchInstance(instance: string): Promise<void> {
        if (this.aliveId) {
            this.socket.unsubscribeState(this.aliveId, this.onAlive);
            this.aliveId = '';
        }
        if (!instance) {
            this.setState({ instanceAlive: false });
            return;
        }
        this.aliveId = `system.adapter.${instance}.alive`;
        const state = await this.socket.getState(this.aliveId);
        this.setState({ instanceAlive: !!state?.val });
        await this.socket.subscribeState(this.aliveId, this.onAlive);
    }

    private readonly onAlive = (_id: string, state: ioBroker.State | null | undefined): void => {
        this.setState({ instanceAlive: !!state?.val });
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

        if (id !== this.state.selected) {
            this.setState({ scripts, folders });
        } else if (!scripts[id]) {
            this.setState({ scripts, folders, selected: '', source: '' });
        } else if (!this.changed) {
            // Follow an edit made elsewhere -- but never overwrite what is being typed here.
            this.setState({ scripts, folders, source: scripts[id].common.source || '' });
        } else {
            this.setState({ scripts, folders });
        }
    };

    private readonly onLog = (message: {
        message: string;
        from: string;
        ts: number;
        severity: string;
    }): void => {
        if (!this.state.instance || message.from !== this.state.instance) {
            return;
        }
        const logs = [
            ...this.state.logs,
            { id: ++this.logCounter, ts: message.ts, message: message.message, severity: message.severity },
        ];
        this.setState({ logs: logs.slice(-this.state.maxLogLines) });
    };

    private async refreshRunning(): Promise<void> {
        if (!this.state.instance) {
            return;
        }
        try {
            const running = await this.socket.sendTo<string[]>(this.state.instance, 'listScripts', null);
            this.setState({ running: Array.isArray(running) ? running : [] });
        } catch {
            // The engine may simply be stopped; the dots go grey and that is the message.
            this.setState({ running: [] });
        }
    }

    // -- editing ------------------------------------------------------------

    private select(id: string): void {
        if (id === this.state.selected) {
            return;
        }
        if (this.changed && !window.confirm(I18n.t('Discard the unsaved changes?'))) {
            return;
        }
        const source = this.state.scripts[id]?.common.source || '';
        this.history = [source];
        this.historyAt = 0;
        this.setState({ selected: id, source, activeFolder: '' });
    }

    private edit(source: string): void {
        // Coalesce a burst of typing into one undo step, otherwise undo is per keystroke.
        const now = Date.now();
        if (now - this.lastEdit > 500) {
            this.history = this.history.slice(0, this.historyAt + 1);
            this.history.push(source);
            this.historyAt = this.history.length - 1;
        } else {
            this.history[this.historyAt] = source;
        }
        this.lastEdit = now;
        this.setState({ source });
    }

    private step(delta: number): void {
        const at = this.historyAt + delta;
        if (at < 0 || at >= this.history.length) {
            return;
        }
        this.historyAt = at;
        this.lastEdit = 0; // the next keystroke starts a fresh step
        this.setState({ source: this.history[at] });
    }

    private cancel(): void {
        const source = this.state.scripts[this.state.selected]?.common.source || '';
        this.history = [source];
        this.historyAt = 0;
        this.setState({ source });
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
                document
                    .querySelector(`[data-row-id="${CSS.escape(selected)}"]`)
                    ?.scrollIntoView({ block: 'nearest' }),
            ),
        );
    }

    private insert(text: string): void {
        const area = this.editor.current;
        if (!area) {
            return;
        }
        const at = area.selectionStart;
        this.edit(`${this.state.source.slice(0, at)}${text}${this.state.source.slice(area.selectionEnd)}`);
        requestAnimationFrame(() => {
            area.focus();
            area.selectionStart = area.selectionEnd = at + text.length;
        });
    }

    // -- object actions ------------------------------------------------------

    private async save(): Promise<void> {
        const { selected, scripts, source } = this.state;
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
        const { instance, selected } = this.state;
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
        if (!this.state.instance) {
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
                engine: `system.adapter.${this.state.instance}`,
                source: TEMPLATE,
                enabled: false,
                debug: false,
                verbose: false,
            },
            native: {},
        };
        try {
            await this.socket.setObject(id, obj as unknown as ioBroker.SettableObject);
            this.history = [TEMPLATE];
            this.historyAt = 0;
            this.setState({ selected: id, source: TEMPLATE });
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

    private async remove(): Promise<void> {
        const target = this.state.confirmDelete;
        if (!target) {
            return;
        }
        try {
            await this.socket.delObject(target.id);
            if (target.id === this.state.selected) {
                this.history = [''];
                this.historyAt = 0;
                this.setState({ confirmDelete: null, selected: '', source: '' });
            } else {
                this.setState({ confirmDelete: null });
            }
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
        const accept = (): void => {
            close();
            void submit(value);
        };
        const folder = this.currentFolder();

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
                        if (value.trim()) {
                            accept();
                        }
                    }}
                >
                    <DialogContent>
                        <TextField
                            autoFocus
                            fullWidth
                            variant="standard"
                            label={I18n.t('Name')}
                            helperText={folder ? I18n.t('Will be created in %s', folder) : I18n.t('Top level')}
                            value={value}
                            onChange={event =>
                                this.setState({ [which]: event.target.value } as unknown as Pick<
                                    AppState,
                                    typeof which
                                >)
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
                            disabled={!value.trim()}
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
                        dialogName="pythonScriptState"
                        title={I18n.t('Pick a state')}
                        onClose={() => this.setState({ showSelectId: false })}
                        onOk={id => {
                            this.setState({ showSelectId: false });
                            if (id) {
                                this.insert(`"${Array.isArray(id) ? id[0] : id}"`);
                            }
                        }}
                    />
                ) : null}

                {showCron ? (
                    <DialogCron
                        theme={this.state.theme}
                        cron="0 22 * * *"
                        title={I18n.t('Schedule')}
                        onClose={() => this.setState({ showCron: false })}
                        onOk={cron => {
                            this.setState({ showCron: false });
                            // Five fields only: the engine's parser is a plain cron, no seconds.
                            const fields = (cron || '').trim().split(/\s+/);
                            this.insert(`@schedule("${fields.slice(-5).join(' ')}")\n`);
                        }}
                    />
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
                        <IconButton
                            size="small"
                            onClick={() => this.setState({ expanded: allFolderIds(tree) })}
                        >
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

                <Box sx={{ flex: 1, overflowY: 'auto', minHeight: 0 }}>
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
                        onSelect={id => this.select(id)}
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
        const { selected, scripts, source, running, instanceAlive } = this.state;
        const changed = this.changed;
        const enabled = !!scripts[selected]?.common.enabled;
        const isRunning = running.includes(selected);

        if (!selected || !scripts[selected]) {
            return (
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
            );
        }

        return (
            <>
                <Toolbar variant="dense" sx={{ gap: 0.5, borderBottom: 1, borderColor: 'divider', flexWrap: 'wrap' }}>
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
                                <IconButton
                                    size="small"
                                    onClick={() => void this.setEnabled(selected, !enabled)}
                                >
                                    {enabled ? (
                                        <IconPause
                                            fontSize="small"
                                            sx={{ color: isRunning ? 'success.main' : 'warning.main' }}
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

                    <Tooltip title={I18n.t('Undo')}>
                        <span>
                            <IconButton size="small" disabled={this.historyAt <= 0} onClick={() => this.step(-1)}>
                                <IconUndo fontSize="small" />
                            </IconButton>
                        </span>
                    </Tooltip>
                    <Tooltip title={I18n.t('Redo')}>
                        <span>
                            <IconButton
                                size="small"
                                disabled={this.historyAt >= this.history.length - 1}
                                onClick={() => this.step(1)}
                            >
                                <IconRedo fontSize="small" />
                            </IconButton>
                        </span>
                    </Tooltip>

                    <Box sx={{ flex: 1 }} />
                    <Typography variant="caption" sx={{ fontFamily: 'monospace', mr: 1 }}>
                        {selected}
                    </Typography>

                    <Tooltip title={I18n.t('Insert object ID')}>
                        <IconButton size="small" onClick={() => this.setState({ showSelectId: true })}>
                            <IconSelectId fontSize="small" />
                        </IconButton>
                    </Tooltip>
                    <Tooltip title={I18n.t('Create or edit CRON')}>
                        <IconButton size="small" onClick={() => this.setState({ showCron: true })}>
                            <IconCron fontSize="small" />
                        </IconButton>
                    </Tooltip>
                </Toolbar>

                <CodeEditor
                    value={source}
                    textareaRef={this.editor}
                    onChange={value => this.edit(value)}
                    onSave={() => void this.save()}
                />
            </>
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

        const { instances, instance, scripts, folders, filter, logs } = this.state;
        const tree = buildTree(scripts, folders, filter);
        const gutterTheme = this.state.themeType === 'dark' ? GutterTheme.Dark : GutterTheme.Light;

        return (
            <StyledEngineProvider injectFirst>
                <ThemeProvider theme={this.state.theme}>
                    <CssBaseline />
                    <Box sx={{ height: '100%', display: 'flex', flexDirection: 'column' }}>
                        <Toolbar variant="dense" sx={{ gap: 1, borderBottom: 1, borderColor: 'divider' }}>
                            <Typography sx={{ fontWeight: 600 }}>{I18n.t('Python scripts')}</Typography>
                            <Box sx={{ flex: 1 }} />
                            <TextField
                                select
                                size="small"
                                variant="standard"
                                label={I18n.t('Engine')}
                                value={instance}
                                onChange={event =>
                                    this.setState({ instance: event.target.value, logs: [] }, () => {
                                        void this.refreshRunning();
                                        void this.watchInstance(event.target.value);
                                    })
                                }
                                sx={{ minWidth: 140 }}
                            >
                                {instances.length ? (
                                    instances.map(id => (
                                        <MenuItem key={id} value={id}>
                                            {id}
                                        </MenuItem>
                                    ))
                                ) : (
                                    <MenuItem value="">{I18n.t('no python instance')}</MenuItem>
                                )}
                            </TextField>
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

                                <ReactSplit
                                    direction={SplitDirection.Vertical}
                                    initialSizes={this.state.logSizes}
                                    minHeights={[120, 60]}
                                    gutterTheme={gutterTheme}
                                    onResizeFinished={(_pair, sizes) => {
                                        const next = sizes as [number, number];
                                        this.setState({ logSizes: next });
                                        window.localStorage.setItem('python.logSizes', JSON.stringify(next));
                                    }}
                                >
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
                                    <LogPane
                                        lines={logs}
                                        instance={instance}
                                        onClear={() => this.setState({ logs: [] })}
                                    />
                                </ReactSplit>
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
