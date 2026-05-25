/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */

import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);

// Plan 61 Stage 5: hfs-server-specific hook. Avoids loading helpers-base
// (which would conflict with hfs-server's own test-helpers.js that
// already does boiler.init at module load). Just imports
// `parallelWorkerSetup` to expose `setupParallelWorker` to mochaHooks
// — env mirror for hfs-server lives in `test/acceptance/test-helpers.js`.
const parallelWorkerSetup = require('test-helpers/src/parallelWorkerSetup.ts');

export const mochaHooks = {
  async beforeAll () {
    this.timeout(30000);
    await parallelWorkerSetup.setupParallelWorker();
  },
  async afterAll () {
    this.timeout(30000);
    await parallelWorkerSetup.teardownParallelWorker();
  }
};
