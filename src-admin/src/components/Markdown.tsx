import { type JSX, type ReactNode } from 'react';
import { Box, Link, Typography } from '@mui/material';

import { slug } from '../markdown';

/**
 * Just enough Markdown for the help text, rendered without a dependency.
 *
 * The same trade the code editor makes against Monaco: the documentation is written in this repo,
 * so the subset it uses is known, and a parser for that subset is smaller than the library that
 * would render every other one. What is supported: headings, paragraphs, fenced code, pipe tables,
 * flat lists, and inline code, bold, italic and links. Anything unsupported is shown as the text it
 * is, never dropped -- documentation that silently loses a line is worse than one that looks plain.
 */

const CODE_SX = {
    fontFamily: 'ui-monospace, "Cascadia Code", Consolas, monospace',
    fontSize: '0.85em',
    px: 0.6,
    py: 0.15,
    borderRadius: 0.5,
    bgcolor: 'action.hover',
} as const;

/**
 * Inline markup inside one line of text.
 *
 * Code first and as a whole token: back-ticked text is literal, so `**` inside it is two asterisks
 * and not the start of a bold run.
 */
function inline(text: string, key: string): ReactNode[] {
    const out: ReactNode[] = [];
    const pattern = /(`[^`]+`)|(\*\*[^*]+\*\*)|(\*[^*]+\*)|(\[[^\]]+\]\([^)]+\))/g;
    let last = 0;
    let match: RegExpExecArray | null;
    let n = 0;

    while ((match = pattern.exec(text)) !== null) {
        if (match.index > last) {
            out.push(text.slice(last, match.index));
        }
        const token = match[0];
        const id = `${key}-${n++}`;
        if (token.startsWith('`')) {
            out.push(
                <Box key={id} component="code" sx={CODE_SX}>
                    {token.slice(1, -1)}
                </Box>,
            );
        } else if (token.startsWith('**')) {
            out.push(<strong key={id}>{token.slice(2, -2)}</strong>);
        } else if (token.startsWith('*')) {
            out.push(<em key={id}>{token.slice(1, -1)}</em>);
        } else {
            const [, label, href] = /^\[([^\]]+)\]\(([^)]+)\)$/.exec(token) as RegExpExecArray;
            out.push(
                <Link key={id} href={href} target="_blank" rel="noreferrer">
                    {label}
                </Link>,
            );
        }
        last = match.index + token.length;
    }

    if (last < text.length) {
        out.push(text.slice(last));
    }
    return out;
}

/** A pipe table's cells, with the `| --- |` separator row recognised but not rendered. */
function cells(line: string): string[] {
    return line
        .replace(/^\s*\|/, '')
        .replace(/\|\s*$/, '')
        .split('|')
        .map(cell => cell.trim());
}

const HEADING_SX: Record<number, object> = {
    1: { fontSize: '1.6rem', fontWeight: 500, mt: 0, mb: 1.5 },
    2: { fontSize: '1.25rem', fontWeight: 500, mt: 4, mb: 1 },
    3: { fontSize: '1.05rem', fontWeight: 600, mt: 3, mb: 0.75 },
    4: { fontSize: '1rem', fontWeight: 600, mt: 2, mb: 0.5 },
};

