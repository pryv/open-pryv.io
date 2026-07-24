/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);

/**
 * [OAUTH-ORPHAN] revokeOrphanAccess — best-effort self-revoke of an
 * orphaned pre-minted access via HTTP accesses.delete.
 */

const assert = require('node:assert/strict');
const { revokeOrphanAccess } = require('../src/orphanAccess.ts');

describe('[OAUTH-ORPHAN] revokeOrphanAccess', () => {
  let calls;
  let originalFetch;

  beforeEach(() => {
    calls = [];
    originalFetch = globalThis.fetch;
  });
  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  function stubFetch (handler) {
    globalThis.fetch = async (url, init) => {
      calls.push({ url, init });
      return handler(url, init);
    };
  }

  it('[OORV1] issues DELETE accesses/<id> with the access token and returns true on 2xx', async () => {
    stubFetch(() => ({ status: 200 }));
    const ok = await revokeOrphanAccess({
      apiEndpoint: 'https://alice.pryv.me/',
      accessToken: 'tok-abc',
      accessId: 'acc-1',
    });
    assert.equal(ok, true);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, 'https://alice.pryv.me/accesses/acc-1');
    assert.equal(calls[0].init.method, 'DELETE');
    assert.equal(calls[0].init.headers.authorization, 'tok-abc');
  });

  it('[OORV2] strips an embedded token from the apiEndpoint and authenticates with the accessToken header', async () => {
    stubFetch(() => ({ status: 200 }));
    const ok = await revokeOrphanAccess({
      apiEndpoint: 'https://tok-in-url@alice.pryv.me/',
      accessToken: 'tok-header',
      accessId: 'acc-2',
    });
    assert.equal(ok, true);
    assert.equal(calls[0].url, 'https://alice.pryv.me/accesses/acc-2');
    assert.equal(calls[0].init.headers.authorization, 'tok-header');
  });

  it('[OORV3] treats 404 (access id gone) and 401 (token gone) as already-revoked success', async () => {
    stubFetch(() => ({ status: 404 }));
    assert.equal(await revokeOrphanAccess({ apiEndpoint: 'https://a.pryv.me/', accessToken: 't', accessId: 'x' }), true);
    stubFetch(() => ({ status: 401 }));
    assert.equal(await revokeOrphanAccess({ apiEndpoint: 'https://a.pryv.me/', accessToken: 't', accessId: 'x' }), true);
  });

  it('[OORV4] returns false on a non-2xx/other status (e.g. 500) without throwing', async () => {
    stubFetch(() => ({ status: 500 }));
    const ok = await revokeOrphanAccess({ apiEndpoint: 'https://a.pryv.me/', accessToken: 't', accessId: 'x' });
    assert.equal(ok, false);
  });

  it('[OORV5] returns false (never throws) when the request rejects (network / abort / timeout)', async () => {
    stubFetch(() => { throw Object.assign(new Error('aborted'), { name: 'AbortError' }); });
    assert.equal(await revokeOrphanAccess({ apiEndpoint: 'https://a.pryv.me/', accessToken: 't', accessId: 'x' }), false);
    stubFetch(() => { throw new Error('ECONNREFUSED'); });
    assert.equal(await revokeOrphanAccess({ apiEndpoint: 'https://a.pryv.me/', accessToken: 't', accessId: 'x' }), false);
  });

  it('[OORV6] returns false without calling fetch when required fields are missing', async () => {
    stubFetch(() => ({ status: 200 }));
    assert.equal(await revokeOrphanAccess({ apiEndpoint: '', accessToken: 't', accessId: 'x' }), false);
    assert.equal(await revokeOrphanAccess({ apiEndpoint: 'https://a.pryv.me/', accessToken: '', accessId: 'x' }), false);
    assert.equal(await revokeOrphanAccess({ apiEndpoint: 'https://a.pryv.me/', accessToken: 't', accessId: '' }), false);
    assert.equal(calls.length, 0);
  });

  it('[OORV7] returns false without throwing on a malformed apiEndpoint', async () => {
    stubFetch(() => ({ status: 200 }));
    assert.equal(await revokeOrphanAccess({ apiEndpoint: 'not a url', accessToken: 't', accessId: 'x' }), false);
    assert.equal(calls.length, 0);
  });

  it('[OORV8] percent-encodes the access id in the delete path', async () => {
    stubFetch(() => ({ status: 200 }));
    await revokeOrphanAccess({ apiEndpoint: 'https://a.pryv.me/', accessToken: 't', accessId: 'a/b c' });
    assert.equal(calls[0].url, 'https://a.pryv.me/accesses/a%2Fb%20c');
  });
});
