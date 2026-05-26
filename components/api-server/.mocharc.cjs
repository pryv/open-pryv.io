/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */

const { createConfig } = require('../../.mocharc.js');
const glob = require('glob');

/**
 * Naming conventions for test files:
 * - *-2convert.test.js : Extracted Pattern A tests, ready for Pattern C conversion (non-parallel)
 * - *-seq.test.js      : Tests that must run sequentially (non-parallel)
 * - *.test.js (other)  : Parallel-safe tests
 */

// Auto-detect non-parallel tests by naming convention
const nonParallelTests = [
  ...glob.sync('test/**/*-2convert.test.js'),
  ...glob.sync('test/**/*-seq.test.js')
];

module.exports = createConfig({
  require: 'test-helpers/src/helpers-c.ts',
  // Plan 61: bumped from 10000 → 20000 (→ 40000 in parallel mode per
  // .mocharc.js doubling) so Pattern A `before all` hooks survive
  // cold child-api-server boot (~5–15 s with 14 workers spawning
  // concurrently). The "20s timeout" pattern of flake on AC01/ACCO/
  // VERS/PRFA/ACCP etc. is this cold-start race, not a code bug.
  timeout: 20000,
  slow: 20,
  nonParallelTests
});
