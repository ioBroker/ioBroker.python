import { existsSync, readFileSync, writeFileSync } from 'node:fs';

const TAB_HTML = `${import.meta.dirname}/../admin/tab.html`;

function replaceScript(text: string, replaceText: string): string {
    if (text.includes(replaceText)) {
        return text;
    }
    const lines = text.split('\n');
    let found = false;
    let done = false;
    const newLines: string[] = [];
    for (let i = 0; i < lines.length; i++) {
        if (!done && lines[i].includes('<script>')) {
            found = true;
            newLines.push(`        ${replaceText}`);
        } else if (!done && found && lines[i].includes('</script>')) {
            found = false;
            done = true;
        } else if (!found) {
            newLines.push(lines[i]);
        }
    }

    return newLines.join('\n');
}

function patch(): void {
    if (!existsSync(TAB_HTML)) {
        throw new Error(`Cannot patch ${TAB_HTML}: file not found. Run "vite build" first.`);
    }
    let code = readFileSync(TAB_HTML).toString('utf8');
    code = replaceScript(
        code,
        `<script type="text/javascript" onerror="setTimeout(function(){window.location.reload()}, 5000)" src="../../lib/js/socket.io.js"></script>`,
    );

    writeFileSync(TAB_HTML, code);
}

patch();
