/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */

/**
 * [ORL] Refresh chain lifecycle: the session a rotation replaces is retired,
 * the session index names the refresh token issued with it, a token ended on
 * purpose (revoked marker) is refused without collapsing the chain, and a
 * rotation in flight never puts back a token ended meanwhile.
 */

import assert from 'node:assert/strict';
import { handleToken } from '../src/routes/token.ts';
import {
  setRefresh, getRefresh, getRefreshConsumed, getSessionIndex, setSessionIndex, hashSecret,
  revokeRefresh, revokeRefreshByHash, restoreConsumedRefresh, markRefreshConsumed,
} from '../src/storage.ts';

const CORE_ID = 'core-a';

function fakeConfig (overrides = {}) {
  const m = {
    'service:api': 'https://reg.pryv.me',
    'core:id': CORE_ID,
    'oauth:accessTokenTTL': 3600,
    'oauth:refreshTokenTTL': 30 * 24 * 3600,
    'oauth:refreshTokenAbsoluteTTL': 90 * 24 * 3600,
    'oauth:refreshReuseGraceSeconds': 0,
    ...overrides,
  };
  return { get: (k) => m[k] };
}

function fakePlatform () {
  const state = new Map();
  const kv = new Map();
  return {
    async setAccessState (k, v, exp) { state.set(k, { value: v, expiresAt: exp }); },
    async getAccessState (k) { return state.get(k) ?? null; },
    async deleteAccessState (k) { state.delete(k); },
    async consumeAccessState (k) { const e = state.get(k); state.delete(k); return e ?? null; },
    async setPlatformKv (k, v) { kv.set(k, v); },
    async getPlatformKv (k) { return kv.has(k) ? kv.get(k) : null; },
    async deletePlatformKv (k) { kv.delete(k); },
    async listPlatformKvKeys (p) { return [...kv.keys()].filter((k) => k.startsWith(p)); },
    async listPlatformKvEntries (p) { return [...kv.entries()].filter(([k]) => k.startsWith(p)).map(([key, value]) => ({ key, value })); },
    _state: state,
  };
}

function fakeRes () {
  return {
    statusCode: 0,
    headers: {},
    body: null,
    setHeader (k, v) { this.headers[k.toLowerCase()] = v; },
    end (b) { this.body = b ? JSON.parse(b) : null; },
  };
}

async function seed (platform, token, extra = {}) {
  const now = Date.now();
  await setRefresh(platform, CORE_ID, token, {
    clientId: 'myapp',
    userId: 'u-alice',
    scope: ['pryv:read'],
    issuedAt: now,
    lastUsedAt: now,
    expiresAt: now + 1e6,
    absoluteExpiresAt: now + 2e6,
    ...extra,
  });
}

let minted = 0;
const mint = async () => { minted++; return { accessId: 'acc-new-' + minted, accessToken: 'tok-new-' + minted, apiEndpoint: 'https://alice.pryv.me/' }; };

async function refresh (deps, token, clientId = 'myapp') {
  const res = fakeRes();
  await handleToken({ resolveUsername: async (id) => (id === 'u-alice' ? 'alice' : null), ...deps })({
    body: { grant_type: 'refresh_token', refresh_token: token, client_id: clientId },
  }, res);
  return res;
}

