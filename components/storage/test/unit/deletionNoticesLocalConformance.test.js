/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */

import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const storage = require('storage');
const conformanceTests = require('storages/interfaces/baseStorage/conformance/DeletionNoticesLocalDB.test.js').default;

// The DeletionNoticesLocalDB contract, against the engine the run selects (STORAGE_ENGINE).
describe('[DNLDC] DeletionNoticesLocalDB conformance (selected engine)', () => {
  conformanceTests(async () => {
    await storage.userLocalDirectory.init();
    await storage.getStorageLayer();
    const { pluginLoader } = require('storages');
    const engineModule = pluginLoader.getEngineModule(pluginLoader.getEngineFor('baseStorage'));
    const { validateDeletionNoticesLocalDB } = require('storages/interfaces/baseStorage/DeletionNoticesLocalDB.ts');
    const Cls = engineModule.getDeletionNoticesLocal();
    const db = new Cls();
    await db.init();
    return validateDeletionNoticesLocalDB(db);
  });
});
