import type { JSX } from 'react';
import { Box, Chip, IconButton, Tooltip, Typography } from '@mui/material';
import {
    Delete as IconDelete,
    Edit as IconEdit,
    Add as IconAdd,
    Folder as IconFolder,
    FolderOpen as IconFolderOpen,
    Pause as IconPause,
    PlayArrow as IconPlay,
} from '@mui/icons-material';
import { I18n } from '@iobroker/gui-components';

import { instanceOf, type TreeNode } from '../types';

interface ScriptTreeProps {
    nodes: TreeNode[];
    running: string[];
    selected: string;
    expanded: string[];
    onToggleFolder: (id: string) => void;
    /** The folder new items are created in; '' means the top level. */
    activeFolder: string;
    onPickFolder: (id: string) => void;
    onNewInFolder: (id: string) => void;
    /** Move a script into a folder; targetFolder '' is the top level. */
    onMove: (scriptId: string, targetFolder: string) => void;
    dragOver: string | null;
    onDragOverFolder: (id: string | null) => void;
    onSelect: (id: string) => void;
    /** Open the script's own dialog: rename it, or hand it to another instance. */
    onEdit: (id: string) => void;
    onToggleEnabled: (id: string, enabled: boolean) => void;
    onDelete: (id: string, isFolder: boolean) => void;
    /** A folder may only go when it is empty -- deleting a tree by accident is unrecoverable. */
    canDeleteFolder: (node: TreeNode) => boolean;
}

const ROW = {
    display: 'flex',
    alignItems: 'center',
    gap: 0.5,
    pr: 0.5,
    minHeight: 34,
    cursor: 'pointer',
    borderBottom: 1,
    borderColor: 'divider',
    '& .actions': { opacity: 0.35 },
    '&:hover .actions': { opacity: 1 },
} as const;

