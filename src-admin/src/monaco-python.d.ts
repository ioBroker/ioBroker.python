/**
 * The Python grammar has no types of its own.
 *
 * `monaco-editor` ships `.d.ts` files for its API but not for the individual language definitions,
 * so the two values this one exports are declared here rather than silently typed `any`.
 */
declare module 'monaco-editor/languages/definitions/python/python.js' {
    import type { languages } from 'monaco-editor';

    export const conf: languages.LanguageConfiguration;
    export const language: languages.IMonarchLanguage;
}
