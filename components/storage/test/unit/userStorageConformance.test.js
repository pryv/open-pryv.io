/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */

import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const storage = require('storage');
const conformanceTests = require('storages/interfaces/baseStorage/conformance/UserStorage.test.js').default;
const { indexedUserId, unindexUserIds } = require('test-helpers/src/indexedUserIds.ts');

// The UserStorage contract, against the engine the run selects (STORAGE_ENGINE),
// on the profile collection.
describe('[USCF] UserStorage conformance (profile)', () => {
  let profile;
  before(async () => {
    await storage.userLocalDirectory.init();
    profile = (await storage.getStorageLayer()).profile;
  });
  after(() => unindexUserIds());
  conformanceTests(
    () => profile,
    indexedUserId,
    (userId, done) => profile.removeAll(userId, done)
  );
});
