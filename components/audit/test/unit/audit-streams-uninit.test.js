/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */

import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
/* global assert */

const audit = require('audit').default;
const { auditUserStreams } = require('audit/src/datastore/auditUserStreams.ts');

// A process that serves the audit streams through the mall without having run
// audit.init() (an operator tool, for one) gets a clear error naming the
// missing step, not a TypeError from deep inside the store.
describe('[AUSN] audit streams without an initialized audit storage', function () {
  for (const streamId of ['accesses', 'actions']) {
    it(`[AUSN${streamId === 'accesses' ? '1' : '2'}] getOne('${streamId}') says the audit storage is not initialized`, async function () {
      const saved = audit._storage;
      audit._storage = undefined;
      try {
        await assert.rejects(() => auditUserStreams.getOne('u', streamId, {}), /audit storage is not initialized/);
      } finally {
        audit._storage = saved;
      }
    });
  }
});
