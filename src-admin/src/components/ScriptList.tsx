import type { JSX } from 'react';
import {
    Box,
    List,
    ListItemButton,
    ListItemIcon,
    ListItemText,
    Tooltip,
    Typography,
} from '@mui/material';
import { Circle as CircleIcon } from '@mui/icons-material';
import { I18n } from '@iobroker/gui-components';

import { PREFIX, type ScriptObject } from '../types';

interface ScriptListProps {
    scripts: Record<string, ScriptObject>;
    running: string[];
    selected: string;
    onSelect: (id: string) => void;
}

export function ScriptList({ scripts, running, selected, onSelect }: ScriptListProps): JSX.Element {
    const ids = Object.keys(scripts).sort();

    if (!ids.length) {
        return (
            <Box sx={{ p: 2 }}>
                <Typography variant="body2" color="text.secondary">
                    {I18n.t('No Python scripts yet. Use "New" to create one.')}
                </Typography>
            </Box>
        );
    }

    return (
        <List dense disablePadding>
            {ids.map(id => {
                const short = id.substring(PREFIX.length);
                const parts = short.split('.');
                const name = parts.pop();
                const isRunning = running.includes(id);
                const enabled = !!scripts[id].common.enabled;

                return (
                    <ListItemButton
                        key={id}
                        selected={id === selected}
                        onClick={() => onSelect(id)}
                        sx={{ borderBottom: 1, borderColor: 'divider' }}
                    >
                        <ListItemIcon sx={{ minWidth: 28 }}>
                            <Tooltip
                                title={
                                    isRunning
                                        ? I18n.t('running')
                                        : enabled
                                          ? I18n.t('enabled, not running')
                                          : I18n.t('disabled')
                                }
                            >
                                <CircleIcon
                                    sx={{
                                        fontSize: 11,
                                        color: isRunning ? 'success.main' : enabled ? 'warning.main' : 'text.disabled',
                                    }}
                                />
                            </Tooltip>
                        </ListItemIcon>
                        <ListItemText
                            primary={name}
                            secondary={parts.length ? parts.join(' / ') : null}
                            slotProps={{
                                primary: { noWrap: true },
                                secondary: { noWrap: true, variant: 'caption' },
                            }}
                        />
                    </ListItemButton>
                );
            })}
        </List>
    );
}
