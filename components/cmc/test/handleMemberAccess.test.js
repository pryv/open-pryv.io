/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);

/**
 * CMC plugin, group accounts: the member access mint.
 *
 * [CMCMA] covers the write-time gate (every refusal), the mint through the
 * grant (reuse by ledger record, stale and absent children, the name-only
 * fallback for an older patient core, the peer's refusals, an unreachable
 * core, a membership that ends during the mint), the per-worker registry,
 * the ledger, the hooks, and the synchronous dispatch that answers the token
 * once and persists none of it.
 */

const assert = require('node:assert/strict');
const C = require('../src/constants.ts');
const { CmcErrorIds } = require('../src/errorIds.ts');
const { handleMemberAccess, resolveMintTarget, childNameFor, memberAccessOptionsFromConfig } = require('../src/handleMemberAccess.ts');
const { createMemberMintRegistry, MemberMintRegistry } = require('../src/memberMintRegistry.ts');
const ledger = require('../src/memberLedger.ts');
const { createMemberAccessGateHook, createMemberAccessServerOwnedFieldsHook } = require('../src/memberAccessHooks.ts');
const { preserveServerOwnedContent } = require('../src/acceptServerOwnedFieldsHook.ts');
const dispatchMod = require('../src/dispatch.ts');
const { assertOutboundUrl, fakeUpdateWithMerge } = require('./_fake-assertions.cjs');

const GROUP = { username: 'practice', host: 'group.example.com' };
const MEMBER = { username: 'dr-amy', host: 'member.example.com' };
const PATIENT = { username: 'pat', host: 'patient.example.com' };
const TEAM = ':_cmc:apps:practice:team-a';
const GRANT_ENDPOINT = 'https://grant-tok@patient.example.com/';
const OPTIONS = { defaultTtl: 86400, minTtl: 60, maxTtl: 604800, allowNameOnly: true };

const MEMBERSHIP = {
  id: 'acc-membership',
  type: 'shared',
  clientData: { cmc: { role: 'member', appCode: 'practice', scopeStreamId: TEAM, counterparty: { ...MEMBER, apiEndpoint: 'https://m-bc@member.example.com/' } } },
};
const RELATIONSHIP = {
  id: 'acc-rel',
  type: 'shared',
  created: 100,
  clientData: { cmc: { role: 'counterparty', appCode: 'practice', scopeStreamId: TEAM, inviteEventId: 'invite-1', counterparty: { ...PATIENT, apiEndpoint: GRANT_ENDPOINT, remoteCollectorStreamId: TEAM + ':collectors:x' } } },
};
const INVITE = {
  id: 'invite-1',
  type: 'consent/request-cmc',
  streamIds: [TEAM],
  content: { to: null, request: { accessType: 'app', permissions: [{ streamId: 'vitals', level: 'contribute' }, { streamId: 'notes', level: 'read' }, { streamId: ':_cmc:apps:practice:team-a:collectors:x', level: 'contribute' }] } },
};

function fakeMall (opts = {}) {
  const accesses = new Map((opts.accesses ?? [MEMBERSHIP, RELATIONSHIP]).map((a) => [a.id, a]));
  const events = new Map((opts.events ?? [INVITE]).map((e) => [e.id, e]));
  const calls = { eventsCreated: [], eventsUpdated: [], eventsDeleted: [], streamsCreated: [] };
  let seq = 0;
  const mall = {
    calls,
    accesses: {
      async get () { return [...accesses.values()]; },
      async getOne (u, { id }) { return accesses.get(id) ?? null; },
    },
    events: {
      async create (u, p) { const id = 'led-' + (++seq); const ev = { id, ...p }; events.set(id, ev); calls.eventsCreated.push(ev); return ev; },
      async get (u, p) {
        const any = p?.streams?.[0]?.any;
        return [...events.values()].filter((e) => !Array.isArray(any) || (e.streamIds ?? []).some((s) => any.includes(s)));
      },
      async getOne (u, id) { return events.get(id) ?? null; },
      async updateWithMerge (...a) { return fakeUpdateWithMerge(this, ...a); },
      async update (u, e) { events.set(e.id, e); calls.eventsUpdated.push(e); return e; },
      async delete (u, e) { events.delete(e.id); calls.eventsDeleted.push(e.id); },
    },
    streams: { async create (u, p) { calls.streamsCreated.push(p.id); return { id: p.id }; } },
  };
  mall.accessesMap = accesses;
  mall.eventsMap = events;
  return mall;
}

/** A patient core: routes by method + path; `script` lists the answers in order. */
function fakePatientCore (script) {
  const calls = [];
  let i = 0;
  return {
    calls,
    fetch (url, init) {
      assertOutboundUrl(url, init);
      const method = (init?.method ?? 'GET').toUpperCase();
      const path = new URL(url).pathname;
      calls.push({ method, path, body: init?.body != null ? JSON.parse(init.body) : undefined, auth: init?.headers?.authorization });
      const spec = typeof script === 'function' ? script({ method, path, body: init?.body != null ? JSON.parse(init.body) : undefined, n: i++ }) : script[i++];
      if (spec instanceof Error) return Promise.reject(spec);
      if (spec == null) throw new Error('no scripted answer for ' + method + ' ' + path);
      return Promise.resolve({ status: spec.status, ok: spec.status >= 200 && spec.status < 300, async json () { return spec.body; }, async text () { return JSON.stringify(spec.body); } });
    },
  };
}

const CHILD = { id: 'child-1', token: 'child-tok', name: 'cmc-member--x', expires: 9_999_999_999, permissions: [{ streamId: 'vitals', level: 'read' }, { streamId: 'notes', level: 'read' }] };
const created201 = (over = {}) => ({ status: 201, body: { access: { ...CHILD, ...over } } });