export function Markdown({ source }: { source: string }): JSX.Element {
    const lines = source.split(/\r?\n/);
    const blocks: ReactNode[] = [];
    const taken = new Set<string>();
    let paragraph: string[] = [];

    const flushParagraph = (): void => {
        if (paragraph.length) {
            const key = `p${blocks.length}`;
            blocks.push(
                <Typography key={key} sx={{ my: 1.25, lineHeight: 1.65 }}>
                    {inline(paragraph.join(' '), key)}
                </Typography>,
            );
            paragraph = [];
        }
    };

    for (let i = 0; i < lines.length; i++) {
        const line = lines[i];

        // Fenced code: everything up to the closing fence is literal, headings included.
        if (line.startsWith('```')) {
            flushParagraph();
            const code: string[] = [];
            for (i++; i < lines.length && !lines[i].startsWith('```'); i++) {
                code.push(lines[i]);
            }
            blocks.push(
                <Box
                    key={`c${blocks.length}`}
                    component="pre"
                    sx={{
                        ...CODE_SX,
                        px: 1.5,
                        py: 1.25,
                        my: 1.5,
                        overflowX: 'auto',
                        fontSize: 12.5,
                        lineHeight: 1.5,
                        border: 1,
                        borderColor: 'divider',
                    }}
                >
                    {code.join('\n')}
                </Box>,
            );
            continue;
        }

        const heading = /^(#{1,4})\s+(.*)$/.exec(line);
        if (heading) {
            flushParagraph();
            const level = heading[1].length;
            blocks.push(
                <Typography
                    key={`h${blocks.length}`}
                    id={slug(heading[2], taken)}
                    component={`h${level}` as 'h1'}
                    sx={{
                        ...HEADING_SX[level],
                        // Room for the heading to clear the top edge when it is scrolled to.
                        scrollMarginTop: 12,
                    }}
                >
                    {inline(heading[2], `h${blocks.length}`)}
                </Typography>,
            );
            continue;
        }

        // A pipe table: the header row, a separator, then the body.
        if (line.trim().startsWith('|') && /^\s*\|[\s:|-]+\|\s*$/.test(lines[i + 1] || '')) {
            flushParagraph();
            const header = cells(line);
            const rows: string[][] = [];
            for (i += 2; i < lines.length && lines[i].trim().startsWith('|'); i++) {
                rows.push(cells(lines[i]));
            }
            i--;
            const key = `t${blocks.length}`;
            blocks.push(
                <Box
                    key={key}
                    component="table"
                    sx={{
                        my: 1.5,
                        borderCollapse: 'collapse',
                        width: '100%',
                        '& td, & th': {
                            border: 1,
                            borderColor: 'divider',
                            px: 1,
                            py: 0.6,
                            textAlign: 'left',
                            verticalAlign: 'top',
                        },
                        '& th': { bgcolor: 'action.hover', fontWeight: 500 },
                    }}
                >
                    {/* An all-empty header row is a table used purely for layout -- the docs use one
                        for the key bindings -- so it is dropped rather than drawn as a blank strip. */}
                    {header.some(cell => cell) ? (
                        <thead>
                            <tr>
                                {header.map((cell, n) => (
                                    <th key={n}>{inline(cell, `${key}h${n}`)}</th>
                                ))}
                            </tr>
                        </thead>
                    ) : null}
                    <tbody>
                        {rows.map((row, r) => (
                            <tr key={r}>
                                {row.map((cell, c) => (
                                    <td key={c}>{inline(cell, `${key}r${r}c${c}`)}</td>
                                ))}
                            </tr>
                        ))}
                    </tbody>
                </Box>,
            );
            continue;
        }

        const bullet = /^\s*[-*]\s+(.*)$/.exec(line);
        const numbered = /^\s*\d+\.\s+(.*)$/.exec(line);
        if (bullet || numbered) {
            flushParagraph();
            const items: string[] = [];
            const ordered = !!numbered;
            for (; i < lines.length; i++) {
                const item = ordered ? /^\s*\d+\.\s+(.*)$/.exec(lines[i]) : /^\s*[-*]\s+(.*)$/.exec(lines[i]);
                if (!item) {
                    break;
                }
                items.push(item[1]);
            }
            i--;
            const key = `l${blocks.length}`;
            blocks.push(
                <Box
                    key={key}
                    component={ordered ? 'ol' : 'ul'}
                    sx={{ my: 1.25, pl: 3, lineHeight: 1.65, '& li': { mb: 0.5 } }}
                >
                    {items.map((item, n) => (
                        <li key={n}>{inline(item, `${key}i${n}`)}</li>
                    ))}
                </Box>,
            );
            continue;
        }

        if (!line.trim()) {
            flushParagraph();
            continue;
        }

        // Anything else joins the paragraph being collected: a hard-wrapped source file has to come
        // out as flowing text, not as one line per source line.
        paragraph.push(line.trim());
    }

    flushParagraph();

    return <>{blocks}</>;
}
