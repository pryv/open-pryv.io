/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);

/**
 * Plan 68 Phase C — namespace + event-type constants tests.
 *
 * [CMCCONST] suite covers the stream-id classification predicates
 * (isCmcStreamId, isPluginManagedStreamId, isUserCreatableStreamId)
 * and the per-capability stream-id builders.
 */

const assert = require('node:assert/strict');
const C = require('../../src/cmc/constants.ts');

describe('[CMCCONST] cmc/constants', () => {
  describe('[CMCCONST-NS] namespace classification', () => {
    it('[CC01] isCmcStreamId true for the root + every reserved parent', () => {
      for (const id of C.RESERVED_PARENT_STREAM_IDS) {
        assert.ok(C.isCmcStreamId(id), 'expected isCmcStreamId(' + id + ') === true');
      }
    });

    it('[CC02] isCmcStreamId true for arbitrary children under :_cmc:', () => {
      assert.ok(C.isCmcStreamId(':_cmc:apps:stormm:study-A'));
      assert.ok(C.isCmcStreamId(':_cmc:chats:jane--pryv-me'));
      assert.ok(C.isCmcStreamId(':_cmc:_internal:offer:abc123'));
    });

    it('[CC03] isCmcStreamId false for unrelated streams', () => {
      assert.equal(C.isCmcStreamId(':_system:account'), false);
      assert.equal(C.isCmcStreamId('cmc:inbox'), false); // wrong prefix
      assert.equal(C.isCmcStreamId('user-created'), false);
      assert.equal(C.isCmcStreamId(':_cmc'), true); // accept the bare root form too
    });

    it('[CC04] isPluginManagedStreamId true for reserved parents (NOT :_cmc:apps children)', () => {
      assert.ok(C.isPluginManagedStreamId(':_cmc:inbox'));
      assert.ok(C.isPluginManagedStreamId(':_cmc:chats'));
      assert.ok(C.isPluginManagedStreamId(':_cmc:chats:jane--pryv-me')); // plugin auto-creates
      assert.ok(C.isPluginManagedStreamId(':_cmc:collectors:dr-smith--datasafe-dev--app'));
      assert.ok(C.isPluginManagedStreamId(':_cmc:_internal:retries'));
      assert.ok(C.isPluginManagedStreamId(':_cmc:apps')); // the parent itself
    });

    it('[CC05] isPluginManagedStreamId false for :_cmc:apps children', () => {
      assert.equal(C.isPluginManagedStreamId(':_cmc:apps:stormm'), false);
      assert.equal(C.isPluginManagedStreamId(':_cmc:apps:stormm:study-A'), false);
    });

    it('[CC06] isUserCreatableStreamId only true under :_cmc:apps:', () => {
      assert.ok(C.isUserCreatableStreamId(':_cmc:apps:stormm'));
      assert.ok(C.isUserCreatableStreamId(':_cmc:apps:stormm:study-A'));
      assert.equal(C.isUserCreatableStreamId(':_cmc:apps'), false); // the parent, not a child
      assert.equal(C.isUserCreatableStreamId(':_cmc:inbox'), false);
      assert.equal(C.isUserCreatableStreamId(':_cmc:chats:jane--pryv-me'), false);
    });
  });

  describe('[CMCCONST-BUILD] per-counterparty / per-collector / per-capability builders', () => {
    it('[CB01] chatStreamIdFor builds :_cmc:chats:<slug>', () => {
      assert.equal(C.chatStreamIdFor('jane--pryv-me'), ':_cmc:chats:jane--pryv-me');
    });

    it('[CB02] collectorStreamIdFor builds :_cmc:collectors:<slug>', () => {
      assert.equal(
        C.collectorStreamIdFor('jane--pryv-me--stormm'),
        ':_cmc:collectors:jane--pryv-me--stormm'
      );
    });

    it('[CB03] offerStreamIdFor builds :_cmc:_internal:offer:<capId>', () => {
      assert.equal(C.offerStreamIdFor('abc123'), ':_cmc:_internal:offer:abc123');
    });

    it('[CB04] responsesStreamIdFor builds :_cmc:_internal:responses:<capId>', () => {
      assert.equal(
        C.responsesStreamIdFor('abc123'),
        ':_cmc:_internal:responses:abc123'
      );
    });
  });

  describe('[CMCCONST-ET] event-type catalogues', () => {
    it('[CE01] lifecycle family has 4 event types', () => {
      assert.equal(C.EVENT_TYPES_LIFECYCLE.length, 4);
      assert.deepEqual(new Set(C.EVENT_TYPES_LIFECYCLE), new Set([
        'cmc/request-v1',
        'cmc/accept-v1',
        'cmc/refuse-v1',
        'cmc/revoke-v1',
      ]));
    });

    it('[CE02] chat family has 1 event type', () => {
      assert.deepEqual(C.EVENT_TYPES_CHAT, ['cmc/chat-v1']);
    });

    it('[CE03] system family has 4 event types (alert, ack, scope-request, scope-update)', () => {
      assert.equal(C.EVENT_TYPES_SYSTEM.length, 4);
      assert.deepEqual(new Set(C.EVENT_TYPES_SYSTEM), new Set([
        'cmc/system-alert-v1',
        'cmc/system-ack-v1',
        'cmc/system-scope-request-v1',
        'cmc/system-scope-update-v1',
      ]));
    });

    it('[CE04] ALL_EVENT_TYPES is the union (incl. internal retry-v1) with no duplicates', () => {
      const set = new Set(C.ALL_EVENT_TYPES);
      assert.equal(set.size, C.ALL_EVENT_TYPES.length);
      assert.equal(set.size, 4 + 1 + 4 + 1); // lifecycle + chat + system + retry
      assert.ok(set.has('cmc/retry-v1'));
    });
  });
});
