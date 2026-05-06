/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */

import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);

const integrityFinalCheck = require('test-helpers/src/integrity-final-check');
const dependencies = require('./dependencies').default;

before(async function () {
  await dependencies.init();
});

afterEach(async function () {
  await integrityFinalCheck.all();
});
