/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */

import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
require('test-helpers/src/api-server-tests-config');

const helpers = require('test-helpers');

before(async function () {
  await helpers.dependencies.init();
});
