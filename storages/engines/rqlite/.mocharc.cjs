/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */

const { createConfig } = require('../../../.mocharc.js');

// rqlite engine tests cover the engine itself + rqliteProcess (which
// spawns its own rqlited). No per-worker setup hook needed.
// Without this mocharc, mocha inherits `storages/.mocharc.cjs` and
// looks for `test/hook.js` which doesn't exist here, crashing the
// matrix at exit 4.
module.exports = createConfig({
  timeout: 10000,
  slow: 20
});
