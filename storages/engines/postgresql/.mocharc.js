/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */

const { createConfig } = require('../../../.mocharc.js');
const glob = require('glob');

const nonParallelTests = [
  ...glob.sync('test/**/*-seq.test.js')
];

module.exports = createConfig({
  require: 'test/hook.js',
  timeout: 10000,
  slow: 20,
  nonParallelTests
});
