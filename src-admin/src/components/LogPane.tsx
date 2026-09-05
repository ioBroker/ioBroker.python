import { useEffect, useMemo, useRef, type JSX } from 'react';
import { Box, IconButton, MenuItem, Select, Tooltip, Typography } from '@mui/material';
import { alpha } from '@mui/material/styles';
import {
    ContentCopy as IconCopy,
    DeleteForever as IconClear,
    HorizontalSplit as IconSplitHorizontal,
    VerticalAlignBottom as IconBottom,
    VerticalSplit as IconSplitVertical,
    VisibilityOff as IconHide,
} from '@mui/icons-material';
import { I18n } from '@iobroker/gui-components';

import type { LogLine } from '../types';

/** Width of the vertical control strip, as in the javascript adapter. */
const TOOLBOX_WIDTH = 34;

/**
 * Text colour per severity, rather than the javascript adapter's full-width coloured bars.
 *
 * This pane is one flowing column of wrapped text: a band behind every info line would leave
 * nothing to distinguish the two severities that actually want finding.
 */
const SEVERITY_COLOR: Record<string, string> = {
    error: 'error.main',
    warn: 'warning.main',
    info: 'text.primary',
    debug: 'text.secondary',
    silly: 'text.disabled',
};

/** Those two also get a tint behind them, so they are visible while scrolling past, not only once
 *  read -- an error is usually several lines of traceback and easy to slide over. */
const TINTED: Record<string, 'error' | 'warning'> = { error: 'error', warn: 'warning' };

/** The filter value standing for "do not filter"; `''`, so an empty Select renders as that entry. */
export const ALL = '';

/** The value standing for the engine's own lines -- the ones no script produced. */
export const ENGINE = ' engine';

/**
 * Follow whatever script the editor has open.
 *
 * The default, and a mode rather than a value: moving to another script brings its log with it, but
 * an explicit choice survives the switch. Someone who picked "All scripts" to watch two scripts
 * interact should not have it undone by opening a file -- and when tabs arrive, this follows the
 * active tab without needing to know anything about tabs.
 *
 * The leading space keeps it out of the id namespace, as with {@link ENGINE}.
 */
export const FOLLOW = ' current';

/**
 * How a script id is written in the filter and in front of a line.
 *
 * The id without its branch prefix: short enough to sit in front of every line, and still unique --
 * two scripts in different folders share a name but never a path, and a name alone would file their
 * lines together.
 *
 * @param id full script id, e.g. `script.py.rooms.lights`
 */
function shortId(id: string): string {
    return id.replace(/^script\.py\./, '');
}

interface LogPaneProps {
    lines: LogLine[];
    /** The instances whose log this shows -- all of them, so it says how many rather than which. */
    instances: string[];
    /**
     * Show only this script's lines: a script id, {@link ALL}, {@link ENGINE}, or {@link FOLLOW}
     * to track whatever the editor has open.
     */
    filter: string;
    onFilter: (filter: string) => void;
    /** The script the editor has open; what {@link FOLLOW} resolves to. `''` when none is. */
    current: string;
    /** Follow the newest line instead of staying where the user scrolled to. */
    autoScroll: boolean;
    onToggleAutoScroll: () => void;
    /** Whether the pane sits beside the editor rather than below it. */
    onRight: boolean;
    onToggleLayout: () => void;
    onHide: () => void;
    onClear: () => void;
}

