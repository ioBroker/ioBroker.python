import { createRef, type JSX } from 'react';
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
    Clear as IconClear,
    CreateNewFolder as IconAddFolder,
    DataObject as IconSelectId,
    GpsFixed as IconLocate,
    NoteAdd as IconAddScript,
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

interface AppProps extends GenericAppProps {
    version: string;
}

interface AppState extends GenericAppState {
    scripts: Record<string, ScriptObject>;
    folders: Record<string, FolderObject>;
    selected: string;
    source: string;
    changed: boolean;
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
}

export default class App extends GenericApp<AppProps, AppState> {
    private readonly editor = createRef<HTMLTextAreaElement>();
    private pollTimer: ReturnType<typeof setInterval> | null = null;
    private logCounter = 0;

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
            changed: false,
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
        };
    }

    onConnectionReady(): void {
        void this.init();
    }

    componentWillUnmount(): void {
        if (this.pollTimer) {
            clearInterval(this.pollTimer);
        }
        this.socket?.unregisterLogHandler(this.onLog);
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
    }

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
            this.setState({ scripts, folders, selected: '', source: '', changed: false });
        } else if (!this.state.changed) {
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
        if (this.state.changed && !window.confirm(I18n.t('Discard the unsaved changes?'))) {
            return;
        }
        const source = this.state.scripts[id]?.common.source || '';
        this.history = [source];
        this.historyAt = 0;
        this.setState({ selected: id, source, changed: false });
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
        this.setState({ source, changed: true });
    }

    private step(delta: number): void {
        const at = this.historyAt + delta;
        if (at < 0 || at >= this.history.length) {
            return;
        }
        this.historyAt = at;
        this.lastEdit = 0; // the next keystroke starts a fresh step
        this.setState({ source: this.history[at], changed: true });
    }

    private cancel(): void {
        const source = this.state.scripts[this.state.selected]?.common.source || '';
        this.history = [source];
        this.historyAt = 0;
        this.setState({ source, changed: false });
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
        this.setState({ expanded });
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
            this.setState({ changed: false });
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

    /** Where a new item lands: inside the selected script's folder, so "New" is where you look. */
    private currentFolder(): string {
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
            this.setState({ selected: id, source: TEMPLATE, changed: false });
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
                this.setState({ confirmDelete: null, selected: '', source: '', changed: false });
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
            <Dialog open maxWidth="xs" fullWidth onClose={close}>
                <DialogTitle>{title}</DialogTitle>
                <DialogContent>
                    <TextField
                        autoFocus
                        fullWidth
                        variant="standard"
                        label={I18n.t('Name')}
                        helperText={folder ? I18n.t('Will be created in %s', folder) : I18n.t('Top level')}
                        value={value}
                        onChange={event =>
                            this.setState({ [which]: event.target.value } as unknown as Pick<AppState, typeof which>)
                        }
                        onKeyDown={event => {
                            if (event.key === 'Enter' && value.trim()) {
                                accept();
                            }
                        }}
                    />
                </DialogContent>
                <DialogActions>
                    <Button onClick={close}>{I18n.t('Cancel')}</Button>
                    <Button variant="contained" disabled={!value.trim()} onClick={accept}>
                        {I18n.t('Create')}
                    </Button>
                </DialogActions>
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
                    <Dialog open maxWidth="xs" onClose={() => this.setState({ confirmDelete: null })}>
                        <DialogTitle>
                            {confirmDelete.isFolder ? I18n.t('Delete folder') : I18n.t('Delete script')}
                        </DialogTitle>
                        <DialogContent>
                            <DialogContentText>{I18n.t('Delete %s?', confirmDelete.id)}</DialogContentText>
                        </DialogContent>
                        <DialogActions>
                            <Button onClick={() => this.setState({ confirmDelete: null })}>
                                {I18n.t('Cancel')}
                            </Button>
                            <Button color="error" variant="contained" onClick={() => void this.remove()}>
                                {I18n.t('Delete')}
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
                    width: 300,
                    flex: '0 0 auto',
                    borderRight: 1,
                    borderColor: 'divider',
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
        const { selected, scripts, source, changed } = this.state;

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
                    <Tooltip title={I18n.t('Locate file')}>
                        <IconButton size="small" onClick={() => this.locate()}>
                            <IconLocate fontSize="small" />
                        </IconButton>
                    </Tooltip>
                    <Tooltip title={I18n.t('Restart')}>
                        <IconButton size="small" onClick={() => void this.restart()}>
                            <IconRestart fontSize="small" />
                        </IconButton>
                    </Tooltip>

                    <Button
                        size="small"
                        variant="contained"
                        color="warning"
                        startIcon={<IconSave />}
                        disabled={!changed}
                        onClick={() => void this.save()}
                    >
                        {I18n.t('Save')}
                    </Button>
                    <Button
                        size="small"
                        variant="outlined"
                        startIcon={<IconCancel />}
                        disabled={!changed}
                        onClick={() => this.cancel()}
                    >
                        {I18n.t('Cancel')}
                    </Button>

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
                                    this.setState({ instance: event.target.value, logs: [] }, () =>
                                        void this.refreshRunning(),
                                    )
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

                        <Box sx={{ flex: 1, display: 'flex', minHeight: 0 }}>
                            {this.renderSidebar(tree)}
                            <Box sx={{ flex: 1, display: 'flex', flexDirection: 'column', minWidth: 0, minHeight: 0 }}>
                                {this.renderEditor()}
                                <LogPane
                                    lines={logs}
                                    instance={instance}
                                    onClear={() => this.setState({ logs: [] })}
                                />
                            </Box>
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
