/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);

/**
 * CMC plugin — namespace + event-type constants tests.
 *
 * [CMCCONST] covers stream-id classification predicates, per-counterparty
 * / per-capability builders, app-code extraction, and event-type catalogues.
 */

const assert = require('node:assert/strict');
const C = require('../src/constants.ts');

describe('[CMCCONST] cmc/constants', () => {
  describe('[CMCCONST-NS] namespace classification', () => {
    it('[CC01] isCmcStreamId true for every reserved parent', () => {
      for (const id of C.RESERVED_PARENT_STREAM_IDS) {
        assert.ok(C.isCmcStreamId(id), 'expected isCmcStreamId(' + id + ') === true');
      }
    });

    it('[CC02] isCmcStreamId true for arbitrary children under :_cmc:', () => {
      assert.ok(C.isCmcStreamId(':_cmc:apps:my-app:study'));
      assert.ok(C.isCmcStreamId(':_cmc:apps:my-app:chats:alice--example-com'));
      assert.ok(C.isCmcStreamId(':_cmc:_internal:offer:abc123'));
    });

    it('[CC03] isCmcStreamId false for unrelated streams', () => {
      assert.equal(C.isCmcStreamId(':_system:account'), false);
      assert.equal(C.isCmcStreamId('cmc:inbox'), false); // wrong prefix
      assert.equal(C.isCmcStreamId('user-created'), false);
      assert.equal(C.isCmcStreamId(':_cmc'), true); // bare root variant accepted
    });

    it('[CC04] isAppNestedPluginStream matches chats / collectors anywhere under :_cmc:apps:', () => {
      // Flat under app
      assert.ok(C.isAppNestedPluginStream(':_cmc:apps:my-app:chats'));
      assert.ok(C.isAppNestedPluginStream(':_cmc:apps:my-app:chats:alice--example-com'));
      assert.ok(C.isAppNestedPluginStream(':_cmc:apps:my-app:collectors'));
      assert.ok(C.isAppNestedPluginStream(':_cmc:apps:my-app:collectors:alice--example-com'));
      // Nested under a user-chosen path
      assert.ok(C.isAppNestedPluginStream(':_cmc:apps:my-app:study-A:chats'));
      assert.ok(C.isAppNestedPluginStream(':_cmc:apps:my-app:study-A:chats:alice--example-com'));
      assert.ok(C.isAppNestedPluginStream(':_cmc:apps:my-app:study-A:collectors:alice--example-com'));
    });

    it('[CC05] isAppNestedPluginStream false for non-matching paths', () => {
      assert.equal(C.isAppNestedPluginStream(':_cmc:apps:my-app'), false);
      assert.equal(C.isAppNestedPluginStream(':_cmc:apps:my-app:study-A'), false);
      // Different segment name that contains "chats" as a substring
      assert.equal(C.isAppNestedPluginStream(':_cmc:apps:my-app:chatsdata'), false);
      assert.equal(C.isAppNestedPluginStream(':_cmc:inbox'), false);
    });

    it('[CC06] isUserCreatableStreamId allows arbitrary children under :_cmc:apps: except chats/collectors', () => {
      assert.ok(C.isUserCreatableStreamId(':_cmc:apps:my-app'));
      assert.ok(C.isUserCreatableStreamId(':_cmc:apps:my-app:study-A'));
      assert.ok(C.isUserCreatableStreamId(':_cmc:apps:my-app:study-A:notes'));
      // Plugin-reserved segments rejected
      assert.equal(C.isUserCreatableStreamId(':_cmc:apps:my-app:chats'), false);
      assert.equal(C.isUserCreatableStreamId(':_cmc:apps:my-app:chats:alice--example-com'), false);
      assert.equal(C.isUserCreatableStreamId(':_cmc:apps:my-app:study-A:collectors'), false);
      // Outside :_cmc:apps:
      assert.equal(C.isUserCreatableStreamId(':_cmc:inbox'), false);
      assert.equal(C.isUserCreatableStreamId(':_cmc:apps'), false); // the parent itself
    });

    it('[CC07] isPluginManagedStreamId is the complement of isUserCreatableStreamId inside :_cmc:', () => {
      const pluginManaged = [
        ':_cmc:',
        ':_cmc:inbox',
        ':_cmc:apps',
        ':_cmc:_internal',
        ':_cmc:_internal:retries',
        ':_cmc:_internal:offer:abc',
        ':_cmc:apps:my-app:chats',
        ':_cmc:apps:my-app:chats:alice--example-com',
        ':_cmc:apps:my-app:study-A:collectors:alice--example-com',
      ];
      for (const id of pluginManaged) {
        assert.ok(C.isPluginManagedStreamId(id), 'expected plugin-managed for ' + id);
      }
      const userCreatable = [
        ':_cmc:apps:my-app',
        ':_cmc:apps:my-app:study-A',
        ':_cmc:apps:my-app:study-A:notes',
      ];
      for (const id of userCreatable) {
        assert.equal(C.isPluginManagedStreamId(id), false, 'expected user-creatable for ' + id);
      }
    });
  });

  describe('[CMCCONST-APP] getAppCode', () => {
    it('[CC08] extracts the app-code segment for any :_cmc:apps:<app-code> id', () => {
      assert.equal(C.getAppCode(':_cmc:apps:my-app'), 'my-app');
      assert.equal(C.getAppCode(':_cmc:apps:my-app:study-A'), 'my-app');
      assert.equal(C.getAppCode(':_cmc:apps:my-app:study-A:chats:alice--example-com'), 'my-app');
    });

    it('[CC09] returns null for ids outside :_cmc:apps:', () => {
      assert.equal(C.getAppCode(':_cmc:inbox'), null);
      assert.equal(C.getAppCode('fertility'), null);
      assert.equal(C.getAppCode(':_cmc:apps'), null);
    });
  });

  describe('[CMCCONST-BUILD] stream-id builders', () => {
    it('[CC10] chatsParentUnder + chatStreamUnder append :chats / :chats:<slug>', () => {
      const base = ':_cmc:apps:my-app:study-A';
      assert.equal(C.chatsParentUnder(base), ':_cmc:apps:my-app:study-A:chats');
      assert.equal(
        C.chatStreamUnder(base, 'alice--example-com'),
        ':_cmc:apps:my-app:study-A:chats:alice--example-com'
      );
    });

    it('[CC11] collectorsParentUnder + collectorStreamUnder append :collectors / :collectors:<slug>', () => {
      const base = ':_cmc:apps:my-app';
      assert.equal(C.collectorsParentUnder(base), ':_cmc:apps:my-app:collectors');
      assert.equal(
        C.collectorStreamUnder(base, 'alice--example-com'),
        ':_cmc:apps:my-app:collectors:alice--example-com'
      );
    });

    it('[CC12] offerStreamIdFor / responsesStreamIdFor build per-capability stream-ids', () => {
      assert.equal(C.offerStreamIdFor('abc123'), ':_cmc:_internal:offer:abc123');
      assert.equal(C.responsesStreamIdFor('abc123'), ':_cmc:_internal:responses:abc123');
    });
  });

  describe('[CMCCONST-ET] event-type catalogues', () => {
    it('[CE01] lifecycle family has 5 event types (incl. back-channel post-acceptance handshake)', () => {
      assert.deepEqual(new Set(C.EVENT_TYPES_LIFECYCLE), new Set([
        'consent/request-cmc', 'consent/accept-cmc', 'consent/refuse-cmc', 'consent/revoke-cmc',
        'consent/back-channel-cmc',
      ]));
    });

    it('[CE02] chat family has 1 event type', () => {
      assert.deepEqual(C.EVENT_TYPES_CHAT, ['message/chat-cmc']);
    });

    it('[CE03] system family has 4 event types', () => {
      assert.deepEqual(new Set(C.EVENT_TYPES_SYSTEM), new Set([
        'notification/alert-cmc', 'notification/ack-cmc',
        'consent/scope-request-cmc', 'consent/scope-update-cmc',
      ]));
    });

    it('[CE04] ALL_EVENT_TYPES is the union (incl. internal retry-v1 + back-channel + invalidate-link) with no duplicates', () => {
      const set = new Set(C.ALL_EVENT_TYPES);
      assert.equal(set.size, C.ALL_EVENT_TYPES.length);
      // 5 lifecycle + 1 chat + 4 system + 1 capability + 1 retry
      assert.equal(set.size, 5 + 1 + 4 + 1 + 1);
      assert.ok(set.has('cmc-internal/retry-cmc'));
      assert.ok(set.has('consent/back-channel-cmc'));
      assert.ok(set.has('consent/invalidate-link-cmc'));
    });

    it('[CE05] capability family has 1 event type (consent/invalidate-link-cmc)', () => {
      assert.deepEqual(C.EVENT_TYPES_CAPABILITY, ['consent/invalidate-link-cmc']);
    });
  });

  describe('[CMCCONST-RESERVED] RESERVED_PARENT_STREAM_IDS', () => {
    it('[CC13] has exactly the five reserved parents', () => {
      assert.deepEqual(C.RESERVED_PARENT_STREAM_IDS, [
        ':_cmc:',
        ':_cmc:inbox',
        ':_cmc:apps',
        ':_cmc:_internal',
        ':_cmc:_internal:retries',
      ]);
    });

    it('[CC14] APP_RESERVED_SEGMENTS lists chats + collectors', () => {
      assert.deepEqual([...C.APP_RESERVED_SEGMENTS], ['chats', 'collectors']);
    });
  });
});
