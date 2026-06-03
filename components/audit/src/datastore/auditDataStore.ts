/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);

const ds = require('@pryv/datastore');
const auditUserEvents = require('./auditUserEvents.ts').default;
const auditUserStreams = require('./auditUserStreams.ts').default;

type AuditDataStore = {
  id: string;
  name: string;
  init: () => Promise<unknown>;
  streams: unknown;
  events: unknown;
  deleteUser: (userId: string) => Promise<void>;
  getUserStorageInfos: (userId: string) => Promise<Record<string, unknown>>;
  [k: string]: unknown;
};

/**
 * Audit data store.
 */
const auditDataStore: AuditDataStore = ds.createDataStore({
  id: '_audit',
  name: 'Audit store',

  async init () {
    return this;
  },

  streams: auditUserStreams,
  events: auditUserEvents,

  async deleteUser (userId: string) {},

  async getUserStorageInfos (userId: string) {
    return { };
  }
});
export default auditDataStore;
export { auditDataStore };