function trigger (content = {}, over = {}) {
  return { id: 'trig-1', type: C.ET_MEMBER_ACCESS, streamIds: [TEAM], createdBy: 'acc-membership', content: { counterparty: PATIENT, ...content }, ...over };
}

async function mint (mall, core, content, depsOver = {}) {
  return await handleMemberAccess({
    userId: 'group',
    triggerEvent: trigger(content),
    selfIdentity: GROUP,
    deps: { mall, fetch: core.fetch, memberAccess: OPTIONS, now: () => 1_000_000, ...depsOver },
  });
}

function noTokenIn (value, label) {
  const s = JSON.stringify(value);
  assert.equal(s.includes('child-tok'), false, label + ' carries the child token: ' + s);
  assert.equal(s.includes('grant-tok'), false, label + ' carries the grant token: ' + s);
  assert.equal(/"token"/.test(s), false, label + ' has a token key: ' + s);
}

describe('[CMCMA] cmc group accounts: the member access mint', () => {
  describe('[CMCMA-GATE] the gate', () => {
    async function gate (over = {}) {
      return await resolveMintTarget({
        userId: 'group',
        membershipAccess: over.membershipAccess === undefined ? MEMBERSHIP : over.membershipAccess,
        triggerStreamIds: over.streamIds ?? [TEAM],
        content: { counterparty: PATIENT, ...(over.content ?? {}) },
        deps: { mall: over.mall ?? fakeMall(), options: over.options ?? OPTIONS },
      });
    }

    it('[MA01] only a membership access may ask: a personal token, a counterparty access or no access get not-member', async () => {
      for (const membershipAccess of [null, { id: 'p', type: 'personal', isPersonal: () => true }, RELATIONSHIP]) {
        const r = await gate({ membershipAccess });
        assert.equal(r.ok, false);
        assert.equal(r.reason, CmcErrorIds.MEMBER_ACCESS_NOT_MEMBER);
      }
    });

    it('[MA02] the scope asked must be the trigger stream or under it; the trigger must sit on a scope stream', async () => {
      let r = await gate({ content: { scopeStreamId: ':_cmc:apps:practice:team-b' } });
      assert.equal(r.reason, CmcErrorIds.MEMBER_ACCESS_SCOPE_OUTSIDE_MEMBERSHIP);
      r = await gate({ streamIds: ['notes'] });
      assert.equal(r.reason, CmcErrorIds.MEMBER_ACCESS_SCOPE_OUTSIDE_MEMBERSHIP);
      r = await gate({ content: { scopeStreamId: TEAM } });
      assert.equal(r.ok, true, JSON.stringify(r));
      // A relationship under a sub-team is reachable from the team stream.
      const sub = { ...RELATIONSHIP, id: 'acc-rel-sub', clientData: { cmc: { ...RELATIONSHIP.clientData.cmc, scopeStreamId: TEAM + ':ward-3' } } };
      r = await gate({ mall: fakeMall({ accesses: [MEMBERSHIP, sub] }) });
      assert.equal(r.ok, true, JSON.stringify(r));
      assert.equal(r.target.relationshipAccess.id, 'acc-rel-sub');
    });

    it('[MA03] no relationship with that patient under the scope, or one whose handshake never completed, is relationship-not-found', async () => {
      let r = await gate({ content: { counterparty: { username: 'nobody', host: 'x.example.com' } } });
      assert.equal(r.reason, CmcErrorIds.MEMBER_ACCESS_RELATIONSHIP_NOT_FOUND);
      const noEndpoint = { ...RELATIONSHIP, clientData: { cmc: { ...RELATIONSHIP.clientData.cmc, counterparty: PATIENT } } };
      r = await gate({ mall: fakeMall({ accesses: [MEMBERSHIP, noEndpoint] }) });
      assert.equal(r.reason, CmcErrorIds.MEMBER_ACCESS_RELATIONSHIP_NOT_FOUND);
      assert.equal(r.detail.reason, 'handshake-incomplete');
      // Only a counterparty grant counts (a member-role access with the patient identity does not).
      r = await gate({ mall: fakeMall({ accesses: [MEMBERSHIP, { ...RELATIONSHIP, clientData: { cmc: { ...RELATIONSHIP.clientData.cmc, role: 'member' } } }] }) });
      assert.equal(r.reason, CmcErrorIds.MEMBER_ACCESS_RELATIONSHIP_NOT_FOUND);
    });

    it('[MA04] the permissions default to the offered data streams at read; the channel streams are never delegated', async () => {
      const r = await gate();
      assert.equal(r.ok, true, JSON.stringify(r));
      assert.deepEqual(r.target.permissions, [{ streamId: 'vitals', level: 'read' }, { streamId: 'notes', level: 'read' }]);
      assert.equal(r.target.expireAfter, 86400);
      assert.equal(r.target.grantDelegable, true);
      assert.equal(r.target.grantApiEndpoint, GRANT_ENDPOINT);
    });

    it('[MA05] permissions above the offer, outside it, on a cmc stream, or with no readable offer are permissions-not-subset', async () => {
      for (const permissions of [
        [{ streamId: 'notes', level: 'contribute' }],
        [{ streamId: 'vitals', level: 'manage' }],
        [{ streamId: 'other', level: 'read' }],
        [{ streamId: TEAM + ':collectors:x', level: 'contribute' }],
        [{ streamId: ':_cmc:inbox', level: 'read' }],
      ]) {
        const r = await gate({ content: { permissions } });
        assert.equal(r.reason, CmcErrorIds.MEMBER_ACCESS_PERMISSIONS_NOT_SUBSET, JSON.stringify(permissions));
      }
      const ok = await gate({ content: { permissions: [{ streamId: 'vitals', level: 'contribute' }, { streamId: 'notes', level: 'read' }] } });
      assert.equal(ok.ok, true, JSON.stringify(ok));
      const noOffer = await gate({ mall: fakeMall({ events: [] }) });
      assert.equal(noOffer.reason, CmcErrorIds.MEMBER_ACCESS_PERMISSIONS_NOT_SUBSET);
      assert.equal(noOffer.detail.reason, 'offer-not-found');
    });

    it('[MA06] expireAfter must sit within the per-core bounds', async () => {
      assert.equal((await gate({ content: { expireAfter: 30 } })).reason, CmcErrorIds.MEMBER_ACCESS_EXPIRY_OUT_OF_RANGE);
      assert.equal((await gate({ content: { expireAfter: 604801 } })).reason, CmcErrorIds.MEMBER_ACCESS_EXPIRY_OUT_OF_RANGE);
      assert.equal((await gate({ content: { expireAfter: 3600 } })).target.expireAfter, 3600);
    });

    it('[MA07] the config reader falls back to the defaults for anything unset or invalid', () => {
      const values = { 'cmc:memberAccess:defaultTtl': 10, 'cmc:memberAccess:maxTtl': -1, 'cmc:memberAccess:allowNameOnly': false };
      const o = memberAccessOptionsFromConfig({ get: (k) => values[k] });
      assert.deepEqual(o, { defaultTtl: 60, minTtl: 60, maxTtl: 604800, allowNameOnly: false }, 'the default is clamped into the bounds');
      const o2 = memberAccessOptionsFromConfig({ get: (k) => ({ 'cmc:memberAccess:defaultTtl': 999_999, 'cmc:memberAccess:maxTtl': 3600 })[k] });
      assert.deepEqual([o2.defaultTtl, o2.maxTtl], [3600, 3600]);
    });
  });

  describe('[CMCMA-MINT] the mint through the grant', () => {
    it('[MA10] a first ask mints a stamped child, records it, and answers the endpoint once; the trigger record carries no token', async () => {
      const mall = fakeMall();
      const core = fakePatientCore([created201()]);
      const r = await mint(mall, core, {});
      assert.equal(r.ok, true, JSON.stringify(r));
      assert.equal(core.calls.length, 1);
      assert.deepEqual([core.calls[0].method, core.calls[0].path, core.calls[0].auth], ['POST', '/accesses', 'grant-tok']);
      const sent = core.calls[0].body;
      assert.equal(sent.type, 'shared');
      assert.equal(sent.name, childNameFor(MEMBER, 'acc-membership', 'acc-rel'));
      assert.match(sent.name, /^cmc-member--dr-amy--member-example-com--[0-9a-f]{12}$/);
      assert.deepEqual(sent.clientData, { cmc: { role: 'member-child', member: MEMBER } });
      assert.deepEqual(sent.permissions, [{ streamId: 'vitals', level: 'read' }, { streamId: 'notes', level: 'read' }]);
      assert.equal(sent.expireAfter, 86400);
      assert.equal(r.response.apiEndpoint, 'https://child-tok@patient.example.com/');
      assert.deepEqual(r.memberAccess, { accessId: 'child-1', name: CHILD.name, expires: CHILD.expires, attribution: 'stamped' });
      assert.deepEqual(r.member, MEMBER);
      assert.equal(r.relationshipAccessId, 'acc-rel');
      noTokenIn(r.memberAccess, 'memberAccess');
      const rec = await ledger.findRecord({ mall }, 'group', 'acc-membership', 'acc-rel');
      assert.equal(rec.state, 'live');
      assert.equal(rec.childAccessId, 'child-1');
      assert.equal(rec.attribution, 'stamped');
      assert.deepEqual(rec.counterparty, PATIENT);
      noTokenIn(mall.calls.eventsCreated, 'the ledger');
      assert.ok(mall.calls.streamsCreated.includes(':_cmc:_internal:members'), 'the ledger stream is ensured');
    });

    it('[MA11] a live record is reused: the child is read by id through the grant and its token re-read, nothing is created', async () => {
      const mall = fakeMall();
      await ledger.writeRecord({ mall }, 'group', { membershipAccessId: 'acc-membership', member: MEMBER, relationshipAccessId: 'acc-rel', counterparty: PATIENT, scopeStreamId: TEAM, childAccessId: 'child-1', childName: 'n', expires: CHILD.expires, attribution: 'stamped', state: 'live', stateChangedAt: 1 });
      const core = fakePatientCore([{ status: 200, body: { access: CHILD } }]);
      const r = await mint(mall, core, {});
      assert.equal(r.ok, true, JSON.stringify(r));
      assert.deepEqual(core.calls.map((c) => c.method + ' ' + c.path), ['GET /accesses/child-1']);
      assert.equal(r.response.apiEndpoint, 'https://child-tok@patient.example.com/');
      assert.equal(mall.calls.eventsCreated.length, 1, 'the record is updated in place, not duplicated');
    });

    it('[MA12] a recorded child about to expire, or without the permissions asked, is deleted and a new one minted', async () => {
      for (const stale of [{ ...CHILD, expires: 1_000_000 + 100 }, { ...CHILD, permissions: [{ streamId: 'notes', level: 'read' }] }]) {
        const mall = fakeMall();
        await ledger.writeRecord({ mall }, 'group', { membershipAccessId: 'acc-membership', member: MEMBER, relationshipAccessId: 'acc-rel', counterparty: PATIENT, scopeStreamId: TEAM, childAccessId: 'child-1', childName: 'n', expires: CHILD.expires, attribution: 'stamped', state: 'live', stateChangedAt: 1 });
        const core = fakePatientCore([{ status: 200, body: { access: stale } }, { status: 200, body: { accessDeletion: { id: 'child-1' } } }, created201({ id: 'child-2', token: 'child-tok' })]);
        const r = await mint(mall, core, {});
        assert.equal(r.ok, true, JSON.stringify(r));
        assert.deepEqual(core.calls.map((c) => c.method + ' ' + c.path), ['GET /accesses/child-1', 'DELETE /accesses/child-1', 'POST /accesses']);
        const rec = await ledger.findRecord({ mall }, 'group', 'acc-membership', 'acc-rel');
        assert.deepEqual([rec.state, rec.childAccessId], ['live', 'child-2']);
      }
    });

    it('[MA13] a recorded child the patient deleted (404) is marked absent and a new one minted while the grant lasts', async () => {
      const mall = fakeMall();
      await ledger.writeRecord({ mall }, 'group', { membershipAccessId: 'acc-membership', member: MEMBER, relationshipAccessId: 'acc-rel', counterparty: PATIENT, scopeStreamId: TEAM, childAccessId: 'child-1', childName: 'n', expires: CHILD.expires, attribution: 'stamped', state: 'live', stateChangedAt: 1 });
      const core = fakePatientCore([{ status: 404, body: { error: { id: 'unknown-resource' } } }, created201({ id: 'child-2' })]);
      const r = await mint(mall, core, {});
      assert.equal(r.ok, true, JSON.stringify(r));
      assert.deepEqual(core.calls.map((c) => c.method + ' ' + c.path), ['GET /accesses/child-1', 'POST /accesses']);
      const all = await ledger.listRecords({ mall }, 'group');
      assert.equal(all.length, 1, 'one record per pair');
      assert.deepEqual([all[0].state, all[0].childAccessId], ['live', 'child-2']);
    });

    it('[MA14] an older patient core refusing the stamp gets a second, stampless mint reported name-only; with allowNameOnly off it is a failure', async () => {
      const refusal = { status: 400, body: { error: { id: 'invalid-operation', data: { id: 'cmc-clientdata-cmc-forbidden' } } } };
      let mall = fakeMall();
      let core = fakePatientCore([refusal, created201()]);
      let r = await mint(mall, core, {});
      assert.equal(r.ok, true, JSON.stringify(r));
      assert.equal(core.calls[1].body.clientData, undefined);
      assert.equal(r.response.attribution, 'name-only');
      assert.equal((await ledger.findRecord({ mall }, 'group', 'acc-membership', 'acc-rel')).attribution, 'name-only');

      mall = fakeMall();
      core = fakePatientCore([refusal]);
      r = await mint(mall, core, {}, { memberAccess: { ...OPTIONS, allowNameOnly: false } });
      assert.equal(r.ok, false);
      assert.equal(r.reason, CmcErrorIds.MEMBER_ACCESS_PEER_REJECTED);
      assert.deepEqual(r.detail, { peerErrorId: 'cmc-clientdata-cmc-forbidden', httpStatus: 400 });
      assert.equal(core.calls.length, 1);
      // A NEW core refusing a malformed stamp is a bug here, never name-only.
      core = fakePatientCore([{ status: 400, body: { error: { id: 'invalid-operation', data: { id: 'cmc-member-stamp-invalid' } } } }]);
      r = await mint(fakeMall(), core, {});
      assert.equal(r.reason, CmcErrorIds.MEMBER_ACCESS_PEER_REJECTED);
      assert.equal(r.detail.peerErrorId, 'cmc-member-stamp-invalid');
    });

    it('[MA15] the grant is the real bound: a 403 forbidden from the create is permissions-not-subset; a duplicate name is peer-rejected and never answered with a delete', async () => {
      let core = fakePatientCore([{ status: 403, body: { error: { id: 'forbidden', message: 'insufficient' } } }]);
      let r = await mint(fakeMall(), core, {});
      assert.equal(r.reason, CmcErrorIds.MEMBER_ACCESS_PERMISSIONS_NOT_SUBSET);
      assert.deepEqual(r.detail, { peerErrorId: 'forbidden', httpStatus: 403 });
      core = fakePatientCore([{ status: 400, body: { error: { id: 'item-already-exists', message: 'name', data: { accesses: [{ token: 'child-tok' }] } } } }]);
      r = await mint(fakeMall(), core, {});
      assert.equal(r.reason, CmcErrorIds.MEMBER_ACCESS_PEER_REJECTED);
      assert.deepEqual(r.detail, { peerErrorId: 'item-already-exists', httpStatus: 400 }, 'no peer body in the detail');
      assert.equal(core.calls.length, 1, 'no delete');
    });

    it('[MA16] a 5xx, a network error or a timeout is peer-unreachable; the ledger gets nothing', async () => {
      for (const answer of [{ status: 503, body: null }, new Error('ECONNREFUSED'), Object.assign(new Error('aborted'), { name: 'AbortError' })]) {
        const mall = fakeMall();
        const r = await mint(mall, fakePatientCore([answer]), {});
        assert.equal(r.reason, CmcErrorIds.MEMBER_ACCESS_PEER_UNREACHABLE, String(answer));
        assert.equal(mall.calls.eventsCreated.length, 0);
        noTokenIn(r, 'the failure');
      }
    });

    it('[MA17] a non-delegable grant (the invite did not ask accessType app) fails before any call', async () => {
      const invite = { ...INVITE, content: { ...INVITE.content, request: { ...INVITE.content.request, accessType: undefined } } };
      const core = fakePatientCore([]);
      const r = await mint(fakeMall({ events: [invite] }), core, {});
      assert.equal(r.reason, CmcErrorIds.MEMBER_ACCESS_GRANT_NOT_DELEGABLE);
      assert.equal(core.calls.length, 0);
    });

    it('[MA18] a membership that ended during the mint: the child is deleted, the record marked, the trigger fails membership-gone', async () => {
      const mall = fakeMall();
      const core = fakePatientCore(({ method, n }) => {
        if (n === 0) { mall.accessesMap.delete('acc-membership'); return created201(); }
        return method === 'DELETE' ? { status: 200, body: { accessDeletion: { id: 'child-1' } } } : null;
      });
      const r = await mint(mall, core, {});
      assert.equal(r.reason, CmcErrorIds.MEMBER_ACCESS_MEMBERSHIP_GONE);
      assert.deepEqual(core.calls.map((c) => c.method + ' ' + c.path), ['POST /accesses', 'DELETE /accesses/child-1']);
      assert.equal((await ledger.listRecords({ mall }, 'group'))[0].state, 'deleted');
      noTokenIn(r, 'the failure');
    });

    it('[MA1B] a stale child whose deletion the patient core does not confirm is never minted over: the record stays live, the ask fails, a later sweep deletes it', async () => {
      for (const [answer, reason] of [[{ status: 503, body: null }, CmcErrorIds.MEMBER_ACCESS_PEER_UNREACHABLE], [{ status: 400, body: { error: { id: 'x' } } }, CmcErrorIds.MEMBER_ACCESS_PEER_REJECTED], [new Error('down'), CmcErrorIds.MEMBER_ACCESS_PEER_UNREACHABLE]]) {
        const mall = fakeMall();
        await ledger.writeRecord({ mall }, 'group', { membershipAccessId: 'acc-membership', member: MEMBER, relationshipAccessId: 'acc-rel', counterparty: PATIENT, scopeStreamId: TEAM, childAccessId: 'child-1', childName: 'n', expires: CHILD.expires, attribution: 'stamped', state: 'live', stateChangedAt: 1 });
        const core = fakePatientCore([{ status: 200, body: { access: { ...CHILD, expires: 1_000_000 + 100 } } }, answer]);
        const r = await mint(mall, core, {});
        assert.equal(r.reason, reason, JSON.stringify(r));
        assert.deepEqual(core.calls.map((c) => c.method), ['GET', 'DELETE'], 'no POST over a child not known gone');
        const rec = await ledger.findRecord({ mall }, 'group', 'acc-membership', 'acc-rel');
        assert.deepEqual([rec.state, rec.childAccessId], ['live', 'child-1'], 'the sweep will still find it');
        noTokenIn(r, 'the failure');
      }
    });

    it('[MA1C] a child that cannot be recorded, or whose pair was taken by a concurrent mint, is deleted and the ask fails', async () => {
      const mall = fakeMall();
      const origCreate = mall.events.create;
      mall.events.create = async () => { throw new Error('ledger down'); };
      let core = fakePatientCore([created201(), { status: 200, body: { accessDeletion: { id: 'child-1' } } }]);
      let r = await mint(mall, core, {});
      assert.equal(r.reason, CmcErrorIds.HANDLER_THREW);
      assert.deepEqual(core.calls.map((c) => c.method + ' ' + c.path), ['POST /accesses', 'DELETE /accesses/child-1']);
      mall.events.create = origCreate;
      // The pair's record read before the mint, replaced by another worker meanwhile.
      const mall2 = fakeMall();
      const rec = await ledger.writeRecord({ mall: mall2 }, 'group', { membershipAccessId: 'acc-membership', member: MEMBER, relationshipAccessId: 'acc-rel', counterparty: PATIENT, scopeStreamId: TEAM, childAccessId: 'child-0', childName: 'n', expires: CHILD.expires, attribution: 'stamped', state: 'live', stateChangedAt: 1 });
      core = fakePatientCore(({ method, n }) => {
        if (n === 0) return { status: 404, body: {} };
        if (n === 1) { mall2.eventsMap.get(rec).content.childAccessId = 'child-by-b'; return created201(); }
        return method === 'DELETE' ? { status: 200, body: {} } : null;
      });
      r = await mint(mall2, core, {});
      assert.equal(r.reason, CmcErrorIds.MEMBER_ACCESS_IN_FLIGHT);
      assert.deepEqual(core.calls.map((c) => c.method), ['GET', 'POST', 'DELETE']);
      assert.equal((await ledger.findRecord({ mall: mall2 }, 'group', 'acc-membership', 'acc-rel')).childAccessId, 'child-by-b', 'the other worker\'s child keeps the record');
    });

    it('[MA1D] a child never outlives the membership: the lifetime is capped at its expiry, a shorter membership refuses, a reused child past it is replaced, an expired membership after the mint is gone', async () => {
      const expiring = { ...MEMBERSHIP, expires: 1_000_000 + 7200 };
      let core = fakePatientCore([created201({ expires: 1_000_000 + 7200 })]);
      let r = await mint(fakeMall({ accesses: [expiring, RELATIONSHIP] }), core, {});
      assert.equal(r.ok, true, JSON.stringify(r));
      assert.equal(core.calls[0].body.expireAfter, 7200, 'capped at the membership');
      r = await mint(fakeMall({ accesses: [{ ...MEMBERSHIP, expires: 1_000_000 + 30 }, RELATIONSHIP] }), fakePatientCore([]), {});
      assert.equal(r.reason, CmcErrorIds.MEMBER_ACCESS_EXPIRY_OUT_OF_RANGE);
      // Reuse: the recorded child outlives the (shortened) membership: replaced.
      const mall = fakeMall({ accesses: [expiring, RELATIONSHIP] });
      await ledger.writeRecord({ mall }, 'group', { membershipAccessId: 'acc-membership', member: MEMBER, relationshipAccessId: 'acc-rel', counterparty: PATIENT, scopeStreamId: TEAM, childAccessId: 'child-1', childName: 'n', expires: CHILD.expires, attribution: 'stamped', state: 'live', stateChangedAt: 1 });
      core = fakePatientCore([{ status: 200, body: { access: CHILD } }, { status: 200, body: {} }, created201({ id: 'child-2', expires: 1_000_000 + 7200 })]);
      r = await mint(mall, core, {});
      assert.equal(r.ok, true, JSON.stringify(r));
      assert.deepEqual(core.calls.map((c) => c.method), ['GET', 'DELETE', 'POST']);
      // Expired between the gate and the record: gone.
      const mall3 = fakeMall({ accesses: [{ ...MEMBERSHIP, expires: 1_000_000 + 7200 }, RELATIONSHIP] });
      core = fakePatientCore(({ n }) => {
        if (n === 0) { mall3.accessesMap.get('acc-membership').expires = 1_000_000 - 1; return created201(); }
        return { status: 200, body: {} };
      });
      r = await mint(mall3, core, {});
      assert.equal(r.reason, CmcErrorIds.MEMBER_ACCESS_MEMBERSHIP_GONE);
      assert.deepEqual(core.calls.map((c) => c.method), ['POST', 'DELETE']);
    });

    it('[MA1E] a star ask is refused, the default set never carries it, and a reused child must carry exactly the permissions asked', async () => {
      const starInvite = { ...INVITE, content: { ...INVITE.content, request: { ...INVITE.content.request, permissions: [{ streamId: '*', level: 'read' }, { streamId: 'notes', level: 'read' }] } } };
      const mall = fakeMall({ events: [starInvite] });
      let r = await mint(mall, fakePatientCore([]), { permissions: [{ streamId: '*', level: 'read' }] });
      assert.equal(r.reason, CmcErrorIds.MEMBER_ACCESS_PERMISSIONS_NOT_SUBSET);
      let core = fakePatientCore([created201()]);
      r = await mint(mall, core, {});
      assert.deepEqual(core.calls[0].body.permissions, [{ streamId: 'notes', level: 'read' }], 'star dropped from the default');
      // A child with MORE than asked is not reused.
      const mall2 = fakeMall();
      await ledger.writeRecord({ mall: mall2 }, 'group', { membershipAccessId: 'acc-membership', member: MEMBER, relationshipAccessId: 'acc-rel', counterparty: PATIENT, scopeStreamId: TEAM, childAccessId: 'child-1', childName: 'n', expires: CHILD.expires, attribution: 'stamped', state: 'live', stateChangedAt: 1 });
      core = fakePatientCore([{ status: 200, body: { access: { ...CHILD, permissions: [{ streamId: 'vitals', level: 'contribute' }, { streamId: 'notes', level: 'read' }, { streamId: 'x', level: 'none' }] } } }, { status: 200, body: {} }, created201({ id: 'child-2' })]);
      r = await mint(mall2, core, {});
      assert.equal(r.ok, true, JSON.stringify(r));
      assert.deepEqual(core.calls.map((c) => c.method), ['GET', 'DELETE', 'POST']);
      // Equal (carve-outs of level none ignored): reused.
      core = fakePatientCore([{ status: 200, body: { access: { ...CHILD, id: 'child-2', permissions: [...CHILD.permissions, { streamId: 'x', level: 'none' }] } } }]);
      r = await mint(mall2, core, {});
      assert.equal(r.ok, true, JSON.stringify(r));
      assert.deepEqual(core.calls.map((c) => c.method), ['GET']);
    });

    it('[MA19] the handler refuses to run from the retry queue', async () => {
      const core = fakePatientCore([]);
      const r = await mint(fakeMall(), core, {}, { retryContext: { attempts: 1, lastFailureReason: 'x', lastFailureDetail: null } });
      assert.equal(r.reason, CmcErrorIds.MEMBER_ACCESS_NOT_RETRYABLE);
      assert.equal(core.calls.length, 0);
    });

    it('[MA1A] the two calls share one timeout: the second gets what is left of it', async () => {
      const mall = fakeMall();
      await ledger.writeRecord({ mall }, 'group', { membershipAccessId: 'acc-membership', member: MEMBER, relationshipAccessId: 'acc-rel', counterparty: PATIENT, scopeStreamId: TEAM, childAccessId: 'child-1', childName: 'n', expires: CHILD.expires, attribution: 'stamped', state: 'live', stateChangedAt: 1 });
      const core = fakePatientCore([{ status: 404, body: {} }, created201()]);
      const r = await mint(mall, core, {}, { timeoutMs: 50 });
      assert.equal(r.ok, true, JSON.stringify(r));
    });
  });

  describe('[CMCMA-REG] the per-worker registry', () => {
    it('[MA20] rate limit: a membership gets ratePerMinute hits in a sliding minute', () => {
      let t = 0;
      const reg = createMemberMintRegistry({ ratePerMinute: 2, maxInFlightPerMembership: 1, now: () => t });
      assert.deepEqual([reg.hit('m'), reg.hit('m'), reg.hit('m'), reg.hit('other')], [true, true, false, true]);
      t = 61_000;
      assert.equal(reg.hit('m'), true);
    });

    it('[MA21] in-flight: one lock per (membership, relationship) at a time; released, or stale after staleMs', () => {
      let t = 0;
      const reg = createMemberMintRegistry({ ratePerMinute: 100, maxInFlightPerMembership: 1, staleMs: 1000, now: () => t });
      const key = MemberMintRegistry.keyOf('m', 'r');
      assert.equal(reg.acquire(key), true);
      assert.equal(reg.acquire(key), false);
      assert.equal(reg.acquire(MemberMintRegistry.keyOf('m', 'r2')), true);
      reg.release(key);
      assert.equal(reg.acquire(key), true);
      t = 1001;
      assert.equal(reg.inFlight(key), 0);
      assert.equal(reg.acquire(key), true);
    });
  });

  describe('[CMCMA-LEDGER] the ledger', () => {
    const base = { membershipAccessId: 'm', member: MEMBER, relationshipAccessId: 'r', counterparty: PATIENT, scopeStreamId: TEAM, childAccessId: 'c', childName: 'n', expires: 50, attribution: 'stamped', state: 'live', stateChangedAt: 1 };

    it('[MA30] records are found by pair, a live one preferred; states change in place; expired non-live records are pruned', async () => {
      const mall = fakeMall({ events: [] });
      const deps = { mall, now: () => 100 };
      const id1 = await ledger.writeRecord(deps, 'group', { ...base, state: 'absent' });
      const id2 = await ledger.writeRecord(deps, 'group', { ...base, childAccessId: 'c2' });
      assert.equal((await ledger.findRecord(deps, 'group', 'm', 'r')).childAccessId, 'c2');
      assert.equal(await ledger.setState(deps, 'group', id2, 'deleted', 'not-the-child'), false, 'compare-and-set: another child, no change');
      assert.equal((await ledger.findRecord(deps, 'group', 'm', 'r')).state, 'live');
      assert.equal(await ledger.setState(deps, 'group', id2, 'deleted', 'c2'), true);
      const all = await ledger.listRecords(deps, 'group');
      assert.deepEqual(all.map((r) => r.state).sort(), ['absent', 'deleted']);
      assert.equal((await ledger.recordsOfMembership(deps, 'group', 'm')).length, 2);
      assert.equal((await ledger.recordsOfRelationship(deps, 'group', 'r')).length, 2);
      assert.equal(await ledger.pruneExpired(deps, 'group'), 2);
      assert.deepEqual(mall.calls.eventsDeleted.sort(), [id1, id2].sort());
      assert.equal((await ledger.listRecords(deps, 'group')).length, 0);
    });

    it('[MA32] an in-place write applies only while the record still names the child it was read with; the ledger is read page by page', async () => {
      const mall = fakeMall({ events: [] });
      const deps = { mall, now: () => 100 };
      await ledger.writeRecord(deps, 'group', base);
      const read = await ledger.findRecord(deps, 'group', 'm', 'r');
      // Another worker replaced the child meanwhile.
      await ledger.writeRecord(deps, 'group', { ...base, childAccessId: 'c-other' }, read);
      assert.equal(await ledger.writeRecord(deps, 'group', { ...base, childAccessId: 'c-mine' }, read), null, 'not applied');
      assert.equal((await ledger.findRecord(deps, 'group', 'm', 'r')).childAccessId, 'c-other');
      // Paging: a fake that honours limit and skip, 2,350 records.
      const many = fakeMall({ events: [] });
      const all = [];
      for (let i = 0; i < 2350; i++) all.push({ id: 'led-' + i, type: C.ET_MEMBER_LEDGER, streamIds: [':_cmc:_internal:members'], content: { ...base, relationshipAccessId: 'r' + i, childAccessId: 'c' + i } });
      many.events.get = async (u, p) => all.slice(p.skip ?? 0, (p.skip ?? 0) + (p.limit ?? all.length));
      assert.equal((await ledger.listRecords({ mall: many }, 'group')).length, 2350);
      assert.equal((await ledger.recordsOfMembership({ mall: many }, 'group', 'm')).length, 2350);
    });

    it('[MA31] a live record past its expiry is kept (the sweep decides), a missing ledger stream reads as empty', async () => {
      const mall = fakeMall({ events: [] });
      const deps = { mall, now: () => 100 };
      await ledger.writeRecord(deps, 'group', base);
      assert.equal(await ledger.pruneExpired(deps, 'group'), 0);
      mall.events.get = async () => { throw new Error('unknown stream'); };
      assert.deepEqual(await ledger.listRecords(deps, 'group'), []);
    });
  });

  describe('[CMCMA-HOOKS] the write-time hooks', () => {
    function errors () {
      return { invalidOperation (message, details) { const e = new Error(message); e.details = details; return e; } };
    }
    function run (mw, ctx, params = {}) {
      return new Promise((resolve) => mw(ctx, params, {}, (err) => resolve(err)));
    }

    it('[MA40] the gate refuses a non-member writer, a rate-limited membership and a second mint in flight; an admitted write holds the lock on the context', async () => {
      const registry = createMemberMintRegistry({ ratePerMinute: 2, maxInFlightPerMembership: 1 });
      const mw = createMemberAccessGateHook({ errors: errors(), mall: fakeMall(), options: OPTIONS, registry });
      const event = () => ({ type: C.ET_MEMBER_ACCESS, streamIds: [TEAM], content: { counterparty: PATIENT } });
      let err = await run(mw, { user: { id: 'group' }, newEvent: event(), access: { id: 'p', type: 'personal', isPersonal: () => true } });
      assert.equal(err?.details?.id, CmcErrorIds.MEMBER_ACCESS_NOT_MEMBER);
      const ctx = { user: { id: 'group' }, newEvent: event(), access: MEMBERSHIP };
      assert.equal(await run(mw, ctx), undefined);
      assert.equal(ctx.cmc.memberMintLock, MemberMintRegistry.keyOf('acc-membership', 'acc-rel'));
      err = await run(mw, { user: { id: 'group' }, newEvent: event(), access: MEMBERSHIP });
      assert.equal(err?.details?.id, CmcErrorIds.MEMBER_ACCESS_IN_FLIGHT);
      registry.release(ctx.cmc.memberMintLock);
      err = await run(mw, { user: { id: 'group' }, newEvent: event(), access: MEMBERSHIP });
      assert.equal(err?.details?.id, CmcErrorIds.MEMBER_ACCESS_RATE_LIMITED, 'third hit in the minute');
      // A gate refusal is an API error with the id.
      err = await run(mw, { user: { id: 'group' }, newEvent: { ...event(), content: { counterparty: PATIENT, expireAfter: 1 } }, access: { ...MEMBERSHIP, id: 'acc-membership-2' } });
      assert.equal(err?.details?.id, CmcErrorIds.MEMBER_ACCESS_EXPIRY_OUT_OF_RANGE);
      assert.equal(await run(mw, { user: { id: 'group' }, newEvent: { type: 'note/txt' } }), undefined, 'other types pass');
    });

    it('[MA41] the outcome fields are stripped from a client create and kept from storage on update; the sweep record is kept whole', () => {
      const mw = createMemberAccessServerOwnedFieldsHook();
      const ctx = { newEvent: { type: C.ET_MEMBER_ACCESS, content: { counterparty: PATIENT, status: 'completed', failure: {}, memberAccess: { accessId: 'x' }, member: MEMBER, relationshipAccessId: 'r' } } };
      mw(ctx, {}, {}, () => {});
      assert.deepEqual(ctx.newEvent.content, { counterparty: PATIENT });
      const stored = { type: C.ET_MEMBER_ACCESS, content: { counterparty: PATIENT, status: 'completed', memberAccess: { accessId: 'x' }, member: MEMBER, relationshipAccessId: 'r' } };
      const sent = { type: C.ET_MEMBER_ACCESS, content: { counterparty: PATIENT, status: 'pending', memberAccess: { accessId: 'forged' }, note: 1 } };
      assert.deepEqual(preserveServerOwnedContent(stored, sent), { ...stored.content, note: 1 });
      const sweep = { type: C.ET_MEMBER_REVOKE, content: { member: MEMBER, records: [], outcome: [] } };
      assert.deepEqual(preserveServerOwnedContent(sweep, { type: C.ET_MEMBER_REVOKE, content: { records: [{ forged: true }] } }), sweep.content);
    });
  });

  describe('[CMCMA-DISP] the synchronous dispatch', () => {
    it('[MA50] the response carries the endpoint once beside the row as stored (completed, with the token-less record); the lock is released; a failure is never queued', async () => {
      const mall = fakeMall();
      const core = fakePatientCore([created201()]);
      const registry = createMemberMintRegistry({ ratePerMinute: 10, maxInFlightPerMembership: 1 });
      const key = MemberMintRegistry.keyOf('acc-membership', 'acc-rel');
      assert.equal(registry.acquire(key), true);
      const ev = trigger();
      mall.eventsMap.set(ev.id, structuredClone(ev));
      const mw = dispatchMod.createDispatchMiddleware({
        mall, fetch: core.fetch, selfIdentityFor: () => GROUP, memberAccess: OPTIONS, mintRegistry: registry,
      }, () => ({ triggerAccess: { id: 'acc-membership' } }));
      const result = { event: structuredClone(ev) };
      await new Promise((resolve) => mw({ user: { id: 'group' }, cmc: { memberMintLock: key } }, {}, result, resolve));
      assert.equal(result.memberAccess.apiEndpoint, 'https://child-tok@patient.example.com/');
      assert.equal(result.event.content.status, 'completed');
      assert.deepEqual(result.event.content.memberAccess, { accessId: 'child-1', name: CHILD.name, expires: CHILD.expires, attribution: 'stamped' });
      assert.deepEqual(result.event.content.member, MEMBER);
      noTokenIn(result.event, 'the stored trigger');
      noTokenIn(mall.eventsMap.get('trig-1'), 'the stored row');
      assert.equal(registry.inFlight(key), 0, 'the lock is released');

      // A failed mint: the row says failed with a bounded detail, no retry event.
      const mall2 = fakeMall();
      const ev2 = trigger();
      mall2.eventsMap.set(ev2.id, structuredClone(ev2));
      const mw2 = dispatchMod.createDispatchMiddleware({
        mall: mall2, fetch: fakePatientCore([{ status: 503, body: { error: { id: 'x' }, token: 'leak' } }]).fetch, selfIdentityFor: () => GROUP, memberAccess: OPTIONS,
      }, () => ({ triggerAccess: { id: 'acc-membership' } }));
      const result2 = { event: structuredClone(ev2) };
      await new Promise((resolve) => mw2({ user: { id: 'group' } }, {}, result2, resolve));
      assert.equal(result2.memberAccess, undefined);
      assert.equal(result2.event.content.status, 'failed');
      assert.equal(result2.event.content.failure.reason, CmcErrorIds.MEMBER_ACCESS_PEER_UNREACHABLE);
      assert.equal(JSON.stringify(result2.event).includes('leak'), false);
      assert.equal(mall2.calls.eventsCreated.some((e) => e.type === C.ET_RETRY), false, 'never enqueued');
      assert.ok(dispatchMod.NEVER_ENQUEUE_TYPES.has(C.ET_MEMBER_ACCESS));
      assert.ok(dispatchMod.SYNC_DISPATCH_TYPES.has(C.ET_MEMBER_ACCESS));
    });
  });
});
