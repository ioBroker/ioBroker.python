/**
 * The Python grammar has no types of its own.
 *
 * `monaco-editor` ships `.d.ts` files for its API but not for the individual language definitions,
 * so the two values this one exports are declared here rather than silently typed `any`.
 */
/** Side effects only: every editor contribution, no languages. It ships no typings of its own. */
declare module 'monaco-editor/esm/vs/editor/edcore.main';

declare module 'monaco-editor/esm/vs/basic-languages/python/python' {
    import type { languages } from 'monaco-editor';

    export const conf: languages.LanguageConfiguration;
    export const language: languages.IMonarchLanguage;
}
