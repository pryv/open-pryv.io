/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */

import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);

const assert = require('node:assert/strict');
const { isRequestServingProcess } = require('../src/processRole.ts');

describe('[PROL] isRequestServingProcess', () => {
  const saved = process.env.PRYV_WORKER_TYPE;
  afterEach(() => {
    if (saved == null) delete process.env.PRYV_WORKER_TYPE; else process.env.PRYV_WORKER_TYPE = saved;
  });

  it('[PROL1] the api, hfs and previews workers serve requests', () => {
    for (const type of ['api', 'hfs', 'previews']) {
      process.env.PRYV_WORKER_TYPE = type;
      assert.equal(isRequestServingProcess(), true, type);
    }
  });

  it('[PROL2] the master, command-line tools and unknown roles do not', () => {
    delete process.env.PRYV_WORKER_TYPE;
    assert.equal(isRequestServingProcess(), false);
    for (const type of ['', 'master', 'API', 'webhooks']) {
      process.env.PRYV_WORKER_TYPE = type;
      assert.equal(isRequestServingProcess(), false, JSON.stringify(type));
    }
  });
});
