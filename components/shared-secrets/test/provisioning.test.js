/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */

/**
 * Shared secrets — provisioning helpers.
 *
 * The namespace is created lazily, so the trigger has to recognise every shape
 * a `streams` query can take. Missing one means a consumer whose first action
 * is a read can never bootstrap: the read needs the stream, and refuses to
 * create it. That is not hypothetical — the CMC namespace shipped exactly that
 * gap and a live integration hit it.
 */

import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const assert = require('node:assert/strict');
const { ensureStreams, queryTouchesNamespace, collectQueriedStreamIds } =
  require('../src/provisioning.ts');
const C = require('../src/constants.ts');

function stubMall (behaviour = () => {}) {
  const calls = [];
  return {
    calls,
    streams: {
      async create (userId, params) {
        calls.push({ userId, params });
        return behaviour(params);
      }
    }
  };
}

describe('[SHSP] shared-secrets provisioning', function () {
  describe('[SHSP-ENS] ensureStreams', function () {
    it('[SHS57] creates the root alone when no access is given', async function () {
      const mall = stubMall();
      const created = await ensureStreams({ mall, userId: 'u1' });
      assert.deepEqual(created, [C.NS]);
      assert.equal(mall.calls.length, 1);
      assert.equal(mall.calls[0].params.parentId, null);
    });

    it('[SHS58] creates the root and the per-access substream, parented correctly', async function () {
      const mall = stubMall();
      const created = await ensureStreams({ mall, userId: 'u1', accessId: 'acc-1' });
      assert.deepEqual(created, [C.NS, C.streamIdForAccess('acc-1')]);
      assert.equal(mall.calls[1].params.parentId, C.NS,
        'the substream must hang off the reserved root');
      assert.equal(mall.calls[1].params.createdBy, 'acc-1');
    });

    it('[SHS59] is idempotent — "already exists" is the normal outcome', async function () {
      const mall = stubMall(() => { throw new Error('item-already-exists'); });
      const created = await ensureStreams({ mall, userId: 'u1', accessId: 'acc-1' });
      assert.deepEqual(created, [], 'nothing newly created, and no throw');
    });

    it('[SHS60] still surfaces a real storage failure', async function () {
      const mall = stubMall(() => { throw new Error('disk on fire'); });
      await assert.rejects(
        () => ensureStreams({ mall, userId: 'u1', accessId: 'acc-1' }),
        /disk on fire/);
    });
  });

  describe('[SHSP-Q] query shapes that must trigger provisioning', function () {
    it('[SHS61] recognises the namespace in every streams-parameter shape', function () {
      const mine = C.streamIdForAccess('acc-1');
      const shapes = [
        mine,
        [mine],
        [{ streamId: mine }],
        [{ any: [mine] }],
        [{ all: [mine] }],
        [{ not: [mine] }],
        [{ any: ['other'] }, { any: [mine] }],
        [{ any: [{ streamId: mine }] }]
      ];
      for (const shape of shapes) {
        assert.equal(queryTouchesNamespace(shape), true,
          'must trigger on ' + JSON.stringify(shape));
      }
    });

    it('[SHS62] leaves unrelated queries alone', function () {
      for (const shape of [null, undefined, '*', ['*'], ['diary'], [{ streamId: 'diary' }],
        [{ any: ['diary'], not: ['work'] }], [{ streamId: ':_cmc:inbox' }]]) {
        assert.equal(queryTouchesNamespace(shape), false,
          'must NOT trigger on ' + JSON.stringify(shape));
      }
    });

    it('[SHS63] collects ids without throwing on malformed input', function () {
      for (const shape of [42, {}, [null], [{ any: null }], { streamId: 7 }]) {
        assert.doesNotThrow(() => collectQueriedStreamIds(shape));
      }
    });
  });
});
