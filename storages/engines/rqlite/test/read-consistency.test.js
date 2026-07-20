/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */

import { createRequire } from 'node:module';
import assert from 'node:assert';
const require = createRequire(import.meta.url);
const { DBrqlite } = require('../src/DBrqlite.ts');

// Routing- and uniqueness-critical PlatformDB reads must be issued at
// rqlite `strong` read consistency: without it, a `weak` (default) read
// during a leader-core restart / Raft election can serve stale or empty
// node-local state, so core-resolution (`auth.cores`) transiently
// mis-routes a user to the wrong core or reports them unknown.
describe('[RQRC] rqlite read consistency', () => {
  let db;
  let urls;
  let originalFetch;

  // Stub fetch so we capture the request URL without needing a live rqlite.
  // Returns a well-formed rqlite response so callers get a value back.
  function stubFetch (value) {
    urls = [];
    originalFetch = global.fetch;
    global.fetch = async (url) => {
      urls.push(url);
      return {
        ok: true,
        async json () {
          return { results: [{ columns: ['value'], values: value == null ? [] : [[value]] }] };
        },
        async text () { return ''; }
      };
    };
  }

  beforeEach(() => { db = new DBrqlite('http://localhost:4001'); });
  afterEach(() => { if (originalFetch) global.fetch = originalFetch; });

  it('[RQRC1] getUserCore reads at level=strong', async () => {
    stubFetch('core-a');
    const core = await db.getUserCore('alice');
    assert.equal(core, 'core-a');
    assert.equal(urls.length, 1);
    assert.match(urls[0], /[?&]level=strong(&|$)/);
  });

  it('[RQRC2] getUsersUniqueField reads at level=strong', async () => {
    stubFetch('alice');
    const username = await db.getUsersUniqueField('email', 'alice@example.com');
    assert.equal(username, 'alice');
    assert.match(urls[0], /[?&]level=strong(&|$)/);
  });

  it('[RQRC3] getUserIndexedField reads at level=strong', async () => {
    stubFetch('token');
    const value = await db.getUserIndexedField('alice', 'insurancenumber');
    assert.equal(value, 'token');
    assert.match(urls[0], /[?&]level=strong(&|$)/);
  });

  it('[RQRC4] non-routing reads keep the default (no level override)', async () => {
    stubFetch(JSON.stringify({ id: 'core-a' })); // getCoreInfo JSON-parses the value
    await db.getCoreInfo('core-a');
    assert.doesNotMatch(urls[0], /[?&]level=/);
  });
});
