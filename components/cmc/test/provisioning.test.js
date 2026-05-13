/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);

/**
 * Plan 68 Phase C — auto-provisioning unit tests.
 *
 * [CMCPROV] suite covers `provisionUserStreams` against a fake mall:
 * - all seven reserved parents created on a fresh user
 * - parent → child order respected
 * - idempotent re-runs
 * - non-already-exists errors bubble up
 */

const assert = require('node:assert/strict');
const { provisionUserStreams, RESERVED_TREE, isAlreadyExistsError } = require('../src/provisioning.ts');

function fakeMall (opts = {}) {
  const created = [];
  const existing = new Set(opts.existing || []);
  return {
    created,
    streams: {
      async create (userId, params) {
        if (existing.has(params.id)) {
          const err = new Error(`stream ${params.id} already exists`);
          err.id = 'item-already-exists';
          throw err;
        }
        created.push({ userId, id: params.id, parentId: params.parentId, name: params.name });
        existing.add(params.id);
        return { id: params.id, parentId: params.parentId };
      },
    },
  };
}

describe('[CMCPROV] cmc/provisioning', () => {
  it('[CP01] RESERVED_TREE has the five expected parents in dependency order', () => {
    const ids = RESERVED_TREE.map((s) => s.id);
    assert.deepEqual(ids, [
      ':_cmc:',
      ':_cmc:inbox',
      ':_cmc:apps',
      ':_cmc:_internal',
      ':_cmc:_internal:retries',
    ]);
    // Every non-root entry has a parentId that appears earlier.
    const seen = new Set();
    for (const s of RESERVED_TREE) {
      if (s.parentId == null) {
        seen.add(s.id);
        continue;
      }
      assert.ok(seen.has(s.parentId), `parent ${s.parentId} must precede ${s.id}`);
      seen.add(s.id);
    }
  });

  it('[CP02] provisions all five streams on a fresh user', async () => {
    const mall = fakeMall();
    const created = await provisionUserStreams({ mall, userId: 'u1' });
    assert.deepEqual(created, [
      ':_cmc:',
      ':_cmc:inbox',
      ':_cmc:apps',
      ':_cmc:_internal',
      ':_cmc:_internal:retries',
    ]);
    assert.equal(mall.created.length, 5);
    assert.equal(mall.created[0].parentId, null);
    assert.equal(mall.created[1].parentId, ':_cmc:');
  });

  it('[CP03] tags created streams with clientData.cmc.kind = reserved-parent + autoProvisioned: true', async () => {
    const calls = [];
    const mall = {
      streams: {
        async create (userId, params) {
          calls.push(params);
          return { id: params.id };
        },
      },
    };
    await provisionUserStreams({ mall, userId: 'u1' });
    for (const call of calls) {
      assert.deepEqual(call.clientData, {
        cmc: { kind: 'reserved-parent', autoProvisioned: true },
      });
    }
  });

  it('[CP04] is idempotent — re-running on a user with all parents present creates nothing', async () => {
    const mall = fakeMall({
      existing: RESERVED_TREE.map((s) => s.id),
    });
    const created = await provisionUserStreams({ mall, userId: 'u1' });
    assert.deepEqual(created, []);
    assert.equal(mall.created.length, 0);
  });

  it('[CP05] is idempotent — re-running on a user with some parents present creates only the missing ones', async () => {
    const mall = fakeMall({
      existing: [':_cmc:', ':_cmc:inbox'], // partial state
    });
    const created = await provisionUserStreams({ mall, userId: 'u1' });
    assert.deepEqual(created, [
      ':_cmc:apps',
      ':_cmc:_internal',
      ':_cmc:_internal:retries',
    ]);
  });

  it('[CP06] propagates non-already-exists errors', async () => {
    const mall = {
      streams: {
        async create () {
          const err = new Error('database unreachable');
          throw err;
        },
      },
    };
    await assert.rejects(provisionUserStreams({ mall, userId: 'u1' }), /database unreachable/);
  });

  it('[CP07] passes accessId through as createdBy / modifiedBy when given', async () => {
    const calls = [];
    const mall = {
      streams: {
        async create (userId, params) {
          calls.push(params);
          return { id: params.id };
        },
      },
    };
    await provisionUserStreams({ mall, userId: 'u1', accessId: 'system' });
    assert.equal(calls[0].createdBy, 'system');
    assert.equal(calls[0].modifiedBy, 'system');
  });

  describe('[CMCPROV-IAE] isAlreadyExistsError matcher', () => {
    it('[CP08] matches err.id', () => {
      assert.equal(isAlreadyExistsError({ id: 'item-already-exists' }), true);
    });

    it('[CP09] matches err.message contains "already exists"', () => {
      assert.equal(isAlreadyExistsError(new Error('stream already exists')), true);
    });

    it('[CP10] matches err.data.id', () => {
      assert.equal(isAlreadyExistsError({ data: { id: 'item-already-exists' } }), true);
    });

    it('[CP11] returns false for unrelated errors', () => {
      assert.equal(isAlreadyExistsError(new Error('database unreachable')), false);
      assert.equal(isAlreadyExistsError(null), false);
    });
  });
});
