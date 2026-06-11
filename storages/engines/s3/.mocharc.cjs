/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */

const { createConfig } = require('../../../.mocharc.js');

// S3 engine tests talk to an external S3-compatible store (MinIO in dev)
// and skip themselves when none is reachable. No per-worker setup hook
// needed. Without this mocharc, mocha inherits `storages/.mocharc.cjs`
// and looks for `test/hook.js` which doesn't exist here.
module.exports = createConfig({
  timeout: 20000,
  slow: 200
});
