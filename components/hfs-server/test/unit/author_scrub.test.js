/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */

import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const assert = require('node:assert');
const { authorFor, pagedRows } = require('../../src/author_scrub.ts');

/** [HASC] Which `modifiedBy` values hold a credential, and what they become. */
describe('[HASC] series author scrub', function () {
  const live = { id: 'acc-live', type: 'personal', live: true, token: 'tok-live' };
  const gone = { id: 'acc-gone', type: 'app', live: false, token: 'tok-gone' };
  const byToken = new Map([[live.token, live], [gone.token, gone]]);
  const ids = new Set([live.id, gone.id]);

  it('[HASC1] maps a bare token to its access id', function () {
    assert.deepStrictEqual(authorFor('tok-live', byToken, ids), { value: 'acc-live', access: live });
  });

  it('[HASC2] keeps a caller-id suffix', function () {
    assert.strictEqual(authorFor('tok-live caller-1', byToken, ids).value, 'acc-live caller-1');
  });

  it('[HASC3] handles a DPoP scheme prefix and a deleted access', function () {
    assert.strictEqual(authorFor('DPoP tok-gone', byToken, ids).value, 'acc-gone');
  });

  it('[HASC4] leaves access ids, unknown values and non-strings alone', function () {
    assert.strictEqual(authorFor('acc-live', byToken, ids), null);
    assert.strictEqual(authorFor('acc-live caller-1', byToken, ids), null);
    assert.strictEqual(authorFor('someone-else', byToken, ids), null);
    assert.strictEqual(authorFor('', byToken, ids), null);
    assert.strictEqual(authorFor(null, byToken, ids), null);
    assert.strictEqual(authorFor(undefined, byToken, ids), null);
  });
});

/** [HASG] Keyset paging of the scan: every row once, one page in memory. */
describe('[HASG] series author scrub paging', function () {
  const rows = ['a', 'b', 'c', 'd', 'e'].map((id) => ({ id }));

  function reader (calls) {
    return async (afterId, limit) => {
      calls.push([afterId, limit]);
      return rows.filter((r) => afterId == null || r.id > afterId).slice(0, limit);
    };
  }

  async function collect (gen) {
    const out = [];
    for await (const row of gen) out.push(row.id);
    return out;
  }

  it('[HASG1] reads every row once, page after page, from the last id seen', async function () {
    const calls = [];
    assert.deepStrictEqual(await collect(pagedRows(reader(calls), 2)), ['a', 'b', 'c', 'd', 'e']);
    assert.deepStrictEqual(calls, [[null, 2], ['b', 2], ['d', 2]], 'a short page ends the scan');
  });

  it('[HASG2] stops on an empty page when the rows fill the last page exactly', async function () {
    const calls = [];
    assert.deepStrictEqual(await collect(pagedRows(reader(calls), 5)), ['a', 'b', 'c', 'd', 'e']);
    assert.deepStrictEqual(calls, [[null, 5], ['e', 5]]);
  });

  it('[HASG3] refuses a page size that is not a positive integer', async function () {
    for (const bad of [0, -1, 1.5, NaN]) {
      await assert.rejects(collect(pagedRows(reader([]), bad)), /page size must be a positive integer/);
    }
  });
});
