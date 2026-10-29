/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */

import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const storage = require('storage');
const conformanceTests = require('storages/interfaces/baseStorage/conformance/ErasuresLocalDB.test.js').default;

// The ErasuresLocalDB contract, against the engine the run selects (STORAGE_ENGINE).
describe('[ERLDC] ErasuresLocalDB conformance (selected engine)', () => {
  conformanceTests(async () => {
    await storage.userLocalDirectory.init();
    await storage.getStorageLayer();
    const { pluginLoader } = require('storages');
    const engineModule = pluginLoader.getEngineModule(pluginLoader.getEngineFor('baseStorage'));
    const { validateErasuresLocalDB } = require('storages/interfaces/baseStorage/ErasuresLocalDB.ts');
    const Cls = engineModule.getErasuresLocal();
    const db = new Cls();
    await db.init();
    return validateErasuresLocalDB(db);
  });
});
