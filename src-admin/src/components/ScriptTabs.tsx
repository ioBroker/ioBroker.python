import type { JSX } from 'react';
import { Box, Tab, Tabs, Tooltip } from '@mui/material';
import { Close as IconClose, FiberManualRecord as IconDirty } from '@mui/icons-material';
import { I18n } from '@iobroker/gui-components';

import { PREFIX } from '../types';

/**
 * The open scripts, as tabs above the editor -- the arrangement the javascript adapter uses.
 *
 * A tab holds unsaved work, so switching away from one no longer has to ask anything: the question
 * only arises when a tab with unsaved changes is closed, which is where the confirmation lives.
 */
interface ScriptTabsProps {
    /** Open scripts, in the order they were opened. */
    tabs: string[];
    selected: string;
    /** Whether a tab has unsaved changes; drives the dot in place of its close button. */
    isChanged: (id: string) => boolean;
    onSelect: (id: string) => void;
    onClose: (id: string) => void;
}

export function ScriptTabs({ tabs, selected, isChanged, onSelect, onClose }: ScriptTabsProps): JSX.Element | null {
    if (!tabs.length) {
        return null;
    }

    return (
        <Tabs
            value={tabs.includes(selected) ? selected : false}
            onChange={(_event, id: string) => onSelect(id)}
            variant="scrollable"
            scrollButtons="auto"
            sx={{
                minHeight: 36,
                borderBottom: 1,
                borderColor: 'divider',
                '& .MuiTab-root': { minHeight: 36, py: 0, pr: 0.5, textTransform: 'none' },
            }}
        >
            {tabs.map(id => {
                const changed = isChanged(id);
                return (
                    <Tab
                        key={id}
                        value={id}
                        // The full id as the tooltip: the label is only the last segment, and two
                        // scripts of the same name in different folders are otherwise identical.
                        label={
                            <Tooltip title={id.startsWith(PREFIX) ? id.substring(PREFIX.length) : id}>
                                <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.5 }}>
                                    <Box
                                        component="span"
                                        sx={{ fontStyle: changed ? 'italic' : undefined }}
                                    >
                                        {id.split('.').pop()}
                                    </Box>
                                    {/* One control, two meanings: a dot while there is unsaved work,
                                        a cross on hover -- so closing an edited tab is never a
                                        reflex click on something that used to be a cross. */}
                                    <Box
                                        component="span"
                                        role="button"
                                        aria-label={I18n.t('Close')}
                                        onMouseDown={event => {
                                            // mousedown, not click: the tab would select first, and
                                            // closing the tab you just switched to reads as a jump.
                                            event.stopPropagation();
                                            event.preventDefault();
                                            onClose(id);
                                        }}
                                        sx={{
                                            display: 'flex',
                                            alignItems: 'center',
                                            justifyContent: 'center',
                                            width: 18,
                                            height: 18,
                                            borderRadius: '50%',
                                            '&:hover': { bgcolor: 'action.selected' },
                                            '& .cross': { display: changed ? 'none' : 'block' },
                                            '& .dot': { display: changed ? 'block' : 'none' },
                                            '&:hover .cross': { display: 'block' },
                                            '&:hover .dot': { display: 'none' },
                                        }}
                                    >
                                        <IconClose
                                            className="cross"
                                            sx={{ fontSize: 14 }}
                                        />
                                        <IconDirty
                                            className="dot"
                                            sx={{ fontSize: 10 }}
                                        />
                                    </Box>
                                </Box>
                            </Tooltip>
                        }
                    />
                );
            })}
        </Tabs>
    );
}
