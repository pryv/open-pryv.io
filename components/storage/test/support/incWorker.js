/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */

/**
 * Child process for [PXPU]: increments one profile value N times through the
 * storage layer, as a separate OS process (a separate API worker, in production).
 * argv: <userId> <profileId> <times>
 */

import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
// Same bootstrap as the storage tests' hook, which is also what selects the
// engine of the run (STORAGE_ENGINE) in the test config.
require('test-helpers/src/api-server-tests-config.ts');
require('test-helpers/src/helpers-base.ts').init({});
const { fromCallback } = require('utils');
const storage = require('storage');

const [userId, profileId, times] = process.argv.slice(2);
await storage.userLocalDirectory.init();
const profile = (await storage.getStorageLayer()).profile;
for (let i = 0; i < Number(times); i++) {
  const updated = await fromCallback((cb) => profile.findOneAndUpdate(userId, { id: profileId }, { $inc: { 'data.count': 1 } }, cb));
  if (updated == null) throw new Error(`item "${profileId}" of user "${userId}" not found by the worker`);
}
process.exit(0);
