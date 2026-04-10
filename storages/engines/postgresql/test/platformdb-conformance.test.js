/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */

const helpers = require('../../../test/helpers');
const conformanceTests = require('platform/test/conformance/PlatformDB.test');

describe('[PGPF] PostgreSQL PlatformDB conformance', function () {
  before(function () {
    if (process.env.STORAGE_ENGINE !== 'postgresql') return this.skip();
  });
  conformanceTests(async () => {
    await helpers.dependencies.init();
    const storages = require('storages');
    return storages.platformDB;
  });
});
