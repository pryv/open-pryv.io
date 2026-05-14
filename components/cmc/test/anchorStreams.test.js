/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);

/**
 * CMC plugin — anchorStreams.provisionAnchorStreams tests.
 *
 * [CMCAN] covers idempotent four-stream provisioning under the app scope.
 */

const assert = require('node:assert/strict');
const { provisionAnchorStreams } = require('../src/anchorStreams.ts');

function fakeMall (opts = {}) {
  const calls = { streamsCreated: [] };
  return {
    calls,
    streams: {
      async create (_userId, params) {
        calls.streamsCreated.push(params);
        if (opts.alreadyExists && opts.alreadyExists.includes(params.id)) {
          const e = new Error('stream-already-exists');
          e.id = 'stream-already-exists';
          throw e;
        }
        if (opts.failOn && opts.failOn === params.id) {
          throw new Error('boom: ' + params.id);
        }
        return { id: params.id };
      },
    },
  };
}

describe('[CMCAN] cmc/anchorStreams', () => {
  it('[AN01] creates 4 streams: chats parent + chat leaf + collectors parent + collector leaf', async () => {
    const mall = fakeMall();
    const r = await provisionAnchorStreams({
      userId: 'u1',
      scopeStreamId: ':_cmc:apps:my-app:campaign-2026',
      peerSlug: 'alice--pryv-me',
      mall,
    });
    assert.equal(r.ok, true);
    assert.equal(r.created.length, 4);
    const ids = mall.calls.streamsCreated.map((s) => s.id);
    assert.deepEqual(ids, [
      ':_cmc:apps:my-app:campaign-2026:chats',
      ':_cmc:apps:my-app:campaign-2026:collectors',
      ':_cmc:apps:my-app:campaign-2026:chats:alice--pryv-me',
      ':_cmc:apps:my-app:campaign-2026:collectors:alice--pryv-me',
    ]);
  });

  it('[AN02] parentId is set correctly on each stream', async () => {
    const mall = fakeMall();
    await provisionAnchorStreams({
      userId: 'u1',
      scopeStreamId: ':_cmc:apps:my-app',
      peerSlug: 'alice--pryv-me',
      mall,
    });
    const byId = Object.fromEntries(mall.calls.streamsCreated.map((s) => [s.id, s]));
    assert.equal(byId[':_cmc:apps:my-app:chats'].parentId, ':_cmc:apps:my-app');
    assert.equal(byId[':_cmc:apps:my-app:collectors'].parentId, ':_cmc:apps:my-app');
    assert.equal(byId[':_cmc:apps:my-app:chats:alice--pryv-me'].parentId, ':_cmc:apps:my-app:chats');
    assert.equal(byId[':_cmc:apps:my-app:collectors:alice--pryv-me'].parentId, ':_cmc:apps:my-app:collectors');
  });

  it('[AN03] is idempotent — stream-already-exists is treated as success', async () => {
    const mall = fakeMall({
      alreadyExists: [
        ':_cmc:apps:my-app:chats',
        ':_cmc:apps:my-app:collectors',
        ':_cmc:apps:my-app:chats:alice--pryv-me',
      ],
    });
    const r = await provisionAnchorStreams({
      userId: 'u1',
      scopeStreamId: ':_cmc:apps:my-app',
      peerSlug: 'alice--pryv-me',
      mall,
    });
    assert.equal(r.ok, true);
    assert.equal(r.created.length, 4);
  });

  it('[AN04] returns ok:false on non-already-exists failure', async () => {
    const mall = fakeMall({ failOn: ':_cmc:apps:my-app:collectors' });
    const r = await provisionAnchorStreams({
      userId: 'u1',
      scopeStreamId: ':_cmc:apps:my-app',
      peerSlug: 'alice--pryv-me',
      mall,
    });
    assert.equal(r.ok, false);
    assert.equal(r.failedStreamId, ':_cmc:apps:my-app:collectors');
    assert.ok(/boom/.test(r.failureMessage));
  });
});
