/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);

/**
 * [OSW] Revoking the accesses behind expired, never-exchanged authorization
 * codes (run by the master sweep).
 */

const assert = require('node:assert/strict');
const { revokeExpiredCodeOrphans } = require('../src/orphanSweep.ts');

function platformWithExpired (rowsByPrefix) {
  return {
    async listExpiredAccessStates (prefix) {
      return rowsByPrefix[prefix] ?? [];
    },
  };
}

describe('[OSW] expired authorization-code orphan sweep', () => {
  it('[OSW1] revokes this core\'s orphans locally, skips other cores, revokes legacy rows over HTTP', async () => {
    const platform = platformWithExpired({
      'oauth-ac/': [
        { key: 'oauth-ac/h1', value: { coreId: 'core-a', clientId: 'app', userId: 'u1', username: 'alice', accessId: 'acc-1' } },
        { key: 'oauth-ac/h2', value: { coreId: 'core-b', clientId: 'app', userId: 'u2', username: 'bob', accessId: 'acc-2' } },
      ],
      'oauth-code/': [
        { key: 'oauth-code/raw', value: { accessId: 'acc-3', accessToken: 'tok-3', apiEndpoint: 'https://carol.pryv.me/' } },
      ],
    });
    const local = [];
    const http = [];
    const revoked = await revokeExpiredCodeOrphans({
      platform,
      coreId: 'core-a',
      revokeLocal: async (p) => { local.push(p); },
      revokeHttp: async (p) => { http.push(p); return true; },
    });
    assert.equal(revoked, 2);
    assert.deepEqual(local, [{ userId: 'u1', username: 'alice', accessId: 'acc-1', clientId: 'app' }]);
    assert.deepEqual(http, [{ apiEndpoint: 'https://carol.pryv.me/', accessToken: 'tok-3', accessId: 'acc-3' }]);
  });

  it('[OSW2] a failing local revoke is not counted and does not stop the sweep', async () => {
    const platform = platformWithExpired({
      'oauth-ac/': [
        { key: 'a', value: { coreId: 'core-a', clientId: 'app', userId: 'u1', username: 'alice', accessId: 'acc-1' } },
        { key: 'b', value: { coreId: 'core-a', clientId: 'app', userId: 'u2', username: 'bob', accessId: 'acc-2' } },
      ],
    });
    const seen = [];
    const revoked = await revokeExpiredCodeOrphans({
      platform,
      coreId: 'core-a',
      revokeLocal: async (p) => { seen.push(p.accessId); if (p.accessId === 'acc-1') throw new Error('storage down'); },
      revokeHttp: async () => true,
    });
    assert.deepEqual(seen, ['acc-1', 'acc-2']);
    assert.equal(revoked, 1);
  });

  it('[OSW3] honours the per-tick cap', async () => {
    const rows = Array.from({ length: 5 }, (_, i) => ({ key: 'k' + i, value: { coreId: 'core-a', clientId: 'app', userId: 'u', username: 'x', accessId: 'acc-' + i } }));
    const platform = platformWithExpired({ 'oauth-ac/': rows });
    const local = [];
    await revokeExpiredCodeOrphans({ platform, coreId: 'core-a', maxPerTick: 3, revokeLocal: async (p) => { local.push(p); }, revokeHttp: async () => true });
    assert.equal(local.length, 3);
  });
});
