/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */

const { createConfig } = require('../../.mocharc.js');

// These are fast, fully-mocked unit tests (no HTTP, no DB), but they inherit
// the 2000 ms base timeout. Under a full test-matrix run on a high-core box
// the event loop is CPU-starved enough that several sub-2s tests exceed 2000 ms
// of wall-clock at once (whole-suite starvation, not a per-test hang) — e.g.
// [OTA-M2]/[OTA-CF1]/[OTA-CF4] in token.test.js timing out together under load.
// 10 s gives ~5x headroom for scheduling latency while still failing fast on a
// genuine hang.
module.exports = createConfig({
  timeout: 10000
});
