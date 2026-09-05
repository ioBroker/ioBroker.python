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

    return (
        <Box sx={{ height: '100%', display: 'flex', flexDirection: 'column', minHeight: 0 }}>
            <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.5, px: 1, py: 0.25 }}>
                <Tooltip title={I18n.t('Scroll down and follow the newest entry')}>
                    <IconButton
                        size="small"
                        color={autoScroll ? 'primary' : 'default'}
                        onClick={onToggleAutoScroll}
                    >
                        <IconBottom fontSize="small" />
                    </IconButton>
                </Tooltip>
                <Tooltip title={I18n.t('Change layout')}>
                    <IconButton size="small" onClick={onToggleLayout}>
                        {onRight ? (
                            <IconSplitVertical fontSize="small" />
                        ) : (
                            <IconSplitHorizontal fontSize="small" />
                        )}
                    </IconButton>
                </Tooltip>
                <Tooltip title={I18n.t('Hide logs')}>
                    <IconButton size="small" onClick={onHide}>
                        <IconHide fontSize="small" />
                    </IconButton>
                </Tooltip>

                <Typography variant="caption" sx={{ fontWeight: 600, ml: 0.5 }}>
                    {I18n.t('Log')}
                </Typography>
                <Typography variant="caption" color="text.secondary">
                    {instance || I18n.t('no instance')}
                </Typography>

                <Box sx={{ flex: 1 }} />
                <Tooltip title={I18n.t('Copy')}>
                    <IconButton size="small" onClick={copy}>
                        <IconCopy fontSize="small" />
                    </IconButton>
                </Tooltip>
                <Tooltip title={I18n.t('Clear log')}>
                    <IconButton size="small" onClick={onClear}>
                        <IconClear fontSize="small" />
                    </IconButton>
                </Tooltip>
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
    );
}
