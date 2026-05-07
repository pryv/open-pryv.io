/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */

import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const helpers = require('../../../test/helpers');
const conformanceTests = require('platform/test/conformance/PlatformDB.test').default;

describe('[MGPF] MongoDB PlatformDB conformance', () => {
  conformanceTests(async () => {
    await helpers.dependencies.init();
    const storages = require('storages');
    return storages.platformDB;
  });
});
