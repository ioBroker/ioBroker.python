import { useEffect, useRef, type JSX } from 'react';
import { Box, Button, Typography } from '@mui/material';
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
    onClear: () => void;
}

export function LogPane({ lines, instance, onClear }: LogPaneProps): JSX.Element {
    const box = useRef<HTMLDivElement>(null);
    const pinned = useRef(true);

    // Follow the tail, but stop following the moment the user scrolls up to read something.
    useEffect(() => {
        const element = box.current;
        if (element && pinned.current) {
            element.scrollTop = element.scrollHeight;
        }
    }, [lines]);

    return (
        <Box
            sx={{
                flex: '0 0 180px',
                borderTop: 1,
                borderColor: 'divider',
                display: 'flex',
                flexDirection: 'column',
                minHeight: 0,
            }}
        >
            <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, px: 1.5, py: 0.5 }}>
                <Typography variant="caption" sx={{ fontWeight: 600 }}>
                    {I18n.t('Log')}
                </Typography>
                <Typography variant="caption" color="text.secondary">
                    {instance || I18n.t('no instance')}
                </Typography>
                <Box sx={{ flex: 1 }} />
                <Button size="small" onClick={onClear}>
                    {I18n.t('Clear')}
                </Button>
            </Box>
            <Box
                ref={box}
                onScroll={event => {
                    const element = event.currentTarget;
                    pinned.current = element.scrollTop + element.clientHeight >= element.scrollHeight - 20;
                }}
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
