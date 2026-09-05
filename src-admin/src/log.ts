/**
 * Turning what arrives over the socket into log lines.
 *
 * The engine's log reaches this tab the long way round. `iobroker`'s `_Log` writes every record to
 * stdout, and js-controller re-logs whatever the process printed there under the *host*: one socket
 * message, `from` set to `host.<name>`, severity always `info`, the text prefixed with
 * `host.<name> system.adapter.<instance> `, and -- because it is a chunk of stdout rather than a
 * record -- often several records glued together, a traceback among them.
 *
 * Filtering on `from` therefore throws the whole log away. What identifies a line as ours is the
 * instance named inside it, which is how ioBroker.javascript's log pane does it too: it matches on
 * the text, never on the sender.
 *
 * So each chunk is taken apart again -- one entry per record, each with the level and the time the
 * Python process actually wrote, and continuation lines kept with the record they belong to.
 */
import type { LogLine } from './types';

/** A record as `_Log`'s formatter writes it: `2026-09-05 12:39:48,660 ERROR python.0 <text>`. */
const RECORD = /^(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2}:\d{2}),(\d{3}) ([A-Z]+)\s+(\S+) ?(.*)$/;

/**
 * The tag the engine puts in front of every line it can attribute: `[script.py.folder.name]`.
 *
 * Anchored, and stripped here rather than searched for anywhere in the text: a line that merely
 * mentions a script id -- an error quoting one, say -- must not be filed under that script. Only
 * the leading bracket counts, so a message the user wrote as `[whatever]` survives behind it.
 */
const SCRIPT_TAG = /^\[(script\.[^\]\s]+)\] ?/;

/** Python's level names in the spelling the log pane colours by. */
const SEVERITY: Record<string, string> = {
    DEBUG: 'debug',
    INFO: 'info',
    WARNING: 'warn',
    WARN: 'warn',
    ERROR: 'error',
    CRITICAL: 'error',
    FATAL: 'error',
};

/** A log message as the socket delivers it. */
export interface RawLog {
    message: string;
    from: string;
    ts: number;
    severity: string;
}

/** A log entry before the pane gives it its id. */
export type ParsedLog = Omit<LogLine, 'id'> & {
    /**
     * The line carried no record header, so it belongs to whatever came before it.
     *
     * Traceback frames are the reason. The engine writes an error and its traceback as one record,
     * but the host forwards the process's stdout line by line -- each frame arrives as its own
     * socket message, with its own `host.<name> system.adapter.<instance>` prefix and none of the
     * header that says which script and which level. Taken at face value they become separate
     * entries belonging to no script, which is how "handler 'react' raised:" ended up on screen
     * with nothing under it.
     */
    continuation?: boolean;
};

function escapeRegExp(text: string): string {
    return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Take a chunk of captured stdout apart into the records the process wrote.
 *
 * A line that carries a record header starts a new entry; anything else -- the frames of a
 * traceback, or a bare `print()` -- belongs to the entry above it, which is what keeps a stack
 * trace attached to the error it explains.
 */
function splitRecords(text: string, raw: RawLog): ParsedLog[] {
    const entries: ParsedLog[] = [];

    // `\r?\n`, not `\n`: the process writes its records through a Windows stdout, and a `\r` left
    // on the end of a line stops the header below from matching -- which used to cost the line
    // both its level and the colour that goes with it.
    text.split(/\r?\n/).forEach(line => {
        const record = RECORD.exec(line);
        if (record) {
            const [, date, time, ms, level, , text] = record;
            const ts = new Date(`${date}T${time}.${ms}`).getTime();
            // The tag comes off the message and becomes a field: the pane filters on the field, and
            // the id is not repeated in front of every line the user is already looking at.
            const tag = SCRIPT_TAG.exec(text);
            entries.push({
                ts: Number.isNaN(ts) ? raw.ts : ts,
                severity: SEVERITY[level] || 'info',
                message: tag ? text.substring(tag[0].length) : text,
                script: tag ? tag[1] : undefined,
            });
        } else if (entries.length) {
            const last = entries[entries.length - 1];
            entries[entries.length - 1] = { ...last, message: `${last.message}\n${line}` };
        } else if (line.trim()) {
            // No header, and nothing in this message to attach it to: either a bare `print()` or
            // the continuation of a record whose first line came in an earlier message. Which of
            // the two cannot be decided here, so it is passed on as a candidate and the caller --
            // the only place that knows what came before -- decides.
            entries.push({ ts: raw.ts, severity: raw.severity, message: line, continuation: true });
        }
    });

    return entries;
}

/**
 * Every log entry a socket message contributes; empty when it belongs to none of these instances.
 *
 * A list rather than a single instance: one editor manages every python instance, so the log shows
 * all of them and each line is claimed by whichever instance names it.
 */
export function parseLog(raw: RawLog, instances: string[]): ParsedLog[] {
    const text = raw.message || '';
    if (!instances.length || !text) {
        return [];
    }

    let body: string | null = null;
    for (const instance of instances) {
        if (raw.from === instance) {
            // The instance's own log channel: the message as the script wrote it.
            body = text;
            break;
        }
        // Otherwise only what the host captured for that instance counts, and only with the whole
        // prefix present -- a message that merely mentions it is somebody else's.
        const head = new RegExp(`^\\S+ system\\.adapter\\.${escapeRegExp(instance)} `).exec(text);
        if (head) {
            body = text.substring(head[0].length);
            break;
        }
    }
    if (body === null) {
        return [];
    }

    // Both routes then go through the same splitter. A formatted record can turn up on either --
    // the envelope's `severity` is only what the *sender* called the whole chunk, and for a chunk
    // of stdout that is always `info`, error or not. Where a record header exists it is the one
    // thing that knows the real level, so it decides.
    return splitRecords(body, raw);
}
