import { useEffect, useRef, type JSX } from 'react';
import { Box, IconButton, Tooltip, Typography } from '@mui/material';
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

const COLOR: Record<string, string> = {
    error: 'error.main',
    warn: 'warning.main',
    debug: 'text.disabled',
    silly: 'text.disabled',
};

interface LogPaneProps {
    lines: LogLine[];
    instance: string;
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
    instance,
    autoScroll,
    onToggleAutoScroll,
    onRight,
    onToggleLayout,
    onHide,
    onClear,
}: LogPaneProps): JSX.Element {
    const box = useRef<HTMLDivElement>(null);

    // Following the tail is now an explicit switch rather than something inferred from where the
    // user last scrolled: reading an older line no longer silently turns it off, and turning it
    // back on is one click instead of a scroll to the bottom.
    useEffect(() => {
        const element = box.current;
        if (element && autoScroll) {
            element.scrollTop = element.scrollHeight;
        }
    }, [lines, autoScroll]);

    const copy = (): void => {
        const text = lines
            .map(line => `${new Date(line.ts).toISOString()} ${line.severity} ${line.message}`)
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
                <Box sx={{ display: 'flex', alignItems: 'baseline', gap: 1, px: 1.5, pt: 0.5 }}>
                    <Typography sx={{ fontWeight: 500 }}>{I18n.t('Log')}</Typography>
                    <Typography variant="caption" color="text.secondary">
                        {instance || I18n.t('no instance')}
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
                    {lines.map(line => (
                        <Box
                            key={line.id}
                            sx={{
                                whiteSpace: 'pre-wrap',
                                wordBreak: 'break-word',
                                color: COLOR[line.severity] || 'text.primary',
                            }}
                        >
                            {`${new Date(line.ts).toLocaleTimeString()}  ${line.message}`}
                        </Box>
                    ))}
                </Box>
            </Box>
        </Box>
    );
}
