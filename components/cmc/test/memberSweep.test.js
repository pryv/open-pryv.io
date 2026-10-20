/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);

/**
 * CMC plugin, group accounts: offboarding.
 *
 * [CMCMR] covers the sweep of a member's children through the patients'
 * grants (every verdict and the read-back), the server-written
 * `consent/member-revoke-cmc` and its handler, the one entry point from every
 * path a membership ends on (revoke by the group, the member leaving, the
 * route delete, a narrowed membership, the periodic pass for an expired or
 * vanished membership, the account's deletion), the relationship-end pass
 * that sweeps before the revoke is delivered, and the retry of a residual.
 */

const assert = require('node:assert/strict');
const C = require('../src/constants.ts');
const { CmcErrorIds } = require('../src/errorIds.ts');
const ledger = require('../src/memberLedger.ts');
const { handleMemberRevoke, revokeRecords } = require('../src/handleMemberRevoke.ts');
const { createMemberSweep, sweepStreamOf } = require('../src/memberSweep.ts');
const { handleRevoke } = require('../src/handleRevoke.ts');
const { handleIncomingRevoke } = require('../src/handleIncomingRevoke.ts');
const { createAccessesDeletePostHook } = require('../src/accessesDeleteHook.ts');
const { createAccessesUpdatePostHook, createStreamDeleteNarrowing } = require('../src/accessesUpdateHook.ts');
const dispatchMod = require('../src/dispatch.ts');
const { startRetryLoopIfEnabled } = require('../src/bootRetryLoop.ts');
const { assertOutboundUrl, fakeUpdateWithMerge } = require('./_fake-assertions.cjs');

const GROUP = { username: 'practice', host: 'group.example.com' };
const MEMBER = { username: 'dr-amy', host: 'member.example.com' };
const PATIENT = { username: 'pat', host: 'patient.example.com' };
const PATIENT2 = { username: 'pat2', host: 'patient.example.com' };
const TEAM = ':_cmc:apps:practice:team-a';
const TEAM_B = ':_cmc:apps:practice:team-b';
const GRANT = 'https://grant-tok@patient.example.com/';
const GRANT2 = 'https://grant2-tok@patient.example.com/';
// The dispatch hands the handler the real clock: a fixture in the future
// must be in the future for it too.
const NOW = Math.floor(Date.now() / 1000);

const MEMBERSHIP = {
  id: 'acc-membership',
  type: 'shared',
  permissions: [{ streamId: TEAM, level: 'contribute' }, { streamId: ':_cmc:inbox', level: 'create-only' }],
  clientData: { cmc: { role: 'member', appCode: 'practice', scopeStreamId: TEAM, counterparty: { ...MEMBER, apiEndpoint: 'https://m-bc@member.example.com/' } } },
};
const REL = {
  id: 'acc-rel',
  type: 'shared',
  clientData: { cmc: { role: 'counterparty', appCode: 'practice', scopeStreamId: TEAM, counterparty: { ...PATIENT, apiEndpoint: GRANT } } },
};
const REL2 = {
  id: 'acc-rel2',
  type: 'shared',
  clientData: { cmc: { role: 'counterparty', appCode: 'practice', scopeStreamId: TEAM_B, counterparty: { ...PATIENT2, apiEndpoint: GRANT2 } } },
};

function fakeMall (opts = {}) {
  const accesses = new Map((opts.accesses ?? [MEMBERSHIP, REL, REL2]).map((a) => [a.id, a]));
  const events = new Map();
  const calls = { eventsCreated: [], eventsUpdated: [], eventsDeleted: [], accessesDeleted: [] };
  let seq = 0;
  return {
    calls,
    accessesMap: accesses,
    eventsMap: events,
    accesses: {
      async get () { return [...accesses.values()]; },
      async getOne (u, { id }) { return accesses.get(id) ?? null; },
      async delete (u, { id }) { calls.accessesDeleted.push(id); accesses.delete(id); },
    },
    events: {
      async create (u, p) { const id = p.id ?? ('ev-' + (++seq)); const ev = { ...p, id }; events.set(id, ev); calls.eventsCreated.push(ev); return ev; },
      async get (u, p) {
        const any = p?.streams?.[0]?.any;
        return [...events.values()].filter((e) => !Array.isArray(any) || (e.streamIds ?? []).some((s) => any.includes(s)));
      },
      async getOne (u, id) { return events.get(id) ?? null; },
      async updateWithMerge (...a) { return fakeUpdateWithMerge(this, ...a); },
      async update (u, e) { events.set(e.id, e); calls.eventsUpdated.push(e); return e; },
      async delete (u, e) { events.delete(e.id); calls.eventsDeleted.push(e.id); },
    },
    streams: { async create (u, p) { return { id: p.id }; } },
  };
}

/** A patient core answering DELETE /accesses/<id> and GET /accesses from `plan`. */
function fakeCores (plan = {}) {
  const calls = [];
  return {
    calls,
    fetch (url, init) {
      assertOutboundUrl(url, init);
      const u = new URL(url);
      const method = (init?.method ?? 'GET').toUpperCase();
      const token = init?.headers?.authorization;
      calls.push({ method, path: u.pathname + u.search, token });
      let spec;
      if (method === 'DELETE') {
        const id = decodeURIComponent(u.pathname.split('/').pop());
        spec = (plan.deletes ?? {})[id] ?? { status: 200, body: { accessDeletion: { id } } };
      } else if (method === 'GET') {
        const remaining = (plan.remaining ?? {})[token] ?? [];
        spec = plan.listFails ? { status: 503, body: null } : { status: 200, body: { accesses: remaining.map((id) => ({ id })) } };
      }
      if (spec instanceof Error) return Promise.reject(spec);
      return Promise.resolve({ status: spec.status, ok: spec.status >= 200 && spec.status < 300, async json () { return spec.body; }, async text () { return JSON.stringify(spec.body); } });
    },
  };
}

