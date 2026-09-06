/**
 * How this repository is formatted.
 *
 * The values are ioBroker's house style, the same object `@iobroker/eslint-config` exports and the
 * javascript, admin and vis-2 adapters import. They are written out here rather than imported
 * because that package brings eslint and its plugins with it, and this repository has no eslint
 * setup to justify the tree; if one is ever added, replace the object below with the import.
 *
 * The file exists at all so that nothing has to guess. Prettier falls back to its own defaults --
 * two spaces, 80 columns, double quotes -- when it finds no configuration, so a single `npx
 * prettier --write` in a repository without one reformats every file it touches from top to
 * bottom. That has already happened here once.
 *
 * It sits in the root and there is deliberately no second copy in `src-admin/`: prettier walks up
 * from each file it formats, so one file governs both halves of the repository.
 */
export default {
    printWidth: 120,
    semi: true,
    tabWidth: 4,
    useTabs: false,
    trailingComma: 'all',
    singleQuote: true,
    singleAttributePerLine: true,
    // `.gitattributes` stores and checks out every text file with LF. Prettier has to agree, or a
    // formatting run on Windows turns every line of a file into a change.
    endOfLine: 'lf',
    bracketSpacing: true,
    arrowParens: 'avoid',
    quoteProps: 'as-needed',
};