describe('[ORL] OAuth2: refresh chain lifecycle', () => {
  it('[ORL01] a rotation retires the session the chain backed, after the new rows exist; the new row names the new session', async () => {
    const platform = fakePlatform();
    await seed(platform, 'RT-1', { accessId: 'acc-old' });
    const calls = [];
    let lastToken = null;
    const res = await refresh({
      config: fakeConfig(),
      platform,
      mintRefreshedAccess: async () => { const m = await mint(); lastToken = m.accessToken; return m; },
      retireSession: async (p) => {
        // The new credentials are durable when the old session is retired:
        // the index row (written after the new refresh row) is there.
        calls.push({ ...p, indexed: (await getSessionIndex(platform, lastToken)) != null });
        return true;
      },
    }, 'RT-1');
    assert.equal(res.statusCode, 200, JSON.stringify(res.body));
    assert.equal(calls.length, 1);
    assert.deepEqual(calls[0], { userId: 'u-alice', username: 'alice', accessId: 'acc-old', clientId: 'myapp', indexed: true });
    const row = await getRefresh(platform, CORE_ID, res.body.refresh_token);
    assert.equal(row.accessId, res.body.access_token.replace('tok-', 'acc-'));
    const index = await getSessionIndex(platform, res.body.access_token);
    assert.equal(index.refreshTokenHash, hashSecret(res.body.refresh_token));
  });

  it('[ORL02] a failing retire never fails the refresh; a row without accessId retires nothing', async () => {
    const platform = fakePlatform();
    await seed(platform, 'RT-2', { accessId: 'acc-old' });
    const failed = await refresh({ config: fakeConfig(), platform, mintRefreshedAccess: mint, retireSession: async () => { throw new Error('boom'); } }, 'RT-2');
    assert.equal(failed.statusCode, 200, JSON.stringify(failed.body));
    await seed(platform, 'RT-3');
    let called = false;
    const none = await refresh({ config: fakeConfig(), platform, mintRefreshedAccess: mint, retireSession: async () => { called = true; return true; } }, 'RT-3');
    assert.equal(none.statusCode, 200);
    assert.equal(called, false);
  });

  it('[ORL03] a token ended on purpose: its replay is invalid_grant and never collapses the chain', async () => {
    const platform = fakePlatform();
    await seed(platform, 'RT-4', { dataGrantAccessId: 'grant-1' });
    const ended = await revokeRefresh(platform, CORE_ID, 'RT-4');
    assert.equal(ended.clientId, 'myapp');
    assert.equal(await getRefresh(platform, CORE_ID, 'RT-4'), null);
    assert.equal((await getRefreshConsumed(platform, CORE_ID, 'RT-4')).revoked, true);
    let revoked = 0;
    const res = await refresh({ config: fakeConfig(), platform, mintRefreshedAccess: mint, revokeChain: async () => { revoked++; } }, 'RT-4');
    assert.equal(res.statusCode, 400);
    assert.equal(res.body.error, 'invalid_grant');
    assert.equal(revoked, 0);
  });

  for (const [code, label, setup] of [
    ['ORL04', 'client_id mismatch', { clientId: 'other' }],
    ['ORL05', 'absolute lifetime exceeded', { absolute: true }],
    ['ORL06', 'consent revoked', { grantGone: true }],
  ]) {
    it(`[${code}] a final refusal after the consume (${label}) marks the token revoked: a replay past the grace collapses nothing`, async () => {
      const platform = fakePlatform();
      await seed(platform, 'RT-' + code, setup.absolute ? { absoluteExpiresAt: Date.now() - 1 } : {});
      const failingMint = async () => { const e = new Error('gone'); e.code = 'data-grant-revoked'; throw e; };
      const first = await refresh({ config: fakeConfig(), platform, mintRefreshedAccess: setup.grantGone ? failingMint : mint }, 'RT-' + code, setup.clientId ?? 'myapp');
      assert.equal(first.statusCode, 400, JSON.stringify(first.body));
      assert.equal((await getRefreshConsumed(platform, CORE_ID, 'RT-' + code)).revoked, true);
      let revoked = 0;
      const replay = await refresh({ config: fakeConfig(), platform, mintRefreshedAccess: mint, revokeChain: async () => { revoked++; } }, 'RT-' + code);
      assert.equal(replay.body.error, 'invalid_grant');
      assert.equal(revoked, 0);
    });
  }

  it('[ORL07] a rotated token (not ended on purpose) is still reuse: revokeChain fires', async () => {
    const platform = fakePlatform();
    await seed(platform, 'RT-7');
    const ok = await refresh({ config: fakeConfig(), platform, mintRefreshedAccess: mint }, 'RT-7');
    assert.equal(ok.statusCode, 200);
    let revoked = 0;
    await refresh({ config: fakeConfig(), platform, mintRefreshedAccess: mint, revokeChain: async () => { revoked++; } }, 'RT-7');
    assert.equal(revoked, 1);
  });

  it('[ORL08] a token ended while its rotation is in flight is not put back by the failed rotation', async () => {
    const platform = fakePlatform();
    await seed(platform, 'RT-8');
    // The mint fails (server error, the rotation is undone) after the token
    // was ended meanwhile (its session deleted, or revoked by the client).
    const res = await refresh({
      config: fakeConfig(),
      platform,
      mintRefreshedAccess: async () => { await revokeRefresh(platform, CORE_ID, 'RT-8'); throw new Error('storage down'); },
    }, 'RT-8');
    assert.equal(res.statusCode, 500);
    assert.equal(await getRefresh(platform, CORE_ID, 'RT-8'), null, 'not restored');
    assert.equal((await getRefreshConsumed(platform, CORE_ID, 'RT-8')).revoked, true);
    // Without the interference the same failure restores the row (unchanged).
    await seed(platform, 'RT-9');
    const undone = await refresh({ config: fakeConfig(), platform, mintRefreshedAccess: async () => { throw new Error('storage down'); } }, 'RT-9');
    assert.equal(undone.statusCode, 500);
    assert.ok(await getRefresh(platform, CORE_ID, 'RT-9') != null, 'restored');
    assert.equal(await getRefreshConsumed(platform, CORE_ID, 'RT-9'), null);
  });

  it('[ORL09] restoreConsumedRefresh: only with this rotation\'s marker; ended between check and write, the row is taken back out', async () => {
    const platform = fakePlatform();
    const row = { clientId: 'myapp', userId: 'u-alice', scope: [], issuedAt: 0, lastUsedAt: 0, expiresAt: Date.now() + 1e6, absoluteExpiresAt: Date.now() + 2e6 };
    await markRefreshConsumed(platform, CORE_ID, 'RT-10', { clientId: 'myapp', userId: 'u-alice', consumedAt: 111 }, Date.now() + 1e6);
    assert.equal(await restoreConsumedRefresh(platform, CORE_ID, 'RT-10', row, 222), false, 'another rotation\'s marker');
    assert.equal(await restoreConsumedRefresh(platform, CORE_ID, 'RT-10', row, null), false, 'no marker written');
    assert.equal(await getRefresh(platform, CORE_ID, 'RT-10'), null);
    // Ended right after the check: the restored row goes again.
    const racing = fakePlatform();
    await markRefreshConsumed(racing, CORE_ID, 'RT-11', { clientId: 'myapp', userId: 'u-alice', consumedAt: 5 }, Date.now() + 1e6);
    const set = racing.setAccessState.bind(racing);
    racing.setAccessState = async (k, v, e) => {
      await set(k, v, e);
      if (k.startsWith('oauth-rt/')) await revokeRefreshByHash(racing, CORE_ID, hashSecret('RT-11'));
    };
    assert.equal(await restoreConsumedRefresh(racing, CORE_ID, 'RT-11', row, 5), false);
    racing.setAccessState = set;
    assert.equal(await getRefresh(racing, CORE_ID, 'RT-11'), null);
    assert.equal((await getRefreshConsumed(racing, CORE_ID, 'RT-11')).revoked, true);
  });

  it('[ORL10] the code exchange names the refresh token on the session index row (no token in it)', async () => {
    const platform = fakePlatform();
    await setSessionIndex(platform, 'session-tok', { userId: 'u-alice', accessId: 'acc-1', clientId: 'myapp', coreId: CORE_ID, expiresAt: Date.now() + 1e6 });
    const { setSessionIndexRefresh } = await import('../src/storage.ts');
    await setSessionIndexRefresh(platform, 'session-tok', 'refresh-tok');
    const row = await getSessionIndex(platform, 'session-tok');
    assert.equal(row.refreshTokenHash, hashSecret('refresh-tok'));
    assert.ok(!JSON.stringify(row).includes('refresh-tok') && !JSON.stringify(row).includes('session-tok'));
    // No index row (its write failed): nothing is created.
    await setSessionIndexRefresh(platform, 'other-tok', 'refresh-tok');
    assert.equal(await getSessionIndex(platform, 'other-tok'), null);
  });
});
