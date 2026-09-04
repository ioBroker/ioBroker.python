import { createRef, type JSX } from 'react';
import { StyledEngineProvider, ThemeProvider } from '@mui/material/styles';
import {
    Box,
    Button,
    Chip,
    CssBaseline,
    Dialog,
    DialogActions,
    DialogContent,
    DialogContentText,
    DialogTitle,
    FormControlLabel,
    MenuItem,
    Paper,
    Switch,
    TextField,
    Toolbar,
    Tooltip,
    Typography,
} from '@mui/material';
import {
    Add as AddIcon,
    DataObject as StateIcon,
    Delete as DeleteIcon,
    Refresh as ReloadIcon,
    Save as SaveIcon,
    Schedule as CronIcon,
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
import { ScriptList } from './components/ScriptList';
import { ENGINE_TYPE, PREFIX, TEMPLATE, type LogLine, type ScriptObject } from './types';

import enLang from './i18n/en.json';
import deLang from './i18n/de.json';
import ruLang from './i18n/ru.json';

interface AppProps extends GenericAppProps {
    version: string;
}

interface AppState extends GenericAppState {
    scripts: Record<string, ScriptObject>;
    selected: string;
    source: string;
    changed: boolean;
    running: string[];
    instances: string[];
    instance: string;
    logs: LogLine[];
    maxLogLines: number;
    showSelectId: boolean;
    showCron: boolean;
    newName: string | null;
    confirmDelete: boolean;
}

export default class App extends GenericApp<AppProps, AppState> {
    private readonly editor = createRef<HTMLTextAreaElement>();
    private pollTimer: ReturnType<typeof setInterval> | null = null;
    private logCounter = 0;

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
            selected: '',
            source: '',
            changed: false,
            running: [],
            instances: [],
            instance: '',
            logs: [],
            maxLogLines: 300,
            showSelectId: false,
            showCron: false,
            newName: null,
            confirmDelete: false,
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

        const scripts = await this.loadScripts();
        await this.socket.subscribeObject(`${PREFIX}*`, this.onObjectChange);
        this.socket.registerLogHandler(this.onLog);

        // The tab keeps as many log lines as the instance is configured for.
        let maxLogLines = 300;
        if (instances.length) {
            const config = await this.socket.getObject(`system.adapter.${instances[0]}`);
            maxLogLines = Number(config?.native?.maxLogLines) || 300;
        }

        this.setState({ scripts, instances, instance: instances[0] || '', maxLogLines }, () => {
            void this.refreshRunning();
        });
        this.pollTimer = setInterval(() => void this.refreshRunning(), 5000);
    }

    private async loadScripts(): Promise<Record<string, ScriptObject>> {
        const all = await this.socket.getObjectViewSystem('script', 'script.', 'script.香');
        const scripts: Record<string, ScriptObject> = {};
        Object.values(all || {}).forEach(obj => {
            const script = obj as unknown as ScriptObject;
            if (script?.common?.engineType === ENGINE_TYPE) {
                scripts[script._id] = script;
            }
        });
        return scripts;
    }

    private readonly onObjectChange = (id: string, obj: ioBroker.Object | null | undefined): void => {
        const scripts = { ...this.state.scripts };
        const script = obj as unknown as ScriptObject | null;

        if (!script || script.common?.engineType !== ENGINE_TYPE) {
            delete scripts[id];
        } else {
            scripts[id] = script;
        }

        if (id !== this.state.selected) {
            this.setState({ scripts });
        } else if (!scripts[id]) {
            // The script being edited was deleted elsewhere.
            this.setState({ scripts, selected: '', source: '', changed: false });
        } else if (!this.state.changed) {
            // Follow an edit made elsewhere -- but never overwrite what is being typed here.
            this.setState({ scripts, source: scripts[id].common.source || '' });
        } else {
            this.setState({ scripts });
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
            if (Array.isArray(running)) {
                this.setState({ running });
            }
        } catch {
            // The engine may simply be stopped; the dots go grey and that is the message.
            this.setState({ running: [] });
        }
    }

    // -- actions ------------------------------------------------------------

    private select(id: string): void {
        if (this.state.changed && !window.confirm(I18n.t('Discard the unsaved changes?'))) {
            return;
        }
        this.setState({ selected: id, source: this.state.scripts[id]?.common.source || '', changed: false });
    }

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

    private async toggleEnabled(enabled: boolean): Promise<void> {
        const { selected, scripts } = this.state;
        const obj = JSON.parse(JSON.stringify(scripts[selected])) as ScriptObject;
        obj.common.enabled = enabled;
        try {
            await this.socket.setObject(selected, obj as unknown as ioBroker.SettableObject);
        } catch (error) {
            this.showError(I18n.t('Could not save: %s', (error as Error).message));
        }
    }

    private async create(rawName: string): Promise<void> {
        const name = rawName.replace(/[^A-Za-z0-9_.\-]/g, '_').replace(/^\.+|\.+$/g, '');
        if (!name) {
            this.showError(I18n.t('That name has no usable characters.'));
            return;
        }
        const id = `${PREFIX}${name}`;
        if (this.state.scripts[id]) {
            this.showError(I18n.t('A script with that name already exists.'));
            return;
        }
        if (!this.state.instance) {
            this.showError(I18n.t('There is no python instance to assign the script to.'));
            return;
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
            this.setState({ selected: id, source: TEMPLATE, changed: false });
        } catch (error) {
            this.showError(I18n.t('Could not create the script: %s', (error as Error).message));
        }
    }

    private async remove(): Promise<void> {
        try {
            await this.socket.delObject(this.state.selected);
            this.setState({ selected: '', source: '', changed: false, confirmDelete: false });
        } catch (error) {
            this.setState({ confirmDelete: false });
            this.showError(I18n.t('Could not delete: %s', (error as Error).message));
        }
    }

    private async reload(): Promise<void> {
        if (!this.state.instance || !this.state.selected) {
            return;
        }
        await this.socket.sendTo(this.state.instance, 'reloadScript', { id: this.state.selected });
        await this.refreshRunning();
    }

    /** Put text where the caret is -- what makes the two pickers useful rather than decorative. */
    private insert(text: string): void {
        const area = this.editor.current;
        if (!area) {
            return;
        }
        const at = area.selectionStart;
        const source = `${this.state.source.slice(0, at)}${text}${this.state.source.slice(area.selectionEnd)}`;
        this.setState({ source, changed: true }, () => {
            area.focus();
            area.selectionStart = area.selectionEnd = at + text.length;
        });
    }

    // -- render -------------------------------------------------------------

    private renderDialogs(): JSX.Element {
        const { showSelectId, showCron, newName, confirmDelete, selected } = this.state;

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

                {newName !== null ? (
                    <Dialog open maxWidth="xs" fullWidth onClose={() => this.setState({ newName: null })}>
                        <DialogTitle>{I18n.t('New script')}</DialogTitle>
                        <DialogContent>
                            <TextField
                                autoFocus
                                fullWidth
                                variant="standard"
                                label={I18n.t('Name (dots make folders)')}
                                value={newName}
                                onChange={event => this.setState({ newName: event.target.value })}
                                onKeyDown={event => {
                                    if (event.key === 'Enter' && newName.trim()) {
                                        this.setState({ newName: null });
                                        void this.create(newName);
                                    }
                                }}
                            />
                        </DialogContent>
                        <DialogActions>
                            <Button onClick={() => this.setState({ newName: null })}>{I18n.t('Cancel')}</Button>
                            <Button
                                variant="contained"
                                disabled={!newName.trim()}
                                onClick={() => {
                                    this.setState({ newName: null });
                                    void this.create(newName);
                                }}
                            >
                                {I18n.t('Create')}
                            </Button>
                        </DialogActions>
                    </Dialog>
                ) : null}

                {confirmDelete ? (
                    <Dialog open maxWidth="xs" onClose={() => this.setState({ confirmDelete: false })}>
                        <DialogTitle>{I18n.t('Delete script')}</DialogTitle>
                        <DialogContent>
                            <DialogContentText>{I18n.t('Delete %s?', selected)}</DialogContentText>
                        </DialogContent>
                        <DialogActions>
                            <Button onClick={() => this.setState({ confirmDelete: false })}>
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

    private renderEditor(): JSX.Element {
        const { selected, scripts, source, changed, running } = this.state;

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

        const isRunning = running.includes(selected);

        return (
            <>
                <Toolbar variant="dense" sx={{ gap: 1, borderBottom: 1, borderColor: 'divider', flexWrap: 'wrap' }}>
                    <Typography variant="caption" sx={{ fontFamily: 'monospace' }}>
                        {selected}
                    </Typography>
                    <FormControlLabel
                        control={
                            <Switch
                                size="small"
                                checked={!!scripts[selected].common.enabled}
                                onChange={event => void this.toggleEnabled(event.target.checked)}
                            />
                        }
                        label={<Typography variant="body2">{I18n.t('enabled')}</Typography>}
                    />
                    <Chip
                        size="small"
                        color={isRunning ? 'success' : 'default'}
                        variant={isRunning ? 'filled' : 'outlined'}
                        label={isRunning ? I18n.t('running') : I18n.t('stopped')}
                    />
                    <Box sx={{ flex: 1 }} />

                    <Tooltip title={I18n.t('Insert a state id at the cursor')}>
                        <Button size="small" startIcon={<StateIcon />} onClick={() => this.setState({ showSelectId: true })}>
                            {I18n.t('State')}
                        </Button>
                    </Tooltip>
                    <Tooltip title={I18n.t('Insert a @schedule decorator at the cursor')}>
                        <Button size="small" startIcon={<CronIcon />} onClick={() => this.setState({ showCron: true })}>
                            {I18n.t('Schedule')}
                        </Button>
                    </Tooltip>
                    <Button size="small" startIcon={<ReloadIcon />} onClick={() => void this.reload()}>
                        {I18n.t('Reload')}
                    </Button>
                    <Button
                        size="small"
                        color="error"
                        startIcon={<DeleteIcon />}
                        onClick={() => this.setState({ confirmDelete: true })}
                    >
                        {I18n.t('Delete')}
                    </Button>
                    <Button
                        size="small"
                        variant="contained"
                        startIcon={<SaveIcon />}
                        disabled={!changed}
                        onClick={() => void this.save()}
                    >
                        {I18n.t('Save')}
                    </Button>
                </Toolbar>

                <CodeEditor
                    value={source}
                    textareaRef={this.editor}
                    onChange={value => this.setState({ source: value, changed: true })}
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

        const { instances, instance, scripts, running, selected, logs } = this.state;

        return (
            <StyledEngineProvider injectFirst>
                <ThemeProvider theme={this.state.theme}>
                    <CssBaseline />
                    <Box sx={{ height: '100%', display: 'flex', flexDirection: 'column' }}>
                        <Toolbar variant="dense" sx={{ gap: 1, borderBottom: 1, borderColor: 'divider' }}>
                            <Typography sx={{ fontWeight: 600 }}>{I18n.t('Python scripts')}</Typography>
                            <Button
                                size="small"
                                startIcon={<AddIcon />}
                                onClick={() => this.setState({ newName: 'my_script' })}
                            >
                                {I18n.t('New')}
                            </Button>
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
                            <Paper
                                square
                                elevation={0}
                                sx={{
                                    width: 280,
                                    flex: '0 0 auto',
                                    borderRight: 1,
                                    borderColor: 'divider',
                                    overflowY: 'auto',
                                }}
                            >
                                <ScriptList
                                    scripts={scripts}
                                    running={running}
                                    selected={selected}
                                    onSelect={id => this.select(id)}
                                />
                            </Paper>

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