export function LogPane({
    lines,
    instances,
    filter,
    onFilter,
    current,
    autoScroll,
    onToggleAutoScroll,
    onRight,
    onToggleLayout,
    onHide,
    onClear,
}: LogPaneProps): JSX.Element {
    const box = useRef<HTMLDivElement>(null);

    // Built from the log rather than from the script tree: what belongs in the filter is what has
    // actually said something. A script that was deleted an hour ago still has lines in the buffer
    // and has to stay selectable; one that has never logged would only be an empty choice.
    const sources = useMemo(() => {
        const ids = new Set<string>();
        let engine = false;

        lines.forEach(line => (line.script ? ids.add(line.script) : (engine = true)));

        return { ids: [...ids].sort(), engine };
    }, [lines]);

    // What FOLLOW currently means. With nothing open it means everything, which is the only honest
    // answer -- an empty pane would look like a log that had stopped arriving.
    const effective = filter === FOLLOW ? current || ALL : filter;

    const shown = useMemo(() => {
        if (effective === ALL) {
            return lines;
        }
        return lines.filter(line => (effective === ENGINE ? !line.script : line.script === effective));
    }, [lines, effective]);

    // An explicitly chosen filter the log has grown out of would silently hide everything: that
    // script may have been deleted, or its lines pushed out of the buffer. FOLLOW is exempt -- a
    // script that has not logged yet is the normal state right after opening one, and falling back
    // to "all" there would be the pane overruling the user's navigation.
    const stale =
        filter !== ALL && filter !== FOLLOW && (filter === ENGINE ? !sources.engine : !sources.ids.includes(filter));

    // Following the tail is now an explicit switch rather than something inferred from where the
    // user last scrolled: reading an older line no longer silently turns it off, and turning it
    // back on is one click instead of a scroll to the bottom.
    useEffect(() => {
        const element = box.current;
        if (element && autoScroll) {
            element.scrollTop = element.scrollHeight;
        }
    }, [shown, autoScroll]);

    // What is on screen, not the whole buffer: copying while filtered should hand over the lines
    // that were being read, and the script is named on each so the text stands on its own.
    const copy = (): void => {
        const text = shown
            .map(
                line =>
                    `${new Date(line.ts).toISOString()} ${line.severity} ` +
                    `${line.script ? `[${shortId(line.script)}] ` : ''}${line.message}`,
            )
            .join('\n');
        void navigator.clipboard?.writeText(text);
    };

    const button = (title: string, icon: JSX.Element, onClick: () => void, active = false): JSX.Element => (
        <Tooltip title={title} placement="right">
            <IconButton size="small" color={active ? 'primary' : 'default'} onClick={onClick}>
                {icon}
            </IconButton>
        </Tooltip>
    );

    return (
        <Box sx={{ height: '100%', display: 'flex', minHeight: 0 }}>
            {/* A narrow column down the left, the way the javascript adapter arranges it: the
                controls stay in one place whether the pane sits below the editor or beside it,
                where a horizontal toolbar would eat the width the log needs. */}
            <Box
                sx={{
                    width: TOOLBOX_WIDTH,
                    flex: `0 0 ${TOOLBOX_WIDTH}px`,
                    display: 'flex',
                    flexDirection: 'column',
                    alignItems: 'center',
                    pt: 0.5,
                    boxShadow: 3,
                    zIndex: 1,
                }}
            >
                {button(
                    I18n.t('Scroll down and follow the newest entry'),
                    <IconBottom fontSize="small" />,
                    onToggleAutoScroll,
                    autoScroll,
                )}
                {button(
                    I18n.t('Change layout'),
                    onRight ? <IconSplitVertical fontSize="small" /> : <IconSplitHorizontal fontSize="small" />,
                    onToggleLayout,
                )}
                {button(I18n.t('Hide logs'), <IconHide fontSize="small" />, onHide)}

                {/* Nothing to copy or clear while the log is empty -- the same condition the
                    javascript adapter puts on these two. */}
                {lines.length ? button(I18n.t('Copy'), <IconCopy fontSize="small" />, copy) : null}
                {lines.length ? button(I18n.t('Clear log'), <IconClear fontSize="small" />, onClear) : null}
            </Box>

            <Box sx={{ flex: 1, display: 'flex', flexDirection: 'column', minWidth: 0, minHeight: 0 }}>
                <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, px: 1.5, pt: 0.5 }}>
                    <Typography sx={{ fontWeight: 500 }}>{I18n.t('Log')}</Typography>
                    <Typography variant="caption" color="text.secondary">
                        {instances.length === 1 ? instances[0] : I18n.t('%s instances', instances.length.toString())}
                    </Typography>

                    <Box sx={{ flex: 1 }} />

                    {/* Always offered now that the default is a mode: the user has to be able to
                        see that the pane is following the editor, and to step out of it. */}
                    <Tooltip title={I18n.t('Show only one script')}>
                        <Select
                            size="small"
                            variant="standard"
                            value={stale ? ALL : filter}
                            onChange={event => onFilter(event.target.value)}
                            sx={{ fontSize: 12, maxWidth: 220 }}
                            renderValue={value =>
                                value === FOLLOW
                                    ? // Naming the script it resolved to, not the mode: what the
                                      // pane is showing matters more than why it is showing it.
                                      current
                                        ? shortId(current)
                                        : I18n.t('All scripts')
                                    : value === ALL
                                      ? I18n.t('All scripts')
                                      : value === ENGINE
                                        ? I18n.t('Engine')
                                        : shortId(value)
                            }
                        >
                            <MenuItem value={FOLLOW}>{I18n.t('Open script')}</MenuItem>
                            <MenuItem value={ALL}>{I18n.t('All scripts')}</MenuItem>
                            {sources.engine ? <MenuItem value={ENGINE}>{I18n.t('Engine')}</MenuItem> : null}
                            {sources.ids.map(id => (
                                <MenuItem key={id} value={id}>
                                    {shortId(id)}
                                </MenuItem>
                            ))}
                        </Select>
                    </Tooltip>

                    <Typography variant="caption" color="text.secondary">
                        {shown.length === lines.length ? shown.length : `${shown.length} / ${lines.length}`}
                    </Typography>
                </Box>

                <Box
                    ref={box}
                    sx={{
                        flex: '1 1 auto',
                        overflow: 'auto',
                        px: 1.5,
                        pb: 1,
                        fontFamily: 'ui-monospace, Consolas, monospace',
                        fontSize: 12,
                    }}
                >
                    {shown.map(line => {
                        const tint = TINTED[line.severity];
                        return (
                            <Box
                                key={line.id}
                                sx={{
                                    whiteSpace: 'pre-wrap',
                                    wordBreak: 'break-word',
                                    color: SEVERITY_COLOR[line.severity] || 'text.primary',
                                    ...(tint ? { bgcolor: theme => alpha(theme.palette[tint].main, 0.1) } : {}),
                                }}
                            >
                                {`${new Date(line.ts).toLocaleTimeString()}  `}
                                {/* Named only while several scripts are mixed together. Once the
                                    filter has narrowed it to one, repeating that name on every line
                                    is noise in front of the message actually being read. */}
                                {line.script && effective === ALL ? (
                                    <Box component="span" sx={{ color: 'text.disabled' }}>
                                        {`[${shortId(line.script)}] `}
                                    </Box>
                                ) : null}
                                {line.message}
                            </Box>
                        );
                    })}
                </Box>
            </Box>
        </Box>
    );
}
