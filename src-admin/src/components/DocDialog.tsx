import { useEffect, useMemo, useRef, type JSX } from 'react';
import { Box, Button, Dialog, DialogActions, DialogContent, DialogTitle, IconButton, Tooltip } from '@mui/material';
import { Close as IconClose, MenuBook as IconContents } from '@mui/icons-material';
import { I18n } from '@iobroker/gui-components';

import { Markdown } from './Markdown';
import { headings } from '../markdown';
import enDoc from '../assets/doc/en.md?raw';
import deDoc from '../assets/doc/de.md?raw';

/** Where the reader was, so the help reopens there rather than at the top. */
const SCROLL_KEY = 'python.docScroll';
const DOCS: Record<string, string> = { en: enDoc, de: deDoc };

function readNumber(key: string): number {
    const stored = Number(window.localStorage.getItem(key));
    return Number.isFinite(stored) && stored > 0 ? stored : 0;
}

interface DocDialogProps {
    onClose: () => void;
    /** Toggling the contents list is remembered by the caller, next to the other layout switches. */
    showContents: boolean;
    onToggleContents: () => void;
}

export function DocDialog({ onClose, showContents, onToggleContents }: DocDialogProps): JSX.Element {
    const text = useRef<HTMLDivElement>(null);

    // Only the languages the documentation is actually written in; anything else reads English
    // rather than an empty page.
    const source = DOCS[I18n.getLanguage()] || DOCS.en;
    const contents = useMemo(() => headings(source), [source]);

    // Restore after the text is on screen -- scrollTop before the content has a height clamps to 0.
    useEffect(() => {
        const at = readNumber(SCROLL_KEY);
        const frame = requestAnimationFrame(() =>
            requestAnimationFrame(() => {
                if (text.current) {
                    text.current.scrollTop = at;
                }
            }),
        );
        return () => cancelAnimationFrame(frame);
    }, []);

    const remember = (): void => {
        try {
            window.localStorage.setItem(SCROLL_KEY, String(text.current?.scrollTop || 0));
        } catch {
            // a full or blocked storage must not break reading the help
        }
    };

    const goTo = (anchor: string): void => {
        const target = text.current?.querySelector(`#${CSS.escape(anchor)}`);
        target?.scrollIntoView({ block: 'start', behavior: 'smooth' });
    };

    return (
        <Dialog
            open
            fullWidth
            maxWidth="md"
            onClose={onClose}
            slotProps={{ paper: { sx: { height: 'calc(100% - 64px)' } } }}
        >
            <DialogTitle sx={{ display: 'flex', alignItems: 'center', gap: 1, pb: 1 }}>
                <Tooltip title={I18n.t('Contents')}>
                    <IconButton
                        size="small"
                        color={showContents ? 'primary' : 'default'}
                        onClick={onToggleContents}
                    >
                        <IconContents />
                    </IconButton>
                </Tooltip>
                {I18n.t('Documentation')}
            </DialogTitle>

            <DialogContent
                dividers
                sx={{ display: 'flex', gap: 2, p: 0, minHeight: 0 }}
            >
                {showContents ? (
                    <Box
                        sx={{
                            flex: '0 0 220px',
                            overflowY: 'auto',
                            borderRight: 1,
                            borderColor: 'divider',
                            py: 1,
                        }}
                    >
                        {contents.map(entry => (
                            <Box
                                key={entry.anchor}
                                onClick={() => goTo(entry.anchor)}
                                sx={{
                                    // Indented by depth, so the shape of the document is visible.
                                    pl: 1 + (entry.level - 1) * 1.5,
                                    pr: 1,
                                    py: 0.5,
                                    cursor: 'pointer',
                                    fontSize: entry.level === 1 ? 14 : 13,
                                    fontWeight: entry.level === 1 ? 500 : 400,
                                    color: entry.level === 1 ? 'text.primary' : 'text.secondary',
                                    '&:hover': { bgcolor: 'action.hover', color: 'text.primary' },
                                }}
                            >
                                {entry.text}
                            </Box>
                        ))}
                    </Box>
                ) : null}

                <Box
                    ref={text}
                    onScroll={remember}
                    sx={{ flex: 1, overflowY: 'auto', minWidth: 0, px: 3, py: 2 }}
                >
                    <Markdown source={source} />
                </Box>
            </DialogContent>

            <DialogActions>
                <Button
                    variant="contained"
                    color="grey"
                    startIcon={<IconClose />}
                    onClick={onClose}
                >
                    {I18n.t('Close')}
                </Button>
            </DialogActions>
        </Dialog>
    );
}
