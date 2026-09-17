/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);

/**
 * CMC plugin — handleIncomingRevoke tests.
 *
 * [CMCIR] what runs when a peer's consent/revoke-cmc is received:
 *   - enforcement: delete the relationship access the revoke arrived through
 *     (the token the withdrawing peer holds against this account), plus any
 *     sibling access serving the same relationship;
 *   - bookkeeping: on the requester side, mark the single-use invite the
 *     relationship descends from as revoked.
 *
 * Local-only throughout: the handler issues no outbound calls.
 */

const assert = require('node:assert/strict');
const { handleIncomingRevoke } = require('../src/handleIncomingRevoke.ts');

function fakeMall (opts = {}) {
  const accessesById = new Map();
  const eventsById = new Map();
  // `calls.order` records the sequence of mutating calls, so a test can assert
  // that enforcement (delete) precedes bookkeeping (update) and not just that
  // both happened.
  const calls = { accessesUpdated: [], accessesDeleted: [], eventsUpdated: [], order: [] };
  return {
    calls,
    accessesById,
    eventsById,
    accesses: {
      async get () { return [...accessesById.values()]; },
      async update (userId, params) {
        const ex = accessesById.get(params.id);
        const up = { ...ex, ...(params.update || {}) };
        accessesById.set(params.id, up);
        calls.accessesUpdated.push({ id: params.id, update: params.update });
        calls.order.push('update:' + params.id);
        return up;
      },
      async delete (userId, params) {
        if (opts.deleteThrowsFor === params.id) throw new Error('unknown resource');
        calls.accessesDeleted.push(params.id);
        calls.order.push('delete:' + params.id);
        accessesById.delete(params.id);
        return { id: params.id, deleted: true };
      },
    },
    events: {
      async getOne (userId, id) {
        return eventsById.get(id) ?? null;
      },
      async update (userId, event) {
        eventsById.set(event.id, event);
        calls.eventsUpdated.push(event);
        calls.order.push('event:' + event.id);
        return event;
      },
    },
  };
}

function seedInvite (mall, id, content = {}) {
  mall.eventsById.set(id, { id, type: 'consent/request-cmc', content: { status: 'accepted', ...content } });
}
function seedBackChannel (mall, id, cmc) {
  mall.accessesById.set(id, { id, clientData: { cmc: { role: 'counterparty', ...cmc } } });
}
function inviteOf (mall, id) {
  return mall.eventsById.get(id);
}
const SUBJECT = { username: 'alice', host: 'a.example.com' };