async function seed (mall, over = {}) {
  const rec = {
    membershipAccessId: 'acc-membership',
    member: MEMBER,
    relationshipAccessId: 'acc-rel',
    counterparty: PATIENT,
    scopeStreamId: TEAM,
    childAccessId: 'child-1',
    childName: 'n',
    expires: NOW + 3600,
    attribution: 'stamped',
    state: 'live',
    stateChangedAt: 1,
    ...over,
  };
  const id = await ledger.writeRecord({ mall, now: () => NOW }, 'group', rec);
  return { ...rec, eventId: id };
}

function revokeDeps (mall, cores, over = {}) {
  return { mall, fetch: cores.fetch, now: () => NOW, ...over };
}

describe('[CMCMR] cmc group accounts: offboarding', () => {
  describe('[CMCMR-REC] sweeping records through the grants', () => {
    it('[MR43] each child is deleted through its relationship grant; the ledger says deleted; the read-back confirms', async () => {
      const mall = fakeMall();
      const r1 = await seed(mall);
      const r2 = await seed(mall, { relationshipAccessId: 'acc-rel2', counterparty: PATIENT2, scopeStreamId: TEAM_B, childAccessId: 'child-2' });
      const cores = fakeCores();
      const r = await revokeRecords({ userId: 'group', records: [r1, r2], deps: revokeDeps(mall, cores) });
      assert.deepEqual(r.outcome, [{ childAccessId: 'child-1', result: 'deleted' }, { childAccessId: 'child-2', result: 'deleted' }]);
      assert.deepEqual(r.residuals, []);
      assert.deepEqual(cores.calls.map((c) => c.method + ' ' + c.path + ' ' + c.token), [
        'DELETE /accesses/child-1 grant-tok', 'DELETE /accesses/child-2 grant2-tok',
        'GET /accesses?includeExpired=true grant-tok', 'GET /accesses?includeExpired=true grant2-tok',
      ]);
      assert.deepEqual((await ledger.listRecords({ mall }, 'group')).map((x) => x.state), ['deleted', 'deleted']);
    });

    it('[MR44] verdicts: a 404 or a dead grant is absent, a 5xx or a network error a residual; the read-back settles an expired residual as absent and a deletion still listed as residual', async () => {
      const mall = fakeMall();
      const rows = [];
      for (const id of ['c-404', 'c-401', 'c-503', 'c-net', 'c-listed']) rows.push(await seed(mall, { childAccessId: id }));
      const cores = fakeCores({
        deletes: {
          'c-404': { status: 404, body: { error: { id: 'unknown-resource' } } },
          'c-401': { status: 403, body: { error: { id: 'invalid-access-token' } } },
          'c-503': { status: 503, body: { error: { id: 'x' }, token: 'leak' } },
          'c-net': new Error('ECONNRESET'),
        },
        remaining: { 'grant-tok': ['c-listed', 'c-net'] },
      });
      const r = await revokeRecords({ userId: 'group', records: rows, deps: revokeDeps(mall, cores) });
      const by = Object.fromEntries(r.outcome.map((o) => [o.childAccessId, o]));
      assert.deepEqual(by['c-404'], { childAccessId: 'c-404', result: 'absent', reason: 'not-found' });
      assert.deepEqual(by['c-401'], { childAccessId: 'c-401', result: 'absent', reason: 'grant-gone' });
      assert.deepEqual(by['c-503'], { childAccessId: 'c-503', result: 'absent', reason: 'not-listed' }, 'not listed any more: absent');
      assert.deepEqual(by['c-net'], { childAccessId: 'c-net', result: 'residual', reason: 'network' });
      assert.deepEqual(by['c-listed'], { childAccessId: 'c-listed', result: 'residual', reason: 'still-listed' });
      assert.deepEqual(r.residuals.map((x) => x.childAccessId).sort(), ['c-listed', 'c-net']);
      assert.equal(JSON.stringify(r).includes('leak'), false, 'no peer body');
      const states = Object.fromEntries((await ledger.listRecords({ mall }, 'group')).map((x) => [x.childAccessId, x.state]));
      assert.deepEqual(states, { 'c-404': 'absent', 'c-401': 'absent', 'c-503': 'absent', 'c-net': 'residual', 'c-listed': 'residual' });
    });

    it('[MR44b] a refused destination leaves the child residual with reason refused (nothing can be concluded about it)', async () => {
      const mall = fakeMall();
      const rows = [await seed(mall, { childAccessId: 'c-ref' })];
      const refusal = Object.assign(new Error("peer call refused: address, host '10.0.0.1'"), { code: 'EPEERREFUSED', kind: 'address', host: '10.0.0.1' });
      const cores = fakeCores({ deletes: { 'c-ref': refusal }, remaining: { 'grant-tok': ['c-ref'] } });
      const r = await revokeRecords({ userId: 'group', records: rows, deps: revokeDeps(mall, cores) });
      assert.deepEqual(r.outcome, [{ childAccessId: 'c-ref', result: 'residual', reason: 'refused' }]);
      assert.deepEqual(r.residuals.map((x) => x.reason), ['refused']);
    });

    it('[MR45] a record whose relationship is gone, or whose child expired, is settled absent without a call; a settled record is skipped', async () => {
      const mall = fakeMall({ accesses: [MEMBERSHIP] });
      const gone = await seed(mall);
      const mall2 = fakeMall();
      const expired = await seed(mall2, { childAccessId: 'old', expires: NOW - 1 });
      const done = await seed(mall2, { childAccessId: 'done', state: 'deleted' });
      const cores = fakeCores();
      let r = await revokeRecords({ userId: 'group', records: [gone], deps: revokeDeps(mall, cores) });
      assert.deepEqual(r.outcome, [{ childAccessId: 'child-1', result: 'absent', reason: 'relationship-gone' }]);
      r = await revokeRecords({ userId: 'group', records: [expired, done], deps: revokeDeps(mall2, cores) });
      assert.deepEqual(r.outcome, [{ childAccessId: 'old', result: 'absent', reason: 'expired' }]);
      assert.equal(cores.calls.length, 0);
    });
  });

  describe('[CMCMR-HANDLER] consent/member-revoke-cmc', () => {
    function triggerFor (records) {
      return { id: 'sweep-1', type: C.ET_MEMBER_REVOKE, streamIds: [TEAM], content: { member: MEMBER, membershipAccessId: 'acc-membership', reason: 'revoke', records, status: 'pending' } };
    }

    it('[MR10] the outcome and the residuals are stamped on the trigger; a residual fails it with a bounded detail; records added meanwhile are swept in the same run', async () => {
      const mall = fakeMall();
      const r1 = await seed(mall);
      mall.eventsMap.set('sweep-1', triggerFor([{ relationshipAccessId: 'acc-rel', counterparty: PATIENT, childAccessId: 'child-1', expires: NOW + 3600 }]));
      let raced = false;
      const cores = fakeCores({ deletes: { 'child-1': { status: 503, body: { secret: 'leak' } } }, remaining: { 'grant-tok': ['child-1'] } });
      const origFetch = cores.fetch;
      cores.fetch = async (url, init) => {
        if (!raced) { raced = true; await seed(mall, { childAccessId: 'child-late', relationshipAccessId: 'acc-rel2', counterparty: PATIENT2, scopeStreamId: TEAM_B }); }
        return origFetch(url, init);
      };
      const r = await handleMemberRevoke({ userId: 'group', triggerEvent: triggerFor(mall.eventsMap.get('sweep-1').content.records), deps: revokeDeps(mall, cores) });
      assert.equal(r.ok, false);
      assert.equal(r.reason, CmcErrorIds.MEMBER_REVOKE_RESIDUAL);
      assert.deepEqual(r.detail, { childAccessId: 'child-1', httpStatus: 503 });
      assert.deepEqual(r.outcome.map((o) => o.childAccessId + ':' + o.result).sort(), ['child-1:residual', 'child-late:deleted']);
      const stored = mall.eventsMap.get('sweep-1').content;
      assert.deepEqual(stored.residuals, [{ counterparty: PATIENT, childAccessId: 'child-1', expires: NOW + 3600, reason: 'http-5xx' }]);
      assert.equal(stored.outcome.length, 2);
      assert.equal(JSON.stringify(stored).includes('leak'), false);
      assert.equal(r1.eventId.length > 0, true);
    });

    it('[MR11] a clean sweep completes; a snapshot record the ledger no longer holds is reported absent', async () => {
      const mall = fakeMall();
      await seed(mall);
      const r = await handleMemberRevoke({
        userId: 'group',
        triggerEvent: triggerFor([
          { relationshipAccessId: 'acc-rel', counterparty: PATIENT, childAccessId: 'child-1', expires: NOW + 3600 },
          { relationshipAccessId: 'acc-rel', counterparty: PATIENT, childAccessId: 'pruned', expires: NOW - 9 },
        ]),
        deps: revokeDeps(mall, fakeCores()),
      });
      assert.equal(r.ok, true, JSON.stringify(r));
      assert.deepEqual(r.outcome, [{ childAccessId: 'child-1', result: 'deleted' }, { childAccessId: 'pruned', result: 'absent', reason: 'not-in-ledger' }]);
      assert.equal((await handleMemberRevoke({ userId: 'group', triggerEvent: { type: 'note/txt', content: {} }, deps: revokeDeps(mall, fakeCores()) })).reason, CmcErrorIds.HANDLER_WRONG_TYPE);
    });
  });

  describe('[CMCMR-SWEEP] the entry point', () => {
    function sweepOf (mall, cores, over = {}) {
      const dispatched = [];
      const dispatch = async ({ userId, event, deps }) => {
        dispatched.push({ userId, event, deps });
        return await dispatchMod.dispatch({ userId, event, deps });
      };
      const sweep = createMemberSweep({
        mall, fetch: cores.fetch, now: () => NOW, dispatch, dispatchDeps: { mall, fetch: cores.fetch, selfIdentityFor: () => GROUP, enqueueRetries: false }, ...over,
      });
      return { sweep, dispatched };
    }

    it('[MR20] sweepMembership writes the record on the membership scope (member, reason, records, pending) and dispatches it; the outcome lands on it', async () => {
      const mall = fakeMall();
      await seed(mall);
      const cores = fakeCores();
      const { sweep, dispatched } = sweepOf(mall, cores);
      const r = await sweep.sweepMembership('group', MEMBERSHIP, 'detach');
      assert.deepEqual({ status: r.status, records: r.records }, { status: 'completed', records: 1 });
      const trigger = mall.calls.eventsCreated.find((e) => e.type === C.ET_MEMBER_REVOKE);
      assert.deepEqual(trigger.streamIds, [TEAM]);
      assert.deepEqual(trigger.content.member, MEMBER);
      assert.deepEqual([trigger.content.reason, trigger.content.membershipAccessId], ['detach', 'acc-membership']);
      assert.deepEqual(trigger.content.records, [{ relationshipAccessId: 'acc-rel', counterparty: PATIENT, childAccessId: 'child-1', expires: NOW + 3600 }]);
      assert.equal(r.triggerEventId, trigger.id);
      assert.equal(dispatched.length, 1);
      const stored = mall.eventsMap.get(trigger.id).content;
      assert.equal(stored.status, 'completed');
      assert.deepEqual(stored.outcome, [{ childAccessId: 'child-1', result: 'deleted' }]);
      assert.deepEqual(stored.residuals, []);
      assert.equal(JSON.stringify(stored).includes('tok'), false);
      // Nothing to sweep: no record written.
      const again = await sweep.sweepMembership('group', MEMBERSHIP, 'revoke');
      assert.deepEqual({ status: again.status, reason: again.reason }, { status: 'skipped', reason: 'nothing-to-sweep' });
      assert.equal(mall.calls.eventsCreated.filter((e) => e.type === C.ET_MEMBER_REVOKE).length, 1);
    });

    it('[MR21] without persistence (the account is being deleted) the children are still deleted, no record is written and no retry is queued; a record filter narrows the sweep', async () => {
      const mall = fakeMall();
      await seed(mall);
      await seed(mall, { relationshipAccessId: 'acc-rel2', counterparty: PATIENT2, scopeStreamId: TEAM_B, childAccessId: 'child-2' });
      const cores = fakeCores({ deletes: { 'child-2': { status: 503, body: null } }, remaining: { 'grant2-tok': ['child-2'] } });
      const { sweep, dispatched } = sweepOf(mall, cores);
      // A narrowed membership: the filtered relationship only, the other is
      // not the sweep's business even though the ledger is re-read.
      let r = await sweep.sweepMembership('group', MEMBERSHIP, 'narrowed', { recordFilter: (rec) => rec.scopeStreamId === TEAM_B });
      assert.deepEqual({ status: r.status, reason: r.reason, records: r.records }, { status: 'failed', reason: CmcErrorIds.MEMBER_REVOKE_RESIDUAL, records: 1 });
      assert.deepEqual(cores.calls.filter((c) => c.method === 'DELETE').map((c) => c.path), ['/accesses/child-2']);
      assert.equal((await ledger.listRecords({ mall }, 'group')).find((x) => x.childAccessId === 'child-1').state, 'live', 'filtered out, untouched');
      assert.equal(mall.calls.eventsCreated.filter((e) => e.type === C.ET_MEMBER_REVOKE).length, 1);
      // The account being erased: everything swept, no record, no retry.
      cores.calls.length = 0;
      r = await sweep.sweepMembership('group', MEMBERSHIP, 'account-deleted', { persist: false });
      assert.deepEqual({ status: r.status, records: r.records, triggerEventId: r.triggerEventId }, { status: 'failed', records: 2, triggerEventId: null });
      assert.equal(dispatched[1].deps.enqueueRetries, false);
      assert.equal(mall.calls.eventsCreated.filter((e) => e.type === C.ET_RETRY).length, 0);
      assert.equal(mall.calls.eventsCreated.filter((e) => e.type === C.ET_MEMBER_REVOKE).length, 1, 'no second record');
      assert.deepEqual(cores.calls.filter((c) => c.method === 'DELETE').map((c) => c.path).sort(), ['/accesses/child-1', '/accesses/child-2']);
    });

    it('[MR22] the sweep stream: the membership scope, else a scope permission, else the app root', () => {
      assert.equal(sweepStreamOf(MEMBERSHIP), TEAM);
      assert.equal(sweepStreamOf({ id: 'x', permissions: [{ streamId: TEAM_B, level: 'read' }], clientData: { cmc: { role: 'member' } } }), TEAM_B);
      assert.equal(sweepStreamOf({ id: 'x', clientData: { cmc: { role: 'member', appCode: 'practice' } } }), ':_cmc:apps:practice');
      assert.equal(sweepStreamOf({ id: 'x' }), ':_cmc:apps');
    });

    it('[MR23] a relationship ending on the group side is swept through the grant of the access as handed over (already gone from storage), before anything else; one the patient ended is settled absent', async () => {
      const mall = fakeMall({ accesses: [MEMBERSHIP] });
      await seed(mall);
      await seed(mall, { membershipAccessId: 'acc-other', member: { username: 'dr-bob', host: 'm.example.com' }, childAccessId: 'child-bob' });
      const cores = fakeCores();
      const { sweep } = sweepOf(mall, cores);
      const r = await sweep.sweepRelationship('group', REL);
      assert.deepEqual(r, { records: 2, residuals: 0 });
      assert.deepEqual(cores.calls.filter((c) => c.method === 'DELETE').map((c) => c.path + ' ' + c.token), ['/accesses/child-1 grant-tok', '/accesses/child-bob grant-tok']);
      assert.deepEqual((await ledger.listRecords({ mall }, 'group')).map((x) => x.state), ['deleted', 'deleted']);
      assert.equal(mall.calls.eventsCreated.filter((e) => e.type === C.ET_MEMBER_REVOKE).length, 0, 'no sweep record for a relationship end');

      const mall2 = fakeMall();
      await seed(mall2);
      const { sweep: sweep2 } = sweepOf(mall2, cores);
      assert.equal(await sweep2.relationshipEnded('group', 'acc-rel'), 1);
      const ended = (await ledger.listRecords({ mall: mall2 }, 'group'))[0];
      assert.equal(ended.state, 'absent');
      assert.equal(ended.absentReason, 'relationship-ended-by-peer', 'the claim is left to the patient core');
    });

    it('[MR24] the periodic pass sweeps an expired or vanished membership, settles children past their expiry, prunes settled records', async () => {
      const expiredMembership = { ...MEMBERSHIP, id: 'acc-expired', expires: NOW - 1 };
      const mall = fakeMall({ accesses: [MEMBERSHIP, expiredMembership, REL, REL2] });
      await seed(mall, { membershipAccessId: 'acc-expired', childAccessId: 'c-exp-m' });
      await seed(mall, { membershipAccessId: 'acc-gone', childAccessId: 'c-gone-m', relationshipAccessId: 'acc-rel2', counterparty: PATIENT2, scopeStreamId: TEAM_B });
      await seed(mall, { childAccessId: 'c-old', expires: NOW - 5 });
      await seed(mall, { childAccessId: 'c-settled', expires: NOW - 5, state: 'deleted' });
      await seed(mall, { childAccessId: 'c-live' });
      const cores = fakeCores();
      let clock = NOW;
      const { sweep } = sweepOf(mall, cores, { now: () => clock });
      // The vanished membership is left to the path that deleted it on the
      // pass that first sees it gone, and swept on a later pass.
      let r = await sweep.runLedgerPass('group');
      assert.deepEqual(r, { swept: 1, expired: 1, residuals: 0, pruned: 2, records: 4 });
      assert.deepEqual(cores.calls.filter((c) => c.method === 'DELETE').map((c) => c.path), ['/accesses/c-exp-m']);
      clock = NOW + 31;
      r = await sweep.runLedgerPass('group');
      assert.deepEqual(r, { swept: 1, expired: 0, residuals: 0, pruned: 0, records: 2 });
      const deleted = cores.calls.filter((c) => c.method === 'DELETE').map((c) => c.path).sort();
      assert.deepEqual(deleted, ['/accesses/c-exp-m', '/accesses/c-gone-m']);
      const left = Object.fromEntries((await ledger.listRecords({ mall }, 'group')).map((x) => [x.childAccessId, x.state]));
      assert.deepEqual(left, { 'c-exp-m': 'deleted', 'c-gone-m': 'deleted', 'c-live': 'live' });
      const sweeps = mall.calls.eventsCreated.filter((e) => e.type === C.ET_MEMBER_REVOKE);
      assert.deepEqual(sweeps.map((e) => e.content.reason), ['expired', 'vanished']);
      assert.deepEqual(sweeps.find((e) => e.content.membershipAccessId === 'acc-gone').content.member, MEMBER, 'a vanished membership is named from its records');
    });

    it('[MR25] the periodic pass re-sweeps the residuals of earlier sweeps through their grants, a bounded number per pass, and writes no new record', async () => {
      const mall = fakeMall();
      await seed(mall, { childAccessId: 'c-res', state: 'residual' });
      await seed(mall, { childAccessId: 'c-res-old', state: 'residual', expires: NOW - 1 });
      await seed(mall, { childAccessId: 'c-still', state: 'residual', relationshipAccessId: 'acc-rel2', counterparty: PATIENT2, scopeStreamId: TEAM_B });
      const cores = fakeCores({ deletes: { 'c-still': { status: 503, body: {} } }, remaining: { 'grant2-tok': ['c-still'] } });
      const { sweep } = sweepOf(mall, cores);
      const r = await sweep.runLedgerPass('group');
      assert.deepEqual(r, { swept: 0, expired: 0, residuals: 1, pruned: 1, records: 3 });
      const left = Object.fromEntries((await ledger.listRecords({ mall }, 'group')).map((x) => [x.childAccessId, x.state]));
      assert.deepEqual(left, { 'c-res': 'deleted', 'c-still': 'residual' });
      assert.equal(mall.calls.eventsCreated.filter((e) => e.type === C.ET_MEMBER_REVOKE).length, 0);
    });

    it('[MR26] a relationship that cannot be read leaves the record residual (retried), unlike one that is gone (absent)', async () => {
      const mall = fakeMall();
      const rec = await seed(mall);
      const getOne = mall.accesses.getOne;
      mall.accesses.getOne = async (u, p) => { if (p.id === 'acc-rel') throw new Error('storage down'); return getOne(u, p); };
      const cores = fakeCores();
      const r = await revokeRecords({ userId: 'group', records: [rec], deps: revokeDeps(mall, cores) });
      assert.deepEqual(r.outcome, [{ childAccessId: 'child-1', result: 'residual', reason: 'relationship-unreadable' }]);
      assert.equal(cores.calls.length, 0);
      assert.equal((await ledger.listRecords({ mall }, 'group'))[0].state, 'residual');
    });

    it('[MR27] a narrowed sweep keeps the children whose scope the live membership covers at handling time, with no outcome entry for them', async () => {
      const mall = fakeMall();
      await seed(mall);
      await seed(mall, { childAccessId: 'c-b', relationshipAccessId: 'acc-rel2', counterparty: PATIENT2, scopeStreamId: TEAM_B });
      const cores = fakeCores();
      const trigger = {
        id: 'sweep-n',
        type: C.ET_MEMBER_REVOKE,
        streamIds: [TEAM],
        content: {
          member: MEMBER,
          membershipAccessId: 'acc-membership',
          reason: 'narrowed',
          status: 'pending',
          records: [
            { relationshipAccessId: 'acc-rel', counterparty: PATIENT, childAccessId: 'child-1', expires: NOW + 3600 },
            { relationshipAccessId: 'acc-rel2', counterparty: PATIENT2, childAccessId: 'c-b', expires: NOW + 3600 },
          ],
        },
      };
      mall.eventsMap.set('sweep-n', trigger);
      const r = await handleMemberRevoke({ userId: 'group', triggerEvent: trigger, deps: revokeDeps(mall, cores) });
      assert.equal(r.ok, true, JSON.stringify(r));
      assert.deepEqual(r.outcome, [{ childAccessId: 'c-b', result: 'deleted' }], 'team A is still covered: child-1 kept');
      assert.deepEqual(cores.calls.filter((c) => c.method === 'DELETE').map((c) => c.path), ['/accesses/c-b']);
      const left = Object.fromEntries((await ledger.listRecords({ mall }, 'group')).map((x) => [x.childAccessId, x.state]));
      assert.deepEqual(left, { 'child-1': 'live', 'c-b': 'deleted' });
    });

    it('[MR28] an erased group account: its children deleted through the grants from one ledger read, concurrently, nothing written', async () => {
      const mall = fakeMall();
      await seed(mall);
      await seed(mall, { childAccessId: 'c-b', relationshipAccessId: 'acc-rel2', counterparty: PATIENT2, scopeStreamId: TEAM_B });
      await seed(mall, { childAccessId: 'c-orphan', relationshipAccessId: 'acc-unknown' });
      await seed(mall, { childAccessId: 'c-done', state: 'deleted' });
      const cores = fakeCores({ deletes: { 'c-b': { status: 503, body: {} } } });
      const created = mall.calls.eventsCreated.length;
      const { sweep } = sweepOf(mall, cores);
      const r = await sweep.sweepErasedAccount('group', [REL, REL2]);
      assert.deepEqual(r, { records: 3, residuals: 1 });
      assert.deepEqual(cores.calls.map((c) => c.method + ' ' + c.path).sort(), ['DELETE /accesses/c-b', 'DELETE /accesses/child-1']);
      assert.equal(mall.calls.eventsCreated.length, created, 'nothing written');
      assert.equal(mall.calls.eventsUpdated.length, 0);
    });

    it('[MR29] the erasure sweep keeps at most sixteen deletions in flight', async () => {
      const mall = fakeMall();
      for (let i = 0; i < 40; i++) await seed(mall, { childAccessId: 'c-' + i });
      let inFlight = 0;
      let peak = 0;
      const fetch = async (url, init) => {
        inFlight += 1; peak = Math.max(peak, inFlight);
        await new Promise((resolve) => setTimeout(resolve, 5));
        inFlight -= 1;
        return { status: 200, ok: true, async json () { return {}; }, async text () { return '{}'; } };
      };
      const sweep = createMemberSweep({ mall, fetch, now: () => NOW, dispatch: async () => ({ status: 'completed' }), dispatchDeps: {} });
      const r = await sweep.sweepErasedAccount('group', [REL]);
      assert.deepEqual(r, { records: 40, residuals: 0 });
      assert.equal(peak, 16, 'sixteen at a time, never more');
    });

    it('[MR34] a team stream deleted for good narrows every membership covering it: swept as narrowed on the parent stream, the dead scope named as uncovered, nothing kept under it', async () => {
      const mall = fakeMall();
      await seed(mall);
      await seed(mall, { childAccessId: 'c-b', relationshipAccessId: 'acc-rel2', counterparty: PATIENT2, scopeStreamId: TEAM_B });
      const cores = fakeCores();
      const { sweep, dispatched } = sweepOf(mall, cores);
      const narrow = createStreamDeleteNarrowing({ mall, memberSweep: sweep });
      // A stream outside the apps tree, or a plugin-managed one, is nobody's team.
      narrow('group', { id: 'data', parentId: null });
      narrow('group', { id: ':_cmc:inbox', parentId: ':_cmc' });
      await new Promise((resolve) => setTimeout(resolve, 20));
      assert.equal(dispatched.length, 0);
      // The deletion, once certain, sweeps.
      narrow('group', { id: TEAM, parentId: ':_cmc:apps:practice' });
      await new Promise((resolve) => setTimeout(resolve, 50));
      assert.equal(dispatched.length, 1);
      const trigger = dispatched[0].event;
      assert.equal(trigger.content.reason, 'narrowed');
      assert.deepEqual(trigger.content.uncovered, [TEAM]);
      assert.deepEqual(trigger.streamIds, [':_cmc:apps:practice'], 'written on the surviving parent');
      assert.deepEqual(trigger.content.records.map((r) => r.childAccessId), ['child-1'], 'team B is untouched');
      const left = Object.fromEntries((await ledger.listRecords({ mall }, 'group')).map((x) => [x.childAccessId, x.state]));
      assert.deepEqual(left, { 'child-1': 'deleted', 'c-b': 'live' });
      assert.deepEqual(cores.calls.filter((c) => c.method === 'DELETE').map((c) => c.path), ['/accesses/child-1'], 'the membership still names the dead stream, and that is not coverage');
    });
  });

  describe('[CMCMR-ENTRY] every way a membership ends', () => {
    function spy () {
      const calls = [];
      return {
        calls,
        async sweepMembership (userId, access, reason, options) { calls.push({ fn: 'sweepMembership', id: access.id, reason, options }); return { status: 'completed', records: 0, triggerEventId: null }; },
        async sweepRelationship (userId, access) { calls.push({ fn: 'sweepRelationship', id: access.id }); return { records: 0, residuals: 0 }; },
        async relationshipEnded (userId, id) { calls.push({ fn: 'relationshipEnded', id }); return 0; },
      };
    }
    function okFetch (log) {
      return async (url, init) => { log.push((init?.method ?? 'GET') + ' ' + new URL(url).pathname); return { status: 201, ok: true, async json () { return {}; }, async text () { return '{}'; } }; };
    }

    it('[MR30] the group revoking a membership sweeps it after the delete; revoking a patient relationship sweeps its children before the revoke is delivered', async () => {
      const log = [];
      const memberSweep = spy();
      const mall = {
        accesses: { async get () { return [MEMBERSHIP, REL]; }, async delete (u, { id }) { log.push('delete ' + id); } },
        events: { async updateWithMerge () { return null; }, async getOne () { return null; }, async update () {} },
      };
      const base = { userId: 'group', selfIdentity: GROUP, deps: { mall, fetch: okFetch(log), memberSweep } };
      let r = await handleRevoke({ ...base, triggerEvent: { id: 'rv', type: C.ET_REVOKE, streamIds: [TEAM], content: { accessId: 'acc-membership' } } });
      assert.equal(r.ok, true, JSON.stringify(r));
      assert.deepEqual(memberSweep.calls, [{ fn: 'sweepMembership', id: 'acc-membership', reason: 'revoke', options: undefined }]);
      assert.ok(log.indexOf('delete acc-membership') >= 0);
      memberSweep.calls.length = 0; log.length = 0;
      r = await handleRevoke({ ...base, triggerEvent: { id: 'rv2', type: C.ET_REVOKE, streamIds: [TEAM], content: { accessId: 'acc-rel' } } });
      assert.equal(r.ok, true, JSON.stringify(r));
      assert.deepEqual(memberSweep.calls, [{ fn: 'sweepRelationship', id: 'acc-rel' }]);
      assert.ok(log.findIndex((l) => l.startsWith('POST')) >= 0, 'the revoke was delivered');
    });

    it('[MR31] a member leaving sweeps the membership; a patient revoking settles the relationship records', async () => {
      const memberSweep = spy();
      const mall = { accesses: { async get () { return [MEMBERSHIP, REL]; }, async delete () {} }, events: { async updateWithMerge () { return null; }, async getOne () { return null; }, async update () {} } };
      await handleIncomingRevoke({ userId: 'group', event: { type: C.ET_REVOKE, streamIds: [':_cmc:inbox'], createdBy: 'acc-membership', content: {} }, deps: { mall, memberSweep } });
      await handleIncomingRevoke({ userId: 'group', event: { type: C.ET_REVOKE, streamIds: [':_cmc:inbox'], createdBy: 'acc-rel', content: {} }, deps: { mall, memberSweep } });
      assert.deepEqual(memberSweep.calls, [
        { fn: 'sweepMembership', id: 'acc-membership', reason: 'revoke', options: undefined },
        { fn: 'relationshipEnded', id: 'acc-rel' },
      ]);
    });

    it('[MR32] the delete hook sweeps a membership with the path\'s reason (and no record for an erased account) and a relationship before the peer is told', async () => {
      const log = [];
      const memberSweep = spy();
      const hook = createAccessesDeletePostHook({ fetch: okFetch(log), memberSweep, sweepReason: 'account-deleted', sweepPersist: false });
      await hook('group', [MEMBERSHIP, REL]);
      assert.deepEqual(memberSweep.calls, [
        { fn: 'sweepMembership', id: 'acc-membership', reason: 'account-deleted', options: { persist: false } },
        { fn: 'sweepRelationship', id: 'acc-rel' },
      ]);
      assert.equal(log.filter((l) => l.startsWith('POST')).length, 2, 'both peers told');
      const memberSweep2 = spy();
      await createAccessesDeletePostHook({ fetch: okFetch(log), memberSweep: memberSweep2 })('group', [MEMBERSHIP]);
      assert.deepEqual(memberSweep2.calls, [{ fn: 'sweepMembership', id: 'acc-membership', reason: 'accesses.delete', options: { persist: true } }]);
    });

    it('[MR33] a narrowed membership sweeps the records whose scope it no longer covers', async () => {
      const memberSweep = spy();
      const hook = createAccessesUpdatePostHook({ mall: { events: { async create () { return { id: 'a' }; } } }, fetch: async () => ({ status: 201, ok: true, async json () { return {}; } }), memberSweep });
      const after = { ...MEMBERSHIP, permissions: [{ streamId: TEAM_B, level: 'contribute' }], clientData: { cmc: { ...MEMBERSHIP.clientData.cmc, counterparty: { ...MEMBER, apiEndpoint: 'https://m-bc@member.example.com/', remoteCollectorStreamId: TEAM + ':collectors:x' } } } };
      await hook('group', MEMBERSHIP, after);
      assert.equal(memberSweep.calls.length, 1);
      assert.deepEqual([memberSweep.calls[0].fn, memberSweep.calls[0].reason], ['sweepMembership', 'narrowed']);
      const filter = memberSweep.calls[0].options.recordFilter;
      assert.equal(filter({ scopeStreamId: TEAM }), true, 'team A is no longer covered');
      assert.equal(filter({ scopeStreamId: TEAM_B + ':ward' }), false, 'under team B: kept');
    });
  });

  describe('[CMCMR-RETRY] a residual is retried from the queue; the boot wires the ledger pass', () => {
    it('[MR40] a sweep dispatched end to end with a residual fails and enqueues a retry; the retry re-sweeps from the snapshot and completes', async () => {
      const mall = fakeMall();
      await seed(mall);
      let down = true;
      const cores = fakeCores({ remaining: { 'grant-tok': ['child-1'] } });
      const origFetch = cores.fetch;
      cores.fetch = (url, init) => {
        if (down && (init?.method ?? 'GET') === 'DELETE') return Promise.resolve({ status: 503, ok: false, async json () { return null; }, async text () { return ''; } });
        if (!down && (init?.method ?? 'GET') === 'GET') return Promise.resolve({ status: 200, ok: true, async json () { return { accesses: [] }; }, async text () { return '{}'; } });
        return origFetch(url, init);
      };
      const deps = { mall, fetch: cores.fetch, selfIdentityFor: () => GROUP };
      const sweep = createMemberSweep({ mall, fetch: cores.fetch, now: () => NOW, dispatch: dispatchMod.dispatch, dispatchDeps: deps });
      const r = await sweep.sweepMembership('group', MEMBERSHIP, 'revoke');
      assert.deepEqual({ status: r.status, reason: r.reason }, { status: 'failed', reason: CmcErrorIds.MEMBER_REVOKE_RESIDUAL });
      const retry = mall.calls.eventsCreated.find((e) => e.type === C.ET_RETRY);
      assert.ok(retry != null, 'a retry was queued');
      assert.equal(retry.content.originalType, C.ET_MEMBER_REVOKE);
      assert.equal(JSON.stringify(retry).includes('tok'), false);
      down = false;
      const retryQueue = require('../src/retryQueue.ts');
      const out = await retryQueue.processRetryEvent({ userId: 'group', retryEvent: { ...retry, content: { ...retry.content, nextAttemptAfter: 0 } }, deps: { mall, dispatch: dispatchMod.dispatch, dispatchDeps: { ...deps, enqueueRetries: false } } });
      assert.equal(out.outcome, 'succeeded');
      const stored = mall.eventsMap.get(r.triggerEventId).content;
      assert.deepEqual([stored.status, stored.residuals, stored.outcome], ['completed', [], [{ childAccessId: 'child-1', result: 'deleted' }]]);
    });

    it('[MR41] the boot starts the ledger pass beside the retry loop, eagerly then on its interval', async () => {
      const passes = [];
      const memberSweep = { async runLedgerPass (userId) { passes.push(userId); return { swept: 0, expired: 0, residuals: 0, pruned: 0 }; } };
      const config = { get: (k) => ({ 'cmc:retryLoop:enabled': true, 'cmc:retryLoop:intervalMs': 60_000, 'cmc:memberAccess:sweepIntervalMs': 60_000 })[k] };
      const scheduler = startRetryLoopIfEnabled({ config, mall: fakeMall(), selfIdentityFor: () => GROUP, fetch: async () => ({}), userIdsProvider: async () => ['u1', 'u2'], isLoopWorker: () => true, memberSweep });
      assert.ok(scheduler != null);
      await new Promise((resolve) => setTimeout(resolve, 20));
      assert.deepEqual(passes, ['u1', 'u2']);
      await scheduler.stop();
      await scheduler.ledgerScheduler.stop();
    });

    it('[MR42] the loop off is a warning at boot naming what is not retried', async () => {
      const warned = [];
      const config = { get: (k) => ({ 'cmc:retryLoop:enabled': false })[k] };
      const scheduler = startRetryLoopIfEnabled({ config, mall: fakeMall(), selfIdentityFor: () => GROUP, fetch: async () => ({}), userIdsProvider: async () => [], logger: { warn: (m) => warned.push(m), info () {}, debug () {} } });
      assert.equal(scheduler, null);
      assert.equal(warned.length, 1);
      assert.ok(warned[0].includes('revoke notices are not retried'));
    });
  });
});
