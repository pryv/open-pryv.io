/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */

import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);

/**
 * The consent's wrong-core decision, driven through an injected platform:
 * only a name the platform places on another core WITH a usable URL gets the
 * 421; every other outcome keeps the uniform answer. The two-core flow is
 * covered end to end by [2C79] in reg-2core.
 */

const assert = require('node:assert/strict');
const { wrongCoreOf } = require('../src/routes/oauth2/wrongCore.ts');

function platform (overrides = {}) {
  return {
    isSingleCore: false,
    coreId: 'core-a',
    getUserCore: async () => 'core-b',
    coreIdToUrl: () => 'https://core-b.example.com/',
    ...overrides
  };
}

describe('[OAUTH-WCORE] consent wrong-core decision', () => {
  it('[OWCR1] a name on another core with a usable URL answers that core', async () => {
    assert.deepEqual(await wrongCoreOf('alice', { platform: platform() }),
      { wrongCore: true, coreUrl: 'https://core-b.example.com/' });
  });

  it('[OWCR2] a core with no usable URL keeps the uniform answer (never "null/")', async () => {
    for (const url of ['null/', '', 'not a url', 'ftp://core-b.example.com/']) {
      assert.equal(await wrongCoreOf('alice', { platform: platform({ coreIdToUrl: () => url }) }), null, url);
    }
  });

  it('[OWCR3] single core, unknown name, this core, or a failed lookup keep the uniform answer', async () => {
    assert.equal(await wrongCoreOf('alice', { platform: platform({ isSingleCore: true }) }), null);
    assert.equal(await wrongCoreOf('alice', { platform: platform({ getUserCore: async () => null }) }), null);
    assert.equal(await wrongCoreOf('alice', { platform: platform({ getUserCore: async () => 'core-a' }) }), null);
    assert.equal(await wrongCoreOf('alice', { platform: platform({ getUserCore: async () => { throw new Error('down'); } }) }), null);
  });
});