export function ScriptTree(props: ScriptTreeProps): JSX.Element {
    const render = (nodes: TreeNode[], depth: number): JSX.Element[] =>
        nodes.flatMap(node => {
            const indent = 1 + depth * 1.75;

            if (node.kind === 'folder') {
                const open = props.expanded.includes(node.id);
                const deletable = props.canDeleteFolder(node);

                return [
                    <Box
                        key={node.id}
                        data-row-id={node.id}
                        sx={{
                            ...ROW,
                            pl: indent,
                            bgcolor: node.id === props.dragOver ? 'primary.main' : 'action.hover',
                            ...(node.id === props.activeFolder
                                ? {
                                      boxShadow: theme => `inset 3px 0 0 ${theme.palette.secondary.main}`,
                                  }
                                : {}),
                        }}
                        // One click does both: open the folder and make it the place new items go.
                        onClick={() => {
                            props.onToggleFolder(node.id);
                            props.onPickFolder(node.id);
                        }}
                        onDragOver={event => {
                            event.preventDefault();
                            event.dataTransfer.dropEffect = 'move';
                            if (props.dragOver !== node.id) {
                                props.onDragOverFolder(node.id);
                            }
                        }}
                        onDragLeave={() => props.onDragOverFolder(null)}
                        onDrop={event => {
                            event.preventDefault();
                            // otherwise the root drop zone behind the tree handles it as well
                            // and the script lands at the top level instead of in this folder
                            event.stopPropagation();
                            props.onDragOverFolder(null);
                            const dragged = event.dataTransfer.getData('text/plain');
                            if (dragged) {
                                props.onMove(dragged, node.id);
                            }
                        }}
                    >
                        {open ? (
                            <IconFolderOpen sx={{ fontSize: 18, color: 'warning.main' }} />
                        ) : (
                            <IconFolder sx={{ fontSize: 18, color: 'warning.main' }} />
                        )}
                        <Typography variant="body2" sx={{ flex: 1, fontWeight: 600 }} noWrap>
                            {node.name}
                        </Typography>
                        <Chip size="small" label={node.total} sx={{ height: 18, fontSize: 11 }} />
                        <Box className="actions" sx={{ display: 'flex' }}>
                            <Tooltip title={I18n.t('New script in this folder')}>
                                <IconButton
                                    size="small"
                                    onClick={event => {
                                        event.stopPropagation();
                                        props.onNewInFolder(node.id);
                                    }}
                                >
                                    <IconAdd sx={{ fontSize: 16 }} />
                                </IconButton>
                            </Tooltip>
                            <Tooltip
                                title={
                                    deletable ? I18n.t('Delete folder') : I18n.t('Only an empty folder can be deleted')
                                }
                            >
                                {/* a disabled button swallows the tooltip, so wrap it */}
                                <span>
                                    <IconButton
                                        size="small"
                                        disabled={!deletable}
                                        onClick={event => {
                                            event.stopPropagation();
                                            props.onDelete(node.id, true);
                                        }}
                                    >
                                        <IconDelete sx={{ fontSize: 16 }} />
                                    </IconButton>
                                </span>
                            </Tooltip>
                        </Box>
                    </Box>,
                    ...(open ? render(node.children, depth + 1) : []),
                ];
            }

            const isRunning = props.running.includes(node.id);
            const enabled = !!node.obj.common.enabled;

            return [
                <Box
                    key={node.id}
                    data-row-id={node.id}
                    sx={{
                        ...ROW,
                        pl: indent,
                        ...(node.id === props.selected
                            ? {
                                  bgcolor: 'action.selected',
                                  boxShadow: theme => `inset 3px 0 0 ${theme.palette.primary.main}`,
                              }
                            : {}),
                    }}
                    onClick={() => props.onSelect(node.id)}
                    onDoubleClick={() => props.onSelect(node.id)}
                    draggable
                    onDragStart={event => {
                        event.dataTransfer.setData('text/plain', node.id);
                        event.dataTransfer.effectAllowed = 'move';
                    }}
                >
                    <Typography variant="caption" color="text.disabled" sx={{ fontFamily: 'monospace' }}>
                        [{instanceOf(node.obj)}]
                    </Typography>
                    <Typography
                        variant="body2"
                        sx={{ flex: 1, color: enabled ? 'text.primary' : 'text.disabled' }}
                        noWrap
                    >
                        {node.name}
                    </Typography>

                    <Box className="actions" sx={{ display: 'flex' }}>
                        <Tooltip
                            title={
                                enabled
                                    ? isRunning
                                        ? I18n.t('Running -- click to stop')
                                        : I18n.t('Enabled but not running -- click to stop')
                                    : I18n.t('Stopped -- click to start')
                            }
                        >
                            <IconButton
                                size="small"
                                onClick={event => {
                                    event.stopPropagation();
                                    props.onToggleEnabled(node.id, !enabled);
                                }}
                            >
                                {enabled ? (
                                    // Green only when it really runs: enabled and broken is amber,
                                    // which is the state the javascript adapter cannot show.
                                    <IconPause
                                        sx={{ fontSize: 18, color: isRunning ? 'success.main' : 'warning.main' }}
                                    />
                                ) : (
                                    <IconPlay sx={{ fontSize: 18, color: 'error.main' }} />
                                )}
                            </IconButton>
                        </Tooltip>

                        <Tooltip title={I18n.t('Delete script')}>
                            <IconButton
                                size="small"
                                onClick={event => {
                                    event.stopPropagation();
                                    props.onDelete(node.id, false);
                                }}
                            >
                                <IconDelete sx={{ fontSize: 16 }} />
                            </IconButton>
                        </Tooltip>

                        {/* Opening the script is what a click on the row already does, so the
                            pencil is where the things *about* the script live: its name and which
                            instance runs it. */}
                        <Tooltip title={I18n.t('Rename, or move to another instance')}>
                            <IconButton
                                size="small"
                                onClick={event => {
                                    event.stopPropagation();
                                    props.onEdit(node.id);
                                }}
                            >
                                <IconEdit sx={{ fontSize: 16 }} />
                            </IconButton>
                        </Tooltip>
                    </Box>
                </Box>,
            ];
        });

    if (!props.nodes.length) {
        return (
            <Box sx={{ p: 2 }}>
                <Typography variant="body2" color="text.secondary">
                    {I18n.t('No Python scripts yet. Use "New" to create one.')}
                </Typography>
            </Box>
        );
    }

    return <Box>{render(props.nodes, 0)}</Box>;
}
