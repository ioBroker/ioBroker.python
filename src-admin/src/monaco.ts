/**
 * Monaco, with the editor whole and the languages down to the one this tab edits.
 *
 * `monaco-editor`'s own entry point registers all eighty-odd languages and the four language
 * *services* (TypeScript, CSS, HTML, JSON); the TypeScript one alone is several megabytes, and none
 * of it is reachable from a Python script editor. `features/register.all` is the package's own
 * answer to that: every editor contribution, no languages. Python is then the only one added.
 *
 * The import paths go through the package's exports map (`monaco-editor/<path>` maps to
 * `esm/vs/<path>`), which is the only way in: a deep path of the `monaco-editor/esm/vs/...` kind
 * resolves to `esm/vs/esm/vs/...` and is not found.
 */
import 'monaco-editor/features/register.all.js';
// What the full entry point pulls in on top of `register.all`, minus the languages: the commands
// bound to keys, and the widgets the contributions above only register providers for.
import 'monaco-editor/editor/browser/coreCommands.js';
import 'monaco-editor/editor/common/standaloneStrings.js';
import 'monaco-editor/editor/contrib/caretOperations/browser/caretOperations.js';
import 'monaco-editor/editor/contrib/dropOrPasteInto/browser/copyPasteContribution.js';
import 'monaco-editor/editor/contrib/gotoError/browser/markerSelectionStatus.js';
import 'monaco-editor/editor/contrib/gotoSymbol/browser/goToCommands.js';
import 'monaco-editor/editor/contrib/semanticTokens/browser/documentSemanticTokens.js';
import 'monaco-editor/editor/contrib/suggest/browser/suggestController.js';
import { languages } from 'monaco-editor/editor/editor.api.js';
import { conf as pythonConf, language as pythonGrammar } from 'monaco-editor/languages/definitions/python/python.js';

/**
 * Python, registered eagerly.
 *
 * `python/register` registers a *lazy* grammar: the tokenizer arrives through a dynamic import the
 * first time a Python model is tokenized. That indirection buys nothing when there is one language
 * and it is always the one in use -- and it costs: the chunk it loads is a separate request that
 * has to succeed before a single keyword is coloured, and a build that rewrites dynamic imports (a
 * dev server pre-bundling this package, say) silently leaves the editor monochrome. Registering
 * the grammar here makes it part of this module and removes the failure.
 */
languages.register({ id: 'python', extensions: ['.py', '.pyw'], aliases: ['Python', 'py'] });
languages.setLanguageConfiguration('python', pythonConf);
languages.setMonarchTokensProvider('python', pythonGrammar);

export * from 'monaco-editor/editor/editor.api.js';
