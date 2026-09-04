/**
 * Package tests.
 *
 * Checks that package.json and io-package.json agree and satisfy the ioBroker schema. That matters
 * more here than for an ordinary adapter: this one declares `common.platform: "Python"` and a
 * `main` pointing into `python/`, fields almost no adapter uses, so a mistake in them would be
 * caught by nothing else until the controller refuses to start an instance.
 */

const path = require('node:path');
const { tests } = require('@iobroker/testing');

tests.packageFiles(path.join(__dirname, '..'));
