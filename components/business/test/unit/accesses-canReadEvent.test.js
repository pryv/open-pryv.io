/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */

import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
/**
 * Unit tests for the grants part of the single-event read rule, shared by the
 * write methods by id: forced streams are judged per store, for every store
 * the event's streams belong to.
 */

const assert = require('node:assert/strict');

const { canReadEvent, isEventHiddenByGrants } = require('../../src/accesses/canReadEvent.ts');

/**
 * A stub access: reads every stream, forbids none, carries `forcedByStore`,
 * and knows which (store, stream) sits within which forced stream.
 */
function stubAccess ({ personal = false, forcedByStore = {}, within = [] } = {}) {
  return {
    isPersonal: () => personal,
    canGetEventsOnStream: async () => true,
    isStreamForbiddenForReading: async () => false,
    getForcedStreamsGetEventsStreamIds: (storeId) => forcedByStore[storeId] ?? null,
    isStreamWithin: async (storeId, streamId, ancestorId) =>
      streamId === ancestorId || within.some(([s, id, a]) => s === storeId && id === streamId && a === ancestorId)
  };
}

describe('[CRFS] forced streams are judged in every store of the event', () => {
  it('[CRF1] a forced stream of a store that is not the first stream\'s store hides the event', async () => {
    const access = stubAccess({ forcedByStore: { dummy: ['forced'] } });
    const streamIds = ['a', ':dummy:b'];
    assert.equal(await isEventHiddenByGrants(access, streamIds), true);
    assert.equal(await canReadEvent(access, { streamIds }), false);
  });

  it('[CRF2] the event is visible when its stream in that store is within the forced stream', async () => {
    const access = stubAccess({ forcedByStore: { dummy: ['forced'] }, within: [['dummy', 'b', 'forced']] });
    const streamIds = ['a', ':dummy:b'];
    assert.equal(await isEventHiddenByGrants(access, streamIds), false);
    assert.equal(await canReadEvent(access, { streamIds }), true);
  });

  it('[CRF3] a stream of another store does not satisfy a forced stream of the local store', async () => {
    const access = stubAccess({ forcedByStore: { local: ['forced'] }, within: [['dummy', 'b', 'forced']] });
    const streamIds = [':dummy:b', 'a'];
    assert.equal(await isEventHiddenByGrants(access, streamIds), true);
    assert.equal(await canReadEvent(access, { streamIds }), false);
  });

  it('[CRF4] a personal access is never hidden by grants', async () => {
    const access = stubAccess({ personal: true, forcedByStore: { local: ['forced'] } });
    assert.equal(await isEventHiddenByGrants(access, ['a']), false);
    assert.equal(await canReadEvent(access, { streamIds: ['a'] }), true);
  });
});