describe('[CMCIR] cmc/handleIncomingRevoke', () => {
  it('[CIR1] requester side: marks the single-use invite of the relationship revoked', async () => {
    const mall = fakeMall();
    seedInvite(mall, 'invite-1');
    seedBackChannel(mall, 'bc-1', { capabilityId: 'cap-1', inviteEventId: 'invite-1', counterparty: SUBJECT });
    let notified = 0;
    const res = await handleIncomingRevoke({
      userId: 'u1',
      event: { type: 'consent/revoke-cmc', createdBy: 'bc-1', content: {} },
      deps: { mall, notifyEventChanged: () => { notified++; } },
    });
    assert.equal(res.ok, true);
    assert.equal(res.inviteRevoked, true);
    assert.equal(inviteOf(mall, 'invite-1').content.status, 'revoked');
    assert.equal(typeof inviteOf(mall, 'invite-1').content.revokedAt, 'number');
    assert.deepEqual(res.deletedAccessIds, ['bc-1']);
    assert.equal(notified, 1);
  });

  it('[CIR2] resolves the access id from a "<accessId> <callerId>" createdBy', async () => {
    const mall = fakeMall();
    seedInvite(mall, 'invite-2');
    seedBackChannel(mall, 'bc-2', { capabilityId: 'cap-2', inviteEventId: 'invite-2', counterparty: SUBJECT });
    const res = await handleIncomingRevoke({
      userId: 'u1',
      event: { type: 'consent/revoke-cmc', createdBy: 'bc-2 caller-xyz', content: {} },
      deps: { mall },
    });
    assert.equal(res.inviteRevoked, true);
    assert.equal(inviteOf(mall, 'invite-2').content.status, 'revoked');
  });

  it('[CIR3] a relationship minted before inviteEventId was stamped marks nothing, and is still torn down', async () => {
    const mall = fakeMall();
    seedBackChannel(mall, 'bc-3', { capabilityId: 'cap-3', counterparty: SUBJECT });
    const res = await handleIncomingRevoke({
      userId: 'u1',
      event: { type: 'consent/revoke-cmc', createdBy: 'bc-3', content: {} },
      deps: { mall },
    });
    assert.equal(res.inviteRevoked, false);
    assert.equal(res.reason, 'no-invite-event-id');
    assert.deepEqual(res.deletedAccessIds, ['bc-3']);
    assert.deepEqual(mall.calls.eventsUpdated, []);
  });

  it('[CIR4] an open-link invite is left untouched: the teardown was the un-join', async () => {
    const mall = fakeMall();
    seedInvite(mall, 'invite-4', { status: 'delivered', capability: { mode: 'open-link' } });
    seedBackChannel(mall, 'bc-4', { capabilityId: 'cap-4', inviteEventId: 'invite-4', counterparty: SUBJECT });
    const res = await handleIncomingRevoke({
      userId: 'u1',
      event: { type: 'consent/revoke-cmc', createdBy: 'bc-4', content: {} },
      deps: { mall },
    });
    assert.equal(res.ok, true);
    assert.equal(res.inviteRevoked, false);
    assert.equal(res.reason, 'transition-not-allowed');
    assert.equal(inviteOf(mall, 'invite-4').content.status, 'delivered');
    assert.deepEqual(res.deletedAccessIds, ['bc-4']);
  });

  it('[CIR5] createdBy access is not a counterparty access → no-op', async () => {
    const mall = fakeMall();
    mall.accessesById.set('plain', { id: 'plain', clientData: { cmc: { kind: 'capability' } } });
    const res = await handleIncomingRevoke({
      userId: 'u1',
      event: { type: 'consent/revoke-cmc', createdBy: 'plain', content: {} },
      deps: { mall },
    });
    assert.equal(res.inviteRevoked, false);
    assert.equal(res.reason, 'not-counterparty-access');
    assert.deepEqual(mall.calls.accessesDeleted, []);
  });

  it('[CIR6] missing createdBy → no-op', async () => {
    const mall = fakeMall();
    const res = await handleIncomingRevoke({
      userId: 'u1',
      event: { type: 'consent/revoke-cmc', content: {} },
      deps: { mall },
    });
    assert.equal(res.ok, true);
    assert.equal(res.inviteRevoked, false);
    assert.equal(res.reason, 'no-created-by');
  });

  it('[CIR7] issues no outbound calls (loop-safe): fake fetch is never touched', async () => {
    const mall = fakeMall();
    seedInvite(mall, 'invite-7');
    seedBackChannel(mall, 'bc-7', { capabilityId: 'cap-7', inviteEventId: 'invite-7', counterparty: SUBJECT });
    let fetchCalls = 0;
    const fetch = () => { fetchCalls++; throw new Error('handleIncomingRevoke must not POST'); };
    const res = await handleIncomingRevoke({
      userId: 'u1',
      event: { type: 'consent/revoke-cmc', createdBy: 'bc-7', content: {} },
      deps: { mall, fetch },
    });
    assert.equal(res.inviteRevoked, true);
    // The delete path runs here too (bc-7 is torn down), so this covers the
    // whole handler and not just the bookkeeping half.
    assert.deepEqual(mall.calls.accessesDeleted, ['bc-7']);
    assert.equal(fetchCalls, 0);
  });

  it('[CIR8] accepter side: deletes the access the revoke arrived through, marks no invite', async () => {
    const mall = fakeMall();
    // Direction "requester withdraws", seen by the accepter: the grant this
    // account minted carries no capabilityId key, and its inviteEventId (if
    // any) names the PEER's event.
    seedInvite(mall, 'peer-invite-8');
    seedBackChannel(mall, 'grant-8', {
      counterparty: SUBJECT,
      inviteEventId: 'peer-invite-8',
      scopeStreamId: ':_cmc:apps:my-app:study-a',
    });
    const res = await handleIncomingRevoke({
      userId: 'u1',
      event: { type: 'consent/revoke-cmc', createdBy: 'grant-8', content: {} },
      deps: { mall },
    });
    assert.equal(res.ok, true);
    assert.equal(res.inviteRevoked, false);
    assert.equal(res.reason, 'not-requester-side');
    assert.deepEqual(res.deletedAccessIds, ['grant-8']);
    assert.equal(mall.accessesById.has('grant-8'), false);
    assert.equal(inviteOf(mall, 'peer-invite-8').content.status, 'accepted');
  });

  it('[CIR9] deletes first, then marks the invite', async () => {
    const mall = fakeMall();
    seedInvite(mall, 'invite-9');
    seedBackChannel(mall, 'bc-9', {
      capabilityId: 'cap-9',
      inviteEventId: 'invite-9',
      counterparty: SUBJECT,
      scopeStreamId: ':_cmc:apps:my-app:study-a',
    });
    const res = await handleIncomingRevoke({
      userId: 'u1',
      event: { type: 'consent/revoke-cmc', createdBy: 'bc-9', content: {} },
      deps: { mall },
    });
    assert.equal(res.inviteRevoked, true);
    assert.deepEqual(res.deletedAccessIds, ['bc-9']);
    // Order matters: a crash between the two must leave a stale invite status
    // (cosmetic), never a live token.
    assert.deepEqual(mall.calls.order, ['delete:bc-9', 'event:invite-9']);
  });

  it('[CIR10] sweeps siblings of the same relationship, and only those', async () => {
    const mall = fakeMall();
    const SCOPE = ':_cmc:apps:my-app:study-a';
    seedBackChannel(mall, 'grant-a', { counterparty: SUBJECT, scopeStreamId: SCOPE });
    // Same peer, same scope, minted by an earlier accept: its token is live too.
    seedBackChannel(mall, 'grant-a2', { counterparty: SUBJECT, scopeStreamId: SCOPE });
    // Same peer, DIFFERENT relationship: must survive.
    seedBackChannel(mall, 'grant-b', {
      counterparty: SUBJECT, scopeStreamId: ':_cmc:apps:my-app:study-b',
    });
    // Same peer, no scope at all: unattributable, so never swept.
    seedBackChannel(mall, 'grant-legacy', { counterparty: SUBJECT });
    // Another peer entirely, same scope string: must survive.
    seedBackChannel(mall, 'grant-other', {
      counterparty: { username: 'carol', host: 'c.example.com' }, scopeStreamId: SCOPE,
    });

    const res = await handleIncomingRevoke({
      userId: 'u1',
      event: { type: 'consent/revoke-cmc', createdBy: 'grant-a', content: {} },
      deps: { mall },
    });
    assert.deepEqual(res.deletedAccessIds.sort(), ['grant-a', 'grant-a2']);
    assert.equal(mall.accessesById.has('grant-b'), true);
    assert.equal(mall.accessesById.has('grant-legacy'), true);
    assert.equal(mall.accessesById.has('grant-other'), true);
  });

  it('[CIR11] peer-supplied scope never selects the target; a mismatch only warns', async () => {
    const mall = fakeMall();
    const warns = [];
    seedBackChannel(mall, 'grant-11', {
      counterparty: SUBJECT, scopeStreamId: ':_cmc:apps:my-app:study-a',
    });
    // A grant of a DIFFERENT relationship, named by the peer's content. If the
    // handler selected on content it would delete this one instead.
    seedBackChannel(mall, 'grant-11-other', {
      counterparty: SUBJECT, scopeStreamId: ':_cmc:apps:my-app:study-z',
    });
    const res = await handleIncomingRevoke({
      userId: 'u1',
      event: {
        type: 'consent/revoke-cmc',
        createdBy: 'grant-11',
        content: { scopeStreamId: ':_cmc:apps:my-app:study-z' },
      },
      deps: { mall, logger: { warn: (msg) => warns.push(msg) } },
    });
    assert.deepEqual(res.deletedAccessIds, ['grant-11']);
    assert.equal(mall.accessesById.has('grant-11-other'), true);
    assert.equal(warns.some((m) => String(m).includes('peer-supplied scope differs')), true);
  });

  it('[CIR12] createdBy access already gone → no delete attempted, no-op success', async () => {
    const mall = fakeMall();
    const res = await handleIncomingRevoke({
      userId: 'u1',
      event: { type: 'consent/revoke-cmc', createdBy: 'vanished', content: {} },
      deps: { mall },
    });
    assert.equal(res.ok, true);
    assert.equal(res.reason, 'created-by-access-gone');
    assert.deepEqual(res.deletedAccessIds, []);
    assert.deepEqual(mall.calls.accessesDeleted, []);
  });

  it('[CIR13] a sibling delete that races a local delete is tolerated', async () => {
    const SCOPE = ':_cmc:apps:my-app:study-a';
    const mall = fakeMall({ deleteThrowsFor: 'grant-13b' });
    seedBackChannel(mall, 'grant-13a', { counterparty: SUBJECT, scopeStreamId: SCOPE });
    seedBackChannel(mall, 'grant-13b', { counterparty: SUBJECT, scopeStreamId: SCOPE });
    const res = await handleIncomingRevoke({
      userId: 'u1',
      event: { type: 'consent/revoke-cmc', createdBy: 'grant-13a', content: {} },
      deps: { mall },
    });
    assert.equal(res.ok, true);
    // The one that threw is reported as not deleted rather than claimed.
    assert.deepEqual(res.deletedAccessIds, ['grant-13a']);
  });

  it('[CIR14] a mall without accesses.delete cannot enforce, and says so', async () => {
    // Guards against a wiring site handing the handler a mall that silently
    // skips the teardown while the result still looks successful.
    const mall = fakeMall();
    delete mall.accesses.delete;
    const warns = [];
    seedBackChannel(mall, 'grant-14', { counterparty: SUBJECT, scopeStreamId: ':s' });
    const res = await handleIncomingRevoke({
      userId: 'u1',
      event: { type: 'consent/revoke-cmc', createdBy: 'grant-14', content: {} },
      deps: { mall, logger: { warn: (msg) => warns.push(msg) } },
    });
    assert.deepEqual(res.deletedAccessIds, []);
    assert.equal(warns.some((m) => String(m).includes('was NOT torn down')), true);
  });

  describe('[CMCIR-ENRICH] the arrival is enriched with ids this side holds', () => {
    // The revoke names the SENDER's access id, which this account never saw.
    // The receiver adds its own handles for the relationship so an app can
    // join the withdrawal to the invite it knows about.
    function mallWithEvent (event) {
      const m = fakeMall();
      m.eventsById.set(event.id, event);
      m.calls.eventsUpdated = [];
      m.events.update = async (userId, params) => {
        m.eventsById.set(params.id, params);
        m.calls.eventsUpdated.push(params);
        return params;
      };
      return m;
    }

    it('[CIR15] requester side: back-channel id, invite id, own scope, revoked ids', async () => {
      const event = {
        id: 'evt-revoke-1',
        type: 'consent/revoke-cmc',
        streamIds: [':_cmc:inbox'],
        createdBy: 'bc-15',
        content: { from: SUBJECT, accessId: 'sender-side-id', status: 'delivered' },
      };
      const mall = mallWithEvent(event);
      seedBackChannel(mall, 'bc-15', {
        capabilityId: 'cap-15',
        counterparty: SUBJECT,
        scopeStreamId: ':_cmc:apps:my-app:study-a',
        inviteEventId: 'invite-evt-1',
      });
      let notified = 0;
      const res = await handleIncomingRevoke({
        userId: 'u1',
        event,
        deps: { mall, notifyEventChanged: () => { notified++; } },
      });
      assert.equal(res.enriched, true);
      const written = mall.calls.eventsUpdated.at(-1).content;
      assert.equal(written.backChannelAccessId, 'bc-15');
      assert.equal(written.inviteEventId, 'invite-evt-1');
      assert.equal(written.scopeStreamId, ':_cmc:apps:my-app:study-a');
      assert.deepEqual(written.revokedAccessIds, ['bc-15']);
      // The sender's own id and the delivery status survive untouched.
      assert.equal(written.accessId, 'sender-side-id');
      assert.equal(written.status, 'delivered');
      assert.equal(notified, 1);
    });

    it('[CIR16] accepter side: data-grant id and the offer / accept trigger ids', async () => {
      const event = {
        id: 'evt-revoke-2',
        type: 'consent/revoke-cmc',
        streamIds: [':_cmc:inbox'],
        createdBy: 'grant-16',
        content: { from: SUBJECT },
      };
      const mall = mallWithEvent(event);
      seedBackChannel(mall, 'grant-16', {
        counterparty: SUBJECT,
        scopeStreamId: ':_cmc:apps:my-app:study-a',
        offerEventId: 'offer-evt-1',
        acceptEventId: 'accept-evt-1',
      });
      const res = await handleIncomingRevoke({
        userId: 'u1', event, deps: { mall },
      });
      assert.equal(res.enriched, true);
      const written = mall.calls.eventsUpdated.at(-1).content;
      assert.equal(written.dataGrantAccessId, 'grant-16');
      assert.equal(written.offerEventId, 'offer-evt-1');
      assert.equal(written.acceptEventId, 'accept-evt-1');
      // No capability on this side, so no back-channel id is claimed.
      assert.equal('backChannelAccessId' in written, false);
    });

    it('[CIR17] unresolvable ids are left out, and peer-supplied values are not erased', async () => {
      const event = {
        id: 'evt-revoke-3',
        type: 'consent/revoke-cmc',
        streamIds: [':_cmc:inbox'],
        createdBy: 'grant-17',
        // The peer sent an offerEventId; ours is unknown. Overwriting theirs
        // with nothing would lose the only correlation the arrival had.
        content: { from: SUBJECT, offerEventId: 'peer-supplied-offer' },
      };
      const mall = mallWithEvent(event);
      seedBackChannel(mall, 'grant-17', { counterparty: SUBJECT });
      const res = await handleIncomingRevoke({
        userId: 'u1', event, deps: { mall },
      });
      assert.equal(res.enriched, true);
      const written = mall.calls.eventsUpdated.at(-1).content;
      assert.equal(written.offerEventId, 'peer-supplied-offer');
      assert.equal('inviteEventId' in written, false);
      assert.equal('acceptEventId' in written, false);
      // No scope on the access, so none is claimed.
      assert.equal('scopeStreamId' in written, false);
    });

    it('[CIR19] a relationship too old to carry either stamp gets no side label', async () => {
      // A back-channel minted before capabilityId was stamped has neither key.
      // Guessing "accepter" there would put a dataGrantAccessId naming the
      // requester's OWN back-channel into a public arrival shape: a field that
      // is not merely missing but false. Label nothing; the scope and the
      // revoked ids still carry.
      const event = {
        id: 'evt-revoke-5',
        type: 'consent/revoke-cmc',
        streamIds: [':_cmc:inbox'],
        createdBy: 'legacy-19',
        content: { from: SUBJECT },
      };
      const mall = mallWithEvent(event);
      seedBackChannel(mall, 'legacy-19', {
        counterparty: SUBJECT,
        scopeStreamId: ':_cmc:apps:my-app:study-a',
      });
      await handleIncomingRevoke({ userId: 'u1', event, deps: { mall } });
      const written = mall.calls.eventsUpdated.at(-1).content;
      assert.equal('dataGrantAccessId' in written, false);
      assert.equal('backChannelAccessId' in written, false);
      assert.equal(written.scopeStreamId, ':_cmc:apps:my-app:study-a');
      assert.deepEqual(written.revokedAccessIds, ['legacy-19']);
    });

    it('[CIR21] peer-supplied values for the fields we own are dropped, not kept', async () => {
      // These describe the RECEIVING account, so a value the peer put there is
      // meaningless. On a relationship we cannot label, a merge would otherwise
      // leave the peer's claim standing and an app would read it as ours.
      const event = {
        id: 'evt-revoke-7',
        type: 'consent/revoke-cmc',
        streamIds: [':_cmc:inbox'],
        createdBy: 'legacy-21',
        content: {
          from: SUBJECT,
          backChannelAccessId: 'peer-made-this-up',
          dataGrantAccessId: 'peer-made-this-up-too',
          revokedAccessIds: ['not-ours'],
        },
      };
      const mall = mallWithEvent(event);
      seedBackChannel(mall, 'legacy-21', { counterparty: SUBJECT });
      await handleIncomingRevoke({ userId: 'u1', event, deps: { mall } });
      const written = mall.calls.eventsUpdated.at(-1).content;
      assert.equal('backChannelAccessId' in written, false);
      assert.equal('dataGrantAccessId' in written, false);
      assert.deepEqual(written.revokedAccessIds, ['legacy-21']);
    });

    it('[CIR20] a non-open-link back-channel is still the requester side', async () => {
      // capabilityId is present but null for a relationship that did not come
      // through a capability. The key is the signal, not its value.
      const event = {
        id: 'evt-revoke-6',
        type: 'consent/revoke-cmc',
        streamIds: [':_cmc:inbox'],
        createdBy: 'bc-20',
        content: { from: SUBJECT },
      };
      const mall = mallWithEvent(event);
      seedBackChannel(mall, 'bc-20', { capabilityId: null, counterparty: SUBJECT });
      await handleIncomingRevoke({ userId: 'u1', event, deps: { mall } });
      const written = mall.calls.eventsUpdated.at(-1).content;
      assert.equal(written.backChannelAccessId, 'bc-20');
      assert.equal('dataGrantAccessId' in written, false);
    });

    it('[CIR18] the invite id falls back to the capability access for a legacy relationship', async () => {
      const event = {
        id: 'evt-revoke-4',
        type: 'consent/revoke-cmc',
        streamIds: [':_cmc:inbox'],
        createdBy: 'bc-18',
        content: { from: SUBJECT },
      };
      const mall = mallWithEvent(event);
      // Back-channel minted before the invite stamp existed: no inviteEventId
      // on the access, but the capability it points at still has it.
      seedBackChannel(mall, 'bc-18', { capabilityId: 'cap-18', counterparty: SUBJECT });
      mall.accessesById.set('cap-acc-18', {
        id: 'cap-acc-18',
        clientData: {
          cmc: {
            kind: 'capability',
            capabilityId: 'cap-18',
            requestEventId: 'legacy-invite-1',
            capability: { mode: 'open-link', state: 'open' },
          },
        },
      });
      await handleIncomingRevoke({ userId: 'u1', event, deps: { mall } });
      const written = mall.calls.eventsUpdated.at(-1).content;
      assert.equal(written.inviteEventId, 'legacy-invite-1');
    });
  });
});
