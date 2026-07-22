/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);

/**
 * CMC plugin — relationship keying.
 *
 * [CMCRK] covers the shared selector both the inbound back-channel matcher
 * and every outbound delivery selector resolve through. Its job is to tell
 * apart two relationships that share a counterparty AND an app-code, which
 * appCode alone cannot do.
 */

const assert = require('node:assert/strict');
const {
  scopeOfAccess,
  scopeOfChannelStream,
  selectRelationshipAccess,
} = require('../src/relationshipKey.ts');

const PEER = { username: 'alice', hostSlug: 'pryv-me' };
const SCOPE_A = ':_cmc:apps:my-app:study-a';
const SCOPE_B = ':_cmc:apps:my-app:study-b';

function access (id, cmc, permissions) {
  return {
    id,
    ...(permissions === undefined ? {} : { permissions }),
    clientData: {
      cmc: {
        role: 'counterparty',
        counterparty: { username: 'alice', host: 'pryv.me' },
        ...cmc,
      },
    },
  };
}

describe('[CMCRK] cmc/relationshipKey', () => {
  describe('[CMCRK-SCOPE] scopeOfChannelStream', () => {
    it('[RK01] extracts the scope from chat and collector streams', () => {
      assert.equal(scopeOfChannelStream(SCOPE_A + ':chats:bob--pryv-me'), SCOPE_A);
      assert.equal(scopeOfChannelStream(SCOPE_A + ':collectors:bob--pryv-me'), SCOPE_A);
    });

    it('[RK02] handles a bare app-root scope with no per-request segment', () => {
      assert.equal(
        scopeOfChannelStream(':_cmc:apps:my-app:chats:bob--pryv-me'),
        ':_cmc:apps:my-app');
    });

    it('[RK03] returns null for anything that is not a channel stream', () => {
      assert.equal(scopeOfChannelStream(':_cmc:inbox'), null);
      assert.equal(scopeOfChannelStream(SCOPE_A), null);
      assert.equal(scopeOfChannelStream(undefined), null);
      assert.equal(scopeOfChannelStream(42), null);
    });
  });

  describe('[CMCRK-OF] scopeOfAccess precedence', () => {
    it('[RK04] prefers the stamped field', () => {
      const a = access('a', {
        scopeStreamId: SCOPE_A,
        counterparty: {
          username: 'alice',
          host: 'pryv.me',
          remoteChatStreamId: SCOPE_B + ':chats:bob--pryv-me',
        },
      }, [{ streamId: SCOPE_B + ':chats:bob--pryv-me', level: 'contribute' }]);
      assert.equal(scopeOfAccess(a), SCOPE_A);
    });

    it('[RK05] derives from the access own channel permissions', () => {
      const a = access('a', {}, [
        { streamId: ':_cmc:inbox', level: 'create-only' },
        { streamId: SCOPE_A + ':chats:bob--pryv-me', level: 'contribute' },
      ]);
      assert.equal(scopeOfAccess(a), SCOPE_A);
    });

    it('[RK06] never infers the local scope from the peer remote pointers', () => {
      // Those name streams on the PEER's account in the peer's own scope —
      // they are a routing target, not a statement about where this access
      // lives, and they are the field the mis-targeting defect overwrites.
      // Returning null is safe: the caller falls back to legacy behaviour.
      const a = access('a', {
        counterparty: {
          username: 'alice',
          host: 'pryv.me',
          remoteChatStreamId: SCOPE_B + ':chats:bob--pryv-me',
          remoteCollectorStreamId: SCOPE_B + ':collectors:bob--pryv-me',
        },
      }, [{ streamId: ':_cmc:inbox', level: 'create-only' }]);
      assert.equal(scopeOfAccess(a), null);
    });

    it('[RK07] returns null for a grant carrying none of the three', () => {
      assert.equal(scopeOfAccess(access('a', {})), null);
      assert.equal(scopeOfAccess(null), null);
      assert.equal(scopeOfAccess({ id: 'x' }), null);
    });
  });

  describe('[CMCRK-SEL] selectRelationshipAccess', () => {
    it('[RK08] picks the access serving the requested scope, not the first match', () => {
      const accesses = [
        access('grant-a', { scopeStreamId: SCOPE_A, appCode: 'my-app' }),
        access('grant-b', { scopeStreamId: SCOPE_B, appCode: 'my-app' }),
      ];
      // Same counterparty, same appCode — only the scope tells them apart.
      assert.equal(
        selectRelationshipAccess({ accesses, counterparty: PEER, scopeStreamId: SCOPE_B, appCode: 'my-app' })?.id,
        'grant-b');
      assert.equal(
        selectRelationshipAccess({ accesses, counterparty: PEER, scopeStreamId: SCOPE_A, appCode: 'my-app' })?.id,
        'grant-a');
    });

    it('[RK09] filters on counterparty identity and role', () => {
      const accesses = [
        access('other-peer', { scopeStreamId: SCOPE_A, counterparty: { username: 'carol', host: 'pryv.me' } }),
        access('capability', { scopeStreamId: SCOPE_A, role: 'capability' }),
        access('right', { scopeStreamId: SCOPE_A }),
      ];
      assert.equal(
        selectRelationshipAccess({ accesses, counterparty: PEER, scopeStreamId: SCOPE_A })?.id,
        'right');
    });

    it('[RK10] matches host by slug', () => {
      const accesses = [access('a', { scopeStreamId: SCOPE_A, counterparty: { username: 'alice', host: 'pryv.me:443' } })];
      assert.equal(
        selectRelationshipAccess({ accesses, counterparty: PEER, scopeStreamId: SCOPE_A })?.id,
        'a');
    });

    it('[RK11] legacy tier: a scope-less grant still resolves (old deployments)', () => {
      const accesses = [access('legacy', { appCode: 'my-app' })];
      assert.equal(
        selectRelationshipAccess({ accesses, counterparty: PEER, scopeStreamId: SCOPE_A, appCode: 'my-app' })?.id,
        'legacy');
    });

    it('[RK12] legacy tier: appCode picks the right candidate when several match', () => {
      const several = [access('other', { appCode: 'other-app' }), access('mine', { appCode: 'my-app' })];
      assert.equal(
        selectRelationshipAccess({ accesses: several, counterparty: PEER, appCode: 'my-app' })?.id,
        'mine');
    });

    it('[RK16] an authoritative appCode mismatch eliminates (outbound)', () => {
      // Outbound, the app-code came from OUR trigger stream-id, so a grant
      // recording a different one really is a different app.
      const one = [access('only', { appCode: 'other-app' })];
      assert.equal(
        selectRelationshipAccess({ accesses: one, counterparty: PEER, appCode: 'my-app' }),
        null);
    });

    it('[RK17] a peer-supplied appCode mismatch never eliminates (inbound back-channel)', () => {
      // The peer derives it independently and falls back to 'unknown';
      // dropping the only candidate here is what leaves a relationship
      // permanently undeliverable.
      const one = [access('only', { appCode: 'my-app' })];
      assert.equal(
        selectRelationshipAccess({
          accesses: one, counterparty: PEER, appCode: 'unknown', appCodeAuthoritative: false,
        })?.id,
        'only');
    });

    it('[RK19] inbound never drops when the scope missed but a stamped candidate exists', () => {
      // Version skew: the peer derived a different scope string than the one
      // stamped on our grant (e.g. an old requester that anchored at the app
      // root while we accepted from a nested stream). The exact tier misses
      // and there are no scope-less candidates — but dropping here would
      // strand the handshake, exactly what the inbound path must never do.
      const accesses = [access('only', { scopeStreamId: SCOPE_A, appCode: 'my-app' })];
      assert.equal(
        selectRelationshipAccess({
          accesses,
          counterparty: PEER,
          scopeStreamId: SCOPE_B,
          appCode: 'my-app',
          appCodeAuthoritative: false,
        })?.id,
        'only');
    });

    it('[RK20] outbound with no scope falls back to appCode-first-match (not a hard null)', () => {
      // findCounterpartyAccessForApp passes appCode but no scope; a stamped
      // grant must still resolve rather than being dropped.
      const accesses = [access('stamped', { scopeStreamId: SCOPE_A, appCode: 'my-app' })];
      assert.equal(
        selectRelationshipAccess({ accesses, counterparty: PEER, appCode: 'my-app' })?.id,
        'stamped');
    });

    it('[RK18] inbound fallback prefers a grant whose back-channel is unset', () => {
      const accesses = [
        access('done', { appCode: 'app-a', backChannelApiEndpoint: 'https://x/' }),
        access('pending', { appCode: 'app-b' }),
      ];
      assert.equal(
        selectRelationshipAccess({
          accesses, counterparty: PEER, appCode: 'app-c', appCodeAuthoritative: false,
        })?.id,
        'pending');
    });

    it('[RK13] refuses to claim a grant that demonstrably serves another relationship', () => {
      // The whole point: silently returning grant-a here is the misrouting
      // that loses consent-revocations.
      const warnings = [];
      const accesses = [access('grant-a', { scopeStreamId: SCOPE_A, appCode: 'my-app' })];
      const r = selectRelationshipAccess({
        accesses,
        counterparty: PEER,
        scopeStreamId: SCOPE_B,
        appCode: 'my-app',
        logger: { warn: (m, c) => warnings.push(c) },
      });
      assert.equal(r, null);
      assert.equal(warnings.length, 1);
      assert.deepEqual(warnings[0].candidateScopes, [SCOPE_A]);
    });

    it('[RK14] prefers the exact scope over a scope-less candidate', () => {
      const accesses = [
        access('legacy', { appCode: 'my-app' }),
        access('exact', { scopeStreamId: SCOPE_A, appCode: 'my-app' }),
      ];
      assert.equal(
        selectRelationshipAccess({ accesses, counterparty: PEER, scopeStreamId: SCOPE_A, appCode: 'my-app' })?.id,
        'exact');
    });

    it('[RK15] returns null when nothing matches the counterparty at all', () => {
      assert.equal(selectRelationshipAccess({ accesses: [], counterparty: PEER, scopeStreamId: SCOPE_A }), null);
      assert.equal(selectRelationshipAccess({ accesses: null, counterparty: PEER }), null);
    });
  });
});
