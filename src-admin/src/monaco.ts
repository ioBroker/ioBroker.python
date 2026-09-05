/**
 * Monaco, with the editor whole and the languages down to the one this tab edits.
 *
 * `monaco-editor`'s own entry point registers all eighty-odd languages and the four language
 * *services* (TypeScript, CSS, HTML, JSON); the TypeScript one alone is several megabytes, and none
 * of it is reachable from a Python script editor. `edcore.main` is the package's own answer to
 * that: every editor contribution, no languages. Python is then the only one added.
 */
// Runtime and types come from two paths on purpose: `edcore.main` is what pulls the contributions
// in, but it ships no typings -- the API it re-exports is declared next to `editor.api`, which
// resolves to the very same module at runtime.
import 'monaco-editor/esm/vs/editor/edcore.main';
import { languages } from 'monaco-editor/esm/vs/editor/editor.api';
import { conf as pythonConf, language as pythonGrammar } from 'monaco-editor/esm/vs/basic-languages/python/python';

/**
 * Python, registered eagerly.
 *
 * `python.contribution` registers a *lazy* grammar: the tokenizer arrives through a dynamic import
 * the first time a Python model is tokenized. That indirection buys nothing when there is one
 * language and it is always the one in use -- and it costs: the chunk it loads is a separate
 * request that has to succeed before a single keyword is coloured, and a build that rewrites
 * dynamic imports (a dev server pre-bundling this package, say) silently leaves the editor
 * monochrome. Registering the grammar here makes it part of this module and removes the failure.
 */
languages.register({ id: 'python', extensions: ['.py', '.pyw'], aliases: ['Python', 'py'] });
languages.setLanguageConfiguration('python', pythonConf);
languages.setMonarchTokensProvider('python', pythonGrammar);

export * from 'monaco-editor/esm/vs/editor/editor.api';
