/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */

/**
 * Initialize test-helpers dependencies once so every consumer that
 * reaches `dependencies.storage.user.<X>` sees the engine-agnostic
 * StorageLayer target rather than the synchronous MongoDB-class
 * bootstrap. Otherwise tests that capture `storage.user.webhooks` at
 * module-load time (Webhook.test.js, others) hang under PG when Mongo
 * isn't running — the captured reference is the MongoDB placeholder
 * and Repository.insertOne never resolves.
 *
 * Mirrors components/storage/test/global.test.js + the api-server's
 * helpers/global.test.js init pattern.
 */
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);

const helpers = require('test-helpers');

before(async function () {
  await helpers.dependencies.init();
});
