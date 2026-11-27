/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */

const { createConfig } = require('../../../.mocharc.js');

// The filesystem engine tests run against a temporary directory and need no
// database. Without this mocharc, mocha inherits `storages/.mocharc.cjs` and
// looks for `test/hook.js`, which does not exist here.
module.exports = createConfig({
  timeout: 10000,
  slow: 200
});
