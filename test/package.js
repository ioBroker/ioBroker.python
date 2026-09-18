/**
 * Package tests.
 *
 * Checks that package.json and io-package.json agree and satisfy the ioBroker schema. That matters
 * more here than for an ordinary adapter: this one declares `common.platform: "Python"` and a
 * `main` pointing into `python/`, fields almost no adapter uses, so a mistake in them would be
 * caught by nothing else until the controller refuses to start an instance.
 *
 * TEMPORARY: one of those checks is switched off in `mocharc.custom.json` --
 * "io-package.json matches its schema", via `fgrep` + `invert`. It fetches the schema from
 * js-controller's *master* branch, and `platform: "Python"` is not in its enum there yet; the value
 * exists only on `feat/python-runtime` (PR #3475). So the check fails on a correct adapter, and
 * since `deploy` depends on the job that runs it, nothing could be published at all.
 *
 * Remove both lines from `mocharc.custom.json` as soon as that PR is merged. Everything else in the
 * suite still runs -- the version match between the two files, the JSON config schema, the
 * translations -- so this hides exactly one assertion and nothing more.
 */

const path = require('node:path');
const { tests } = require('@iobroker/testing');

tests.packageFiles(path.join(__dirname, '..'));
