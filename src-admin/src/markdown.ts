/**
 * The pure half of the Markdown support: anchors and the contents list.
 *
 * Kept apart from the component so it can be exercised on its own -- and because deciding what a
 * document is made of has nothing to do with drawing it.
 */

/** A heading, for the contents list beside the text. */
export interface Heading {
    /** 1 for `#`, 2 for `##` ... */
    level: number;
    text: string;
    /** The `id` of the rendered heading, so the list can scroll to it. */
    anchor: string;
}

/** Turn a heading into an anchor that survives repeated words and punctuation. */
export function slug(text: string, taken: Set<string>): string {
    const base =
        text
            .toLowerCase()
            .replace(/`/g, '')
            .replace(/[^a-z0-9]+/g, '-')
            .replace(/^-|-$/g, '') || 'section';
    let anchor = base;
    for (let n = 2; taken.has(anchor); n++) {
        anchor = `${base}-${n}`;
    }
    taken.add(anchor);
    return anchor;
}

/** Every heading in the document, in the order they appear. */
export function headings(markdown: string): Heading[] {
    const taken = new Set<string>();
    const found: Heading[] = [];
    let fenced = false;

    markdown.split(/\r?\n/).forEach(line => {
        if (line.startsWith('```')) {
            fenced = !fenced;
            return;
        }
        const match = fenced ? null : /^(#{1,4})\s+(.*)$/.exec(line);
        if (match) {
            const text = match[2].replace(/`/g, '').trim();
            found.push({ level: match[1].length, text, anchor: slug(match[2], taken) });
        }
    });

    return found;
}
