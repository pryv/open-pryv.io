/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */
const path = require('path');

/**
 * Restores from a previously dumped version of test data.
 * See `../src/data` for details.
 */

if (!process.argv[2]) {
  console.log('Usage: ' + '`node restore-test-data {version}` (e.g. `0.2.0`)');
  process.exit(1);
}

const testData = require('../src/data');
const mongoFolder = path.resolve(__dirname, '../../../../mongodb');
testData.restoreFromDump(process.argv[2], mongoFolder, function (err) {
  if (err) {
    console.error(err);
  }
  process.exit(err ? 1 : 0);
});
