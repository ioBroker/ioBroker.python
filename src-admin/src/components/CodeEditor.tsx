import { useLayoutEffect, useRef, type JSX, type RefObject } from 'react';
import { Box, useTheme } from '@mui/material';

/**
 * Python highlighting without an editor dependency.
 *
 * A highlighted `<pre>` sits exactly under a transparent `<textarea>`: the browser keeps doing the
 * text editing, we only paint underneath. That keeps the tab free of Monaco -- which would have to
 * be bundled or fetched, and an ioBroker box is often offline -- while still colouring the code.
 *
 * The invariant the technique depends on: the rendered text, with tags stripped, must be exactly
 * the source. Anything dropped or double-escaped shifts the overlay against the real caret.
 */
const TOKENS = new RegExp(
    [
        '(#[^\\n]*)', // comment
        '("""[\\s\\S]*?"""|\'\'\'[\\s\\S]*?\'\'\'|"(?:\\\\.|[^"\\\\\\n])*"|\'(?:\\\\.|[^\'\\\\\\n])*\')', // string
        '(@[A-Za-z_]\\w*)', // decorator
        '\\b(False|None|True|and|as|assert|async|await|break|class|continue|def|del|elif|else|except|finally|for|from|global|if|import|in|is|lambda|nonlocal|not|or|pass|raise|return|try|while|with|yield)\\b',
        '\\b(on|schedule|on_stop|set_state|get_state|send_to|log|script_id|script_name|adapter)\\b',
        '\\b(\\d+\\.?\\d*)\\b',
    ].join('|'),
    'g',
);

function escapeHtml(text: string): string {
    return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

export function highlight(text: string): string {
    let out = '';
    let last = 0;
    let match: RegExpExecArray | null;
    TOKENS.lastIndex = 0;

    while ((match = TOKENS.exec(text)) !== null) {
        out += escapeHtml(text.slice(last, match.index));
        const cls = match[1]
            ? 'tok-com'
            : match[2]
              ? 'tok-str'
              : match[3] || match[5]
                ? 'tok-api'
                : match[4]
                  ? 'tok-kw'
                  : 'tok-num';
        out += `<span class="${cls}">${escapeHtml(match[0])}</span>`;
        last = match.index + match[0].length;
    }
    out += escapeHtml(text.slice(last));
    // A trailing newline would otherwise collapse and misalign the last line.
    return `${out}\n`;
}

const FONT = {
    fontFamily: 'ui-monospace, "Cascadia Code", Consolas, "Courier New", monospace',
    fontSize: 13,
    lineHeight: 1.5,
    tabSize: 4,
    whiteSpace: 'pre' as const,
    padding: '10px 12px',
    margin: 0,
    border: 0,
    overflow: 'auto',
};

interface CodeEditorProps {
    value: string;
    onChange: (value: string) => void;
    textareaRef: RefObject<HTMLTextAreaElement | null>;
    onSave: () => void;
}

export function CodeEditor({ value, onChange, textareaRef, onSave }: CodeEditorProps): JSX.Element {
    const preRef = useRef<HTMLPreElement>(null);
    const dark = useTheme().palette.mode === 'dark';

    const colors = dark
        ? { kw: '#569cd6', str: '#ce9178', com: '#6a9955', api: '#c586c0', num: '#b5cea8' }
        : { kw: '#0033b3', str: '#067d17', com: '#8c8c8c', api: '#7a3e9d', num: '#1750eb' };

    // Keep the painted layer aligned with whatever the textarea scrolled to.
    useLayoutEffect(() => {
        const area = textareaRef.current;
        const pre = preRef.current;
        if (area && pre) {
            pre.scrollTop = area.scrollTop;
            pre.scrollLeft = area.scrollLeft;
        }
    }, [value, textareaRef]);

    const sync = (): void => {
        const area = textareaRef.current;
        const pre = preRef.current;
        if (area && pre) {
            pre.scrollTop = area.scrollTop;
            pre.scrollLeft = area.scrollLeft;
        }
    };

    return (
        <Box
            sx={{
                position: 'relative',
                flex: '1 1 auto',
                minHeight: 0,
                bgcolor: 'background.paper',
                '& .tok-kw': { color: colors.kw },
                '& .tok-str': { color: colors.str },
                '& .tok-com': { color: colors.com, fontStyle: 'italic' },
                '& .tok-api': { color: colors.api, fontWeight: 600 },
                '& .tok-num': { color: colors.num },
            }}
        >
            <Box
                component="pre"
                ref={preRef}
                aria-hidden
                sx={{ ...FONT, position: 'absolute', inset: 0, pointerEvents: 'none', color: 'text.primary' }}
                dangerouslySetInnerHTML={{ __html: highlight(value) }}
            />
            <Box
                component="textarea"
                ref={textareaRef}
                spellCheck={false}
                autoComplete="off"
                value={value}
                onChange={event => onChange((event.target as HTMLTextAreaElement).value)}
                onScroll={sync}
                onKeyDown={event => {
                    if (event.key === 'Tab') {
                        event.preventDefault();
                        const area = event.currentTarget as HTMLTextAreaElement;
                        const at = area.selectionStart;
                        onChange(`${value.slice(0, at)}    ${value.slice(area.selectionEnd)}`);
                        requestAnimationFrame(() => {
                            area.selectionStart = area.selectionEnd = at + 4;
                        });
                    } else if ((event.ctrlKey || event.metaKey) && event.key === 's') {
                        event.preventDefault();
                        onSave();
                    }
                }}
                sx={{
                    ...FONT,
                    position: 'absolute',
                    inset: 0,
                    resize: 'none',
                    outline: 'none',
                    background: 'transparent',
                    color: 'transparent',
                    caretColor: dark ? '#fff' : '#000',
                    '&::selection': { backgroundColor: 'rgba(51, 153, 204, 0.3)' },
                }}
            />
        </Box>
    );
}
