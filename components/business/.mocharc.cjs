/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */

const { createConfig } = require('../../.mocharc.js');

module.exports = createConfig({
  require: 'test/test-helpers.js',
  // Plan 61: parallel-mode `setupParallelWorker` can take 5–10 s for
  // rqlited spawn — bump from the 2000 default so `[WHBK]` and `[USRP]`
  // `before all` hooks survive cold start.
  timeout: 10000
});
