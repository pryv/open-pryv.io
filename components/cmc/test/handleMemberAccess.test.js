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
const { createMemberMintRegistry, MemberMintRegistry, memberMintLimitsFromConfig, settleMemberMint } = require('../src/memberMintRegistry.ts');
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

/**
 * A mall like the real one where it matters here: a caller-supplied event id
 * is kept, a taken id (a deleted event keeps its id) is refused with
 * item-already-exists, a deleted event stays readable by id but leaves the
 * listings. `calls.accessesGet` counts the full loads of the accesses,
 * `calls.eventsGet` the ledger pages read.
 */
function fakeMall (opts = {}) {
  const accesses = new Map((opts.accesses ?? [MEMBERSHIP, RELATIONSHIP]).map((a) => [a.id, a]));
  const events = new Map((opts.events ?? [INVITE]).map((e) => [e.id, e]));
  const calls = { eventsCreated: [], eventsUpdated: [], eventsDeleted: [], streamsCreated: [], accessesGet: 0, eventsGet: 0, eventsGetOne: 0 };
  let seq = 0;
  const mall = {
    calls,
    accesses: {
      async get () { calls.accessesGet += 1; return [...accesses.values()]; },
      async getOne (u, { id }) { return accesses.get(id) ?? null; },
    },
    events: {
      async create (u, p) {
        const id = p.id ?? ('led' + String(++seq).padStart(22, '0'));
        if (events.has(id)) throw Object.assign(new Error('An event with id ' + id + ' already exists'), { id: 'item-already-exists' });
        const ev = { ...p, id };
        events.set(id, ev);
        calls.eventsCreated.push(ev);
        return ev;
      },
      async get (u, p) {
        calls.eventsGet += 1;
        const any = p?.streams?.[0]?.any;
        return [...events.values()].filter((e) => e.deleted == null && (!Array.isArray(any) || (e.streamIds ?? []).some((s) => any.includes(s))));
      },
      async getOne (u, id) { calls.eventsGetOne += 1; return events.get(id) ?? null; },
      async updateWithMerge (...a) { return fakeUpdateWithMerge(this, ...a); },
      async update (u, e) { events.set(e.id, e); calls.eventsUpdated.push(e); return e; },
      async delete (u, e) { events.set(e.id, { id: e.id, deleted: 1 }); calls.eventsDeleted.push(e.id); },
    },
    streams: { async create (u, p) { calls.streamsCreated.push(p.id); return { id: p.id }; } },
  };
  mall.accessesMap = accesses;
  mall.eventsMap = events;
  return mall;
}

/** A record written the way it was before the lookup by pair id (a random id). */
function legacyRecord (mall, content, id = 'c' + Math.random().toString(36).slice(2, 12).padEnd(24, '0')) {
  const ev = { id, type: C.ET_MEMBER_LEDGER, streamIds: [':_cmc:_internal:members'], time: 1, content };
  mall.eventsMap.set(id, ev);
  return id;
}

/** A store honouring `ifEquals` like the cluster one; `failEvery` makes every n-th set lose. */
function fakeKv ({ failEvery = 0, throws = false } = {}) {
  const map = new Map();
  let sets = 0;
  return {
    map,
    down: throws,
    async get (k) { if (this.down) throw new Error('kv down'); return map.has(k) ? JSON.parse(map.get(k)) : null; },
    async set (k, v, o = {}) {
      if (this.down) throw new Error('kv down');
      sets += 1;
      if (failEvery > 0 && sets % failEvery === 0) return false;
      if (o.ifEquals !== undefined && (map.get(k) ?? 'null') !== JSON.stringify(o.ifEquals ?? null)) return false;
      map.set(k, JSON.stringify(v));
      return true;
    },
  };
}

function registryOf (over = {}) {
  const { limits, ...rest } = over;
  return createMemberMintRegistry({
    maxInFlightPerMembership: 1,
    ...rest,
    limits: { mint: { burst: 100, perMinute: 100 }, ask: { burst: 100, perMinute: 100 }, ...(limits ?? {}) },
  });
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
      return Promise.resolve({ status: spec.status, ok: spec.status >= 200 && spec.status < 300, headers: { get: (name) => spec.headers?.[name.toLowerCase()] ?? null }, async json () { return spec.body; }, async text () { return JSON.stringify(spec.body); } });
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

    it('[HMA01] only a membership access may ask: a personal token, a counterparty access or no access get not-member', async () => {
      for (const membershipAccess of [null, { id: 'p', type: 'personal', isPersonal: () => true }, RELATIONSHIP]) {
        const r = await gate({ membershipAccess });
        assert.equal(r.ok, false);
        assert.equal(r.reason, CmcErrorIds.MEMBER_ACCESS_NOT_MEMBER);
      }
    });

    it('[HMA02] the scope asked must be the trigger stream or under it; the trigger must sit on a scope stream', async () => {
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

    it('[HMA03] no relationship with that patient under the scope, or one whose handshake never completed, is relationship-not-found', async () => {
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

    it('[HMA04] the permissions default to the offered data streams at read; the channel streams are never delegated', async () => {
      const r = await gate();
      assert.equal(r.ok, true, JSON.stringify(r));
      assert.deepEqual(r.target.permissions, [{ streamId: 'vitals', level: 'read' }, { streamId: 'notes', level: 'read' }]);
      assert.equal(r.target.expireAfter, 86400);
      assert.equal(r.target.grantDelegable, true);
      assert.equal(r.target.grantApiEndpoint, GRANT_ENDPOINT);
    });

    it('[HMA05] permissions above the offer, outside it, on a cmc stream, or with no readable offer are permissions-not-subset', async () => {
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
      assert.equal(noOffer.reason, CmcErrorIds.MEMBER_ACCESS_RELATIONSHIP_NOT_FOUND, 'the invite is gone: invite the patient again');
      assert.equal(noOffer.detail.reason, 'offer-not-found');
    });

    it('[HMA06] expireAfter must sit within the per-core bounds', async () => {
      assert.equal((await gate({ content: { expireAfter: 30 } })).reason, CmcErrorIds.MEMBER_ACCESS_EXPIRY_OUT_OF_RANGE);
      assert.equal((await gate({ content: { expireAfter: 604801 } })).reason, CmcErrorIds.MEMBER_ACCESS_EXPIRY_OUT_OF_RANGE);
      assert.equal((await gate({ content: { expireAfter: 3600 } })).target.expireAfter, 3600);
    });

    it('[HMA07] the config reader falls back to the defaults for anything unset or invalid', () => {
      const values = { 'cmc:memberAccess:defaultTtl': 10, 'cmc:memberAccess:maxTtl': -1, 'cmc:memberAccess:allowNameOnly': false };
      const o = memberAccessOptionsFromConfig({ get: (k) => values[k] });
      assert.deepEqual(o, { defaultTtl: 60, minTtl: 60, maxTtl: 604800, allowNameOnly: false }, 'the default is clamped into the bounds');
      const o2 = memberAccessOptionsFromConfig({ get: (k) => ({ 'cmc:memberAccess:defaultTtl': 999_999, 'cmc:memberAccess:maxTtl': 3600 })[k] });
      assert.deepEqual([o2.defaultTtl, o2.maxTtl], [3600, 3600]);
    });
  });

  describe('[CMCMA-MINT] the mint through the grant', () => {
    it('[HMA10] a first ask mints a stamped child, records it, and answers the endpoint once; the trigger record carries no token', async () => {
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
      assert.equal(r.mintOutcome, 'minted');
      noTokenIn(r.memberAccess, 'memberAccess');
      const rec = await ledger.findRecord({ mall }, 'group', 'acc-membership', 'acc-rel');
      assert.equal(rec.eventId, ledger.pairEventIdOf('acc-membership', 'acc-rel'), 'recorded at the pair\'s id');
      assert.equal(rec.state, 'live');
      assert.equal(rec.childAccessId, 'child-1');
      assert.equal(rec.attribution, 'stamped');
      assert.deepEqual(rec.counterparty, PATIENT);
      noTokenIn(mall.calls.eventsCreated, 'the ledger');
      assert.ok(mall.calls.streamsCreated.includes(':_cmc:_internal:members'), 'the ledger stream is ensured');
    });

    it('[HMA11] a live record is reused: the child is read by id through the grant and its token re-read, nothing is created', async () => {
      const mall = fakeMall();
      await ledger.writeRecord({ mall }, 'group', { membershipAccessId: 'acc-membership', member: MEMBER, relationshipAccessId: 'acc-rel', counterparty: PATIENT, scopeStreamId: TEAM, childAccessId: 'child-1', childName: 'n', expires: CHILD.expires, attribution: 'stamped', state: 'live', stateChangedAt: 1 });
      const core = fakePatientCore([{ status: 200, body: { access: CHILD } }]);
      const r = await mint(mall, core, {});
      assert.equal(r.ok, true, JSON.stringify(r));
      assert.equal(r.mintOutcome, 'reused');
      assert.deepEqual(core.calls.map((c) => c.method + ' ' + c.path), ['GET /accesses/child-1']);
      assert.equal(r.response.apiEndpoint, 'https://child-tok@patient.example.com/');
      assert.equal(mall.calls.eventsCreated.length, 1, 'the record is not duplicated');
      assert.equal(mall.calls.eventsUpdated.length, 0, 'a record that already says this child is not written again');
      // A child whose expiry moved is recorded again, in place.
      const later = fakePatientCore([{ status: 200, body: { access: { ...CHILD, expires: CHILD.expires - 10 } } }]);
      assert.equal((await mint(mall, later, {})).ok, true);
      assert.equal(mall.calls.eventsUpdated.length, 1);
      assert.equal(mall.calls.eventsCreated.length, 1);
    });

    it('[MA1G] a record at a random id (written before the lookup by pair id) is found by a scan and moved to the pair\'s id when written', async () => {
      const mall = fakeMall();
      const oldId = legacyRecord(mall, { membershipAccessId: 'acc-membership', member: MEMBER, relationshipAccessId: 'acc-rel', counterparty: PATIENT, scopeStreamId: TEAM, childAccessId: 'child-1', childName: 'n', expires: CHILD.expires, attribution: 'stamped', state: 'live', stateChangedAt: 1 });
      const core = fakePatientCore([{ status: 200, body: { access: CHILD } }]);
      const r = await mint(mall, core, {});
      assert.equal(r.ok, true, JSON.stringify(r));
      assert.equal(r.mintOutcome, 'reused');
      assert.deepEqual(core.calls.map((c) => c.method), ['GET'], 'found: reused, not minted again');
      assert.deepEqual(mall.calls.eventsDeleted, [oldId], 'the old record is removed');
      const all = await ledger.listRecords({ mall }, 'group');
      assert.deepEqual(all.map((x) => [x.eventId, x.childAccessId]), [[ledger.pairEventIdOf('acc-membership', 'acc-rel'), 'child-1']]);
    });

    it('[MA1H] the handler uses what the gate resolved: no second load of the accesses; a target of another membership is not used', async () => {
      const mall = fakeMall();
      const gate = await resolveMintTarget({ userId: 'group', membershipAccess: MEMBERSHIP, triggerStreamIds: [TEAM], content: { counterparty: PATIENT }, deps: { mall, options: OPTIONS } });
      assert.equal(gate.ok, true);
      assert.equal(mall.calls.accessesGet, 1);
      let r = await mint(mall, fakePatientCore([created201()]), {}, { target: gate.target, triggerAccess: { id: 'acc-membership' } });
      assert.equal(r.ok, true, JSON.stringify(r));
      assert.equal(mall.calls.accessesGet, 1, 'one load of the accesses for the whole ask');
      const other = { ...gate.target, membershipAccess: { ...MEMBERSHIP, id: 'acc-other' } };
      const mall2 = fakeMall();
      const core = fakePatientCore([created201()]);
      r = await mint(mall2, core, {}, { target: other, triggerAccess: { id: 'acc-membership' } });
      assert.equal(r.ok, true, JSON.stringify(r));
      assert.equal(mall2.calls.accessesGet, 1, 'resolved again');
      assert.equal(core.calls[0].body.name, childNameFor(MEMBER, 'acc-membership', 'acc-rel'), 'for the membership that wrote the trigger');
    });

    it('[HMA12] a recorded child about to expire, or without the permissions asked, is deleted and a new one minted', async () => {
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

    it('[HMA13] a recorded child the patient deleted (404) is marked absent and a new one minted while the grant lasts', async () => {
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

    it('[HMA14] an older patient core refusing the stamp gets a second, stampless mint reported name-only; with allowNameOnly off it is a failure', async () => {
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

    it('[HMA15] the grant is the real bound: a 403 forbidden from the create is permissions-not-subset; a duplicate name held by a live access is peer-rejected and never answered with a delete', async () => {
      let core = fakePatientCore([{ status: 403, body: { error: { id: 'forbidden', message: 'insufficient' } } }]);
      let r = await mint(fakeMall(), core, {});
      assert.equal(r.reason, CmcErrorIds.MEMBER_ACCESS_PERMISSIONS_NOT_SUBSET);
      assert.deepEqual(r.detail, { peerErrorId: 'forbidden', httpStatus: 403 });
      const taken = { status: 400, body: { error: { id: 'item-already-exists', message: 'name', data: { accesses: [{ token: 'child-tok' }] } } } };
      // The namesake is live (or the list unreadable): left alone.
      for (const listed of [
        { status: 200, body: { accesses: [{ id: 'live-1', expires: 2_000_000 }] } },
        { status: 503, body: null },
      ]) {
        core = fakePatientCore(({ method, path, body }) => {
          if (method === 'POST') return taken;
          if (method === 'GET' && path.endsWith('/accesses')) {
            if (listed.body != null) listed.body.accesses[0].name = core.calls[0].body.name;
            return listed;
          }
          return null;
        });
        r = await mint(fakeMall(), core, {});
        assert.equal(r.reason, CmcErrorIds.MEMBER_ACCESS_PEER_REJECTED);
        assert.deepEqual(r.detail, { peerErrorId: 'item-already-exists', httpStatus: 400 }, 'no peer body in the detail');
        assert.deepEqual(core.calls.map((c) => c.method), ['POST', 'GET'], 'no delete');
      }
    });

    it('[HMA18] a duplicate name held by an EXPIRED access (its record pruned) is deleted and the mint tried once more', async () => {
      const taken = { status: 400, body: { error: { id: 'item-already-exists', message: 'name' } } };
      let posts = 0;
      const core = fakePatientCore(({ method, path }) => {
        if (method === 'POST') return ++posts === 1 ? taken : created201();
        if (method === 'GET' && path.endsWith('/accesses')) {
          return { status: 200, body: { accesses: [{ id: 'other', name: 'cmc-member--someone-else', expires: 1 }, { id: 'old-child', name: core.calls[0].body.name, expires: 999_000 }] } };
        }
        if (method === 'DELETE' && path.endsWith('/accesses/old-child')) return { status: 200, body: { accessDeletion: { id: 'old-child' } } };
        return null;
      });
      const r = await mint(fakeMall(), core, {});
      assert.equal(r.ok, true, JSON.stringify(r));
      assert.equal(r.mintOutcome, 'minted');
      assert.equal(r.memberAccess.accessId, CHILD.id);
      assert.deepEqual(core.calls.map((c) => c.method + ' ' + c.path.replace(/^.*\/accesses/, 'accesses')), ['POST accesses', 'GET accesses', 'DELETE accesses/old-child', 'POST accesses']);
      assert.equal(core.calls[3].body.name, core.calls[0].body.name, 'same name');
      // Twice taken: no third attempt, peer-rejected.
      const again = fakePatientCore(({ method, path }) => {
        if (method === 'POST') return taken;
        if (method === 'GET') return { status: 200, body: { accesses: [{ id: 'old-child', name: again.calls[0].body.name, expires: 999_000 }] } };
        if (method === 'DELETE') return { status: 404, body: { error: { id: 'unknown-resource' } } };
        return null;
      });
      const r2 = await mint(fakeMall(), again, {});
      assert.equal(r2.reason, CmcErrorIds.MEMBER_ACCESS_PEER_REJECTED);
      assert.deepEqual(again.calls.map((c) => c.method), ['POST', 'GET', 'DELETE', 'POST']);
    });

    it('[HMA16] a 5xx, a network error or a timeout is peer-unreachable; the ledger gets nothing', async () => {
      for (const answer of [{ status: 503, body: null }, new Error('ECONNREFUSED'), Object.assign(new Error('aborted'), { name: 'AbortError' })]) {
        const mall = fakeMall();
        const r = await mint(mall, fakePatientCore([answer]), {});
        assert.equal(r.reason, CmcErrorIds.MEMBER_ACCESS_PEER_UNREACHABLE, String(answer));
        assert.equal(mall.calls.eventsCreated.length, 0);
        noTokenIn(r, 'the failure');
      }
    });

    it('[HMA16b] a refused destination says so in the detail (kind and host only); the ledger gets nothing', async () => {
      const mall = fakeMall();
      const refusal = Object.assign(new Error("peer call refused: address, host '10.0.0.1'"), { code: 'EPEERREFUSED', kind: 'address', host: '10.0.0.1' });
      const r = await mint(mall, fakePatientCore([refusal]), {});
      assert.equal(r.reason, CmcErrorIds.MEMBER_ACCESS_PEER_UNREACHABLE);
      assert.deepEqual(r.detail, { reason: 'refused', kind: 'address', host: '10.0.0.1' });
      assert.equal(mall.calls.eventsCreated.length, 0);
      noTokenIn(r, 'the failure');
    });

    it('[HMA17] a non-delegable grant (the invite did not ask accessType app) fails before any call', async () => {
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

    it('[HMA1B] a stale child whose deletion the patient core does not confirm is never minted over: the record stays live, the ask fails, a later sweep deletes it', async () => {
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

    it('[CRL27] a 429 or 408 from the patient core is "unreachable, try again" (the member app may retry), never "rejected", with its Retry-After; a 400 stays rejected', async () => {
      for (const [answer, reason, detail] of [
        [{ status: 429, body: null, headers: { 'retry-after': '30' } }, CmcErrorIds.MEMBER_ACCESS_PEER_UNREACHABLE, { httpStatus: 429, retryAfterMs: 30_000 }],
        [{ status: 408, body: null }, CmcErrorIds.MEMBER_ACCESS_PEER_UNREACHABLE, { httpStatus: 408 }],
        [{ status: 400, body: { error: { id: 'x' } } }, CmcErrorIds.MEMBER_ACCESS_PEER_REJECTED, null],
      ]) {
        const mall = fakeMall();
        await ledger.writeRecord({ mall }, 'group', { membershipAccessId: 'acc-membership', member: MEMBER, relationshipAccessId: 'acc-rel', counterparty: PATIENT, scopeStreamId: TEAM, childAccessId: 'child-1', childName: 'n', expires: CHILD.expires, attribution: 'stamped', state: 'live', stateChangedAt: 1 });
        const core = fakePatientCore([{ status: 200, body: { access: { ...CHILD, expires: 1_000_000 + 100 } } }, answer]);
        const r = await mint(mall, core, {});
        assert.equal(r.reason, reason, JSON.stringify(r));
        if (detail != null) assert.deepEqual(r.detail, detail);
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
      assert.deepEqual((await ledger.listRecords({ mall: mall3 }, 'group')).map((x) => x.state), ['deleted']);
    });

    it('[MA1F] a child the finished mint could not delete after its membership ended is left residual, for the periodic pass', async () => {
      const mall = fakeMall({ accesses: [{ ...MEMBERSHIP, expires: 1_000_000 + 7200 }, RELATIONSHIP] });
      const core = fakePatientCore(({ n }) => {
        if (n === 0) { mall.accessesMap.get('acc-membership').expires = 1_000_000 - 1; return created201(); }
        return { status: 503, body: {} };
      });
      const r = await mint(mall, core, {});
      assert.equal(r.reason, CmcErrorIds.MEMBER_ACCESS_MEMBERSHIP_GONE);
      assert.deepEqual(core.calls.map((c) => c.method), ['POST', 'DELETE']);
      const records = await ledger.listRecords({ mall }, 'group');
      assert.deepEqual(records.map((x) => [x.childAccessId, x.state]), [[records[0].childAccessId, 'residual']]);
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

    it('[MA1J] an ask admitted without a mint token mints only once it gets one; refused, the recorded child is left as it is', async () => {
      const seedLive = async (mall) => ledger.writeRecord({ mall }, 'group', { membershipAccessId: 'acc-membership', member: MEMBER, relationshipAccessId: 'acc-rel', counterparty: PATIENT, scopeStreamId: TEAM, childAccessId: 'child-1', childName: 'n', expires: CHILD.expires, attribution: 'stamped', state: 'live', stateChangedAt: 1 });
      const refuse = { async ensure () { return { ok: false, retryAfterSeconds: 7 }; } };
      // Stale child: not deleted, the ask fails rate-limited.
      let mall = fakeMall();
      await seedLive(mall);
      let core = fakePatientCore([{ status: 200, body: { access: { ...CHILD, expires: 1_000_000 + 100 } } }]);
      let r = await mint(mall, core, {}, { mintBudget: refuse });
      assert.deepEqual([r.reason, r.detail], [CmcErrorIds.MEMBER_ACCESS_RATE_LIMITED, { retryAfterMs: 7000 }], 'milliseconds, like the other waits on the trigger');
      assert.deepEqual(core.calls.map((c) => c.method), ['GET'], 'no delete, no mint');
      assert.equal((await ledger.findRecord({ mall }, 'group', 'acc-membership', 'acc-rel')).state, 'live');
      // Gone on the patient core: recorded absent, nothing minted.
      mall = fakeMall();
      await seedLive(mall);
      core = fakePatientCore([{ status: 404, body: {} }]);
      r = await mint(mall, core, {}, { mintBudget: refuse });
      assert.equal(r.reason, CmcErrorIds.MEMBER_ACCESS_RATE_LIMITED);
      assert.deepEqual(core.calls.map((c) => c.method), ['GET']);
      // A token granted: minted.
      let asked = 0;
      core = fakePatientCore([created201({ id: 'child-2' })]);
      r = await mint(fakeMall(), core, {}, { mintBudget: { async ensure () { asked += 1; return { ok: true }; } } });
      assert.equal(r.mintOutcome, 'minted');
      assert.equal(asked, 1);
      // A reuse never asks for one.
      mall = fakeMall();
      await seedLive(mall);
      r = await mint(mall, fakePatientCore([{ status: 200, body: { access: CHILD } }]), {}, { mintBudget: refuse });
      assert.equal(r.mintOutcome, 'reused');
    });

    it('[MA19] the handler refuses to run from the retry queue', async () => {
      const core = fakePatientCore([]);
      const r = await mint(fakeMall(), core, {}, { retryContext: { attempts: 1, lastFailureReason: 'x', lastFailureDetail: null } });
      assert.equal(r.reason, CmcErrorIds.MEMBER_ACCESS_NOT_RETRYABLE);
      assert.equal(core.calls.length, 0);
    });

    it('[HMA1A] the two calls share one timeout: the second gets what is left of it', async () => {
      const mall = fakeMall();
      await ledger.writeRecord({ mall }, 'group', { membershipAccessId: 'acc-membership', member: MEMBER, relationshipAccessId: 'acc-rel', counterparty: PATIENT, scopeStreamId: TEAM, childAccessId: 'child-1', childName: 'n', expires: CHILD.expires, attribution: 'stamped', state: 'live', stateChangedAt: 1 });
      const core = fakePatientCore([{ status: 404, body: {} }, created201()]);
      const r = await mint(mall, core, {}, { timeoutMs: 50 });
      assert.equal(r.ok, true, JSON.stringify(r));
    });
  });

  describe('[CMCMA-REG] the registry', () => {
    it('[MA20] a token bucket per membership and kind: the burst, then the refill; a refund never exceeds the burst; a refund the store cannot take is a no-op', async () => {
      let t = 1_000_000;
      const reg = registryOf({ limits: { mint: { burst: 2, perMinute: 60 } }, now: () => t });
      const ok = (r) => r.ok;
      assert.deepEqual([await reg.reserve('mint', 'm'), await reg.reserve('mint', 'm')].map(ok), [true, true]);
      assert.deepEqual(await reg.reserve('mint', 'm'), { ok: false, retryAfterSeconds: 1 });
      assert.equal((await reg.reserve('mint', 'other')).ok, true, 'per membership');
      assert.equal((await reg.reserve('ask', 'm')).ok, true, 'per kind');
      t += 1000;
      assert.equal((await reg.reserve('mint', 'm')).ok, true, 'one token back after a second at 60 a minute');
      assert.equal((await reg.reserve('mint', 'm')).ok, false);
      // Refunds: two given back, a third would exceed the burst.
      await reg.refund('mint', 'm');
      await reg.refund('mint', 'm');
      await reg.refund('mint', 'm');
      assert.deepEqual([(await reg.reserve('mint', 'm')).ok, (await reg.reserve('mint', 'm')).ok, (await reg.reserve('mint', 'm')).ok], [true, true, false]);
      // A refund the store cannot take: no throw, nothing given back.
      const kv = fakeKv();
      const reg2 = registryOf({ limits: { mint: { burst: 1, perMinute: 1 } }, store: kv, now: () => t });
      assert.equal((await reg2.reserve('mint', 'm')).ok, true);
      kv.down = true;
      await reg2.refund('mint', 'm');
      kv.down = false;
      assert.equal((await reg2.reserve('mint', 'm')).ok, false, 'the shared bucket is still spent');
    });

    it('[MA22] two registries sharing one store see one budget (the workers of a core)', async () => {
      const kv = fakeKv();
      const a = registryOf({ limits: { mint: { burst: 1, perMinute: 1 } }, store: kv });
      const b = registryOf({ limits: { mint: { burst: 1, perMinute: 1 } }, store: kv });
      assert.equal((await a.reserve('mint', 'm')).ok, true);
      const onB = await b.reserve('mint', 'm');
      assert.equal(onB.ok, false, 'refused on the other worker');
      assert.ok(onB.retryAfterSeconds >= 59, String(onB.retryAfterSeconds));
      await a.refund('mint', 'm');
      assert.equal((await b.reserve('mint', 'm')).ok, true, 'a refund on one worker frees the token for the other');
    });

    it('[MA23] concurrent reserves against a store that loses compare-and-sets all settle: exactly the burst admitted', async () => {
      const kv = fakeKv({ failEvery: 2 });
      const reg = registryOf({ limits: { mint: { burst: 5, perMinute: 1 } }, store: kv, now: () => 1_000_000 });
      const results = await Promise.all(Array.from({ length: 8 }, () => reg.reserve('mint', 'm')));
      assert.equal(results.filter((r) => r.ok).length, 5);
      assert.ok(results.filter((r) => !r.ok).every((r) => r.retryAfterSeconds >= 1));
      assert.ok(JSON.parse(kv.map.get('cmc-member-mint/m')).tokens < 1, 'none double-counted, none lost');
    });

    it('[MA24] a store that fails: the call is counted in this process, never uncounted', async () => {
      const reg = registryOf({ limits: { mint: { burst: 2, perMinute: 1 } }, store: fakeKv({ throws: true }) });
      assert.deepEqual([(await reg.reserve('mint', 'm')).ok, (await reg.reserve('mint', 'm')).ok, (await reg.reserve('mint', 'm')).ok], [true, true, false]);
    });

    it('[MA26] a token counted in this process (the store was down) is refunded here, never to the shared bucket', async () => {
      const kv = fakeKv();
      const reg = registryOf({ limits: { mint: { burst: 1, perMinute: 1 } }, store: kv });
      assert.deepEqual(await reg.reserve('mint', 'm'), { ok: true, via: 'shared' });
      kv.down = true;
      const local = await reg.reserve('mint', 'm');
      assert.deepEqual(local, { ok: true, via: 'local' });
      kv.down = false;
      await reg.refund('mint', 'm', local.via);
      assert.equal((await reg.reserve('mint', 'm')).ok, false, 'the shared bucket gained nothing');
      kv.down = true;
      assert.deepEqual(await reg.reserve('mint', 'm'), { ok: true, via: 'local' }, 'the local token came back');
    });

    it('[MA25] the budgets from config: defaults, the ask budget raised to the mint budget, one notice when a membership falls below half its mint burst', async () => {
      const d = memberMintLimitsFromConfig({ get: () => undefined });
      assert.deepEqual(d, { mint: { burst: 5000, perMinute: 1000 }, ask: { burst: 10000, perMinute: 3000 }, clamped: [] });
      const values = { 'cmc:memberAccess:mintBurst': 50, 'cmc:memberAccess:ratePerMinute': 20, 'cmc:memberAccess:askBurst': 10, 'cmc:memberAccess:askRatePerMinute': -1 };
      const c = memberMintLimitsFromConfig({ get: (k) => values[k] });
      assert.deepEqual(c, { mint: { burst: 50, perMinute: 20 }, ask: { burst: 50, perMinute: 3000 }, clamped: ['askBurst'] });
      const lines = [];
      const reg = registryOf({ limits: { mint: { burst: 4, perMinute: 1 } }, logger: { info: (m, f) => lines.push([m, f]) } });
      for (let i = 0; i < 4; i++) await reg.reserve('mint', 'm-bulk');
      assert.equal(lines.length, 1, JSON.stringify(lines));
      assert.match(lines[0][0], /bulk minting by membership m-bulk/);
      await reg.refund('mint', 'm-bulk');
      await reg.refund('mint', 'm-bulk');
      await reg.refund('mint', 'm-bulk');
      for (let i = 0; i < 3; i++) await reg.reserve('mint', 'm-bulk');
      assert.equal(lines.length, 1, 'once per window');
    });

    it('[MA21] in-flight: one lock per (membership, relationship) at a time; released, or stale after staleMs', () => {
      let t = 0;
      const reg = registryOf({ staleMs: 1000, now: () => t });
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

    it('[MA30] one record per pair, at the pair\'s id: a second create for the pair does not apply; states change in place; a live record at a random id is preferred to a settled one', async () => {
      const mall = fakeMall({ events: [] });
      const deps = { mall, now: () => 100 };
      const id1 = await ledger.writeRecord(deps, 'group', { ...base, state: 'absent' });
      assert.equal(id1, ledger.pairEventIdOf('m', 'r'));
      assert.equal(await ledger.writeRecord(deps, 'group', { ...base, childAccessId: 'c2' }), null, 'the pair is recorded already (another worker)');
      assert.equal((await ledger.findRecord(deps, 'group', 'm', 'r')).childAccessId, 'c');
      assert.equal(await ledger.setState(deps, 'group', id1, 'deleted', 'not-the-child'), false, 'compare-and-set: another child, no change');
      assert.equal(await ledger.setState(deps, 'group', id1, 'deleted', 'c'), true);
      assert.equal((await ledger.findRecord(deps, 'group', 'm', 'r')).state, 'deleted');
      // Two records at random ids (written before the lookup by id): a live one wins.
      const old = fakeMall({ events: [] });
      legacyRecord(old, { ...base, state: 'absent', stateChangedAt: 5 });
      legacyRecord(old, { ...base, childAccessId: 'c2' });
      assert.equal((await ledger.findRecord({ mall: old }, 'group', 'm', 'r')).childAccessId, 'c2');
      assert.equal((await ledger.recordsOfMembership({ mall: old }, 'group', 'm')).length, 2);
      assert.equal((await ledger.recordsOfRelationship({ mall: old }, 'group', 'r')).length, 2);
    });

    it('[MA33] expired settled records are pruned; one at its pair\'s id only once its membership is gone (the id is never asked for again)', async () => {
      const mall = fakeMall({ events: [] });
      const deps = { mall, now: () => 100 };
      const atPair = await ledger.writeRecord(deps, 'group', { ...base, state: 'absent' });
      const atPairGone = await ledger.writeRecord(deps, 'group', { ...base, membershipAccessId: 'm-gone', state: 'deleted' });
      const legacy = legacyRecord(mall, { ...base, relationshipAccessId: 'r-old', state: 'deleted' });
      await ledger.writeRecord(deps, 'group', { ...base, relationshipAccessId: 'r-live' });
      assert.equal(await ledger.pruneExpired(deps, 'group'), 1, 'without a membership check, only the record at a random id');
      assert.deepEqual(mall.calls.eventsDeleted, [legacy]);
      const gone = async (id) => id === 'm-gone';
      assert.equal(await ledger.pruneExpired(deps, 'group', { isMembershipGone: gone }), 1);
      assert.deepEqual(mall.calls.eventsDeleted, [legacy, atPairGone]);
      assert.deepEqual((await ledger.listRecords(deps, 'group')).map((r) => r.eventId).sort(), [atPair, ledger.pairEventIdOf('m', 'r-live')].sort());
      // From a list handed over: no read of the ledger.
      const pages = mall.calls.eventsGet;
      assert.equal(await ledger.pruneExpired(deps, 'group', { records: [], isMembershipGone: gone }), 0);
      assert.equal(mall.calls.eventsGet, pages);
    });

    it('[MA34] the pair\'s id held by something else (a deleted record, a foreign event): the record is kept at a random id and found by a scan', async () => {
      const mall = fakeMall({ events: [] });
      const deps = { mall, now: () => 100 };
      const pairId = ledger.pairEventIdOf('m', 'r');
      mall.eventsMap.set(pairId, { id: pairId, deleted: 1 });
      const id = await ledger.writeRecord(deps, 'group', base);
      assert.notEqual(id, pairId);
      const found = await ledger.findRecord(deps, 'group', 'm', 'r');
      assert.equal(found?.eventId, id);
      // A foreign event at the id (not the ledger's) is never taken for the record.
      const mall2 = fakeMall({ events: [] });
      mall2.eventsMap.set(pairId, { id: pairId, type: C.ET_MEMBER_LEDGER, streamIds: [TEAM], content: { ...base, childAccessId: 'forged' } });
      assert.equal(await ledger.findRecord({ mall: mall2 }, 'group', 'm', 'r'), null);
      const id2 = await ledger.writeRecord({ mall: mall2 }, 'group', base);
      assert.equal((await ledger.findRecord({ mall: mall2 }, 'group', 'm', 'r')).eventId, id2);
    });

    it('[MA32] an in-place write applies only while the record still names the child it was read with; a record at its pair\'s id is one read; a scan of a large ledger sees every record', async () => {
      const mall = fakeMall({ events: [] });
      const deps = { mall, now: () => 100 };
      await ledger.writeRecord(deps, 'group', base);
      const read = await ledger.findRecord(deps, 'group', 'm', 'r');
      // Another worker replaced the child meanwhile.
      await ledger.writeRecord(deps, 'group', { ...base, childAccessId: 'c-other' }, read);
      assert.equal(await ledger.writeRecord(deps, 'group', { ...base, childAccessId: 'c-mine' }, read), null, 'not applied');
      assert.equal((await ledger.findRecord(deps, 'group', 'm', 'r')).childAccessId, 'c-other');
      // A fake that honours limit and skip, 2,350 records at random ids plus
      // one at its pair's id.
      const many = fakeMall({ events: [] });
      const all = [];
      for (let i = 0; i < 2350; i++) all.push({ id: 'led-' + i, type: C.ET_MEMBER_LEDGER, streamIds: [':_cmc:_internal:members'], content: { ...base, relationshipAccessId: 'r' + i, childAccessId: 'c' + i } });
      many.events.get = async (u, p) => { many.calls.eventsGet += 1; return all.slice(p.skip ?? 0, (p.skip ?? 0) + (p.limit ?? all.length)); };
      await ledger.writeRecord({ mall: many }, 'group', { ...base, relationshipAccessId: 'r-new' });
      const before = { get: many.calls.eventsGet, getOne: many.calls.eventsGetOne };
      assert.equal((await ledger.findRecord({ mall: many }, 'group', 'm', 'r-new')).relationshipAccessId, 'r-new');
      assert.deepEqual([many.calls.eventsGet - before.get, many.calls.eventsGetOne - before.getOne], [0, 1], 'one read by id, no page');
      // A record at a random id: found by the scan (3 pages).
      assert.equal((await ledger.findRecord({ mall: many }, 'group', 'm', 'r1234')).childAccessId, 'c1234');
      assert.equal((await ledger.listRecords({ mall: many }, 'group')).length, 2350);
      assert.equal((await ledger.recordsOfMembership({ mall: many }, 'group', 'm')).length, 2350);
      // No ceiling: 120,000 records are all listed.
      const huge = [];
      for (let i = 0; i < 120_000; i++) huge.push({ id: 'h' + i, type: C.ET_MEMBER_LEDGER, streamIds: [':_cmc:_internal:members'], content: { ...base, relationshipAccessId: 'r' + i, childAccessId: 'c' + i } });
      const big = { events: { async get (u, p) { return huge.slice(p.skip, p.skip + p.limit); } } };
      assert.equal((await ledger.listRecords({ mall: big }, 'group')).length, 120_000);
    });

    it('[MA36] two writers moving the same record at a random id to the pair\'s id, for the same child, both apply; one record is left', async () => {
      const mall = fakeMall({ events: [] });
      const deps = { mall, now: () => 100 };
      legacyRecord(mall, base);
      const existing = await ledger.findRecord(deps, 'group', 'm', 'r');
      const pairId = ledger.pairEventIdOf('m', 'r');
      assert.equal(await ledger.writeRecord(deps, 'group', { ...base, expires: 60 }, existing), pairId);
      assert.equal(await ledger.writeRecord(deps, 'group', { ...base, expires: 60 }, existing), pairId, 'the same child at the pair\'s id: applied, not a lost race');
      assert.deepEqual((await ledger.listRecords(deps, 'group')).map((r) => [r.eventId, r.childAccessId]), [[pairId, 'c']]);
      // Another child recorded there meanwhile: not applied.
      assert.equal(await ledger.writeRecord(deps, 'group', { ...base, childAccessId: 'c-other' }, existing), null);
    });

    it('[MA35] an account a scan found without records at random ids is not scanned again for a pair with no record; a taken child name makes the next lookup scan', async () => {
      const mall = fakeMall({ events: [] });
      const deps = { mall, now: () => 100 };
      await ledger.writeRecord(deps, 'group', base);
      assert.equal(await ledger.findRecord(deps, 'group', 'm', 'r-none'), null);
      const pages = mall.calls.eventsGet;
      assert.equal(await ledger.findRecord(deps, 'group', 'm', 'r-none2'), null);
      assert.equal(mall.calls.eventsGet, pages, 'no scan');
      // A record at a random id appearing later (here, by hand) is found once
      // the scan is forgotten (the mint does so on a taken child name).
      legacyRecord(mall, { ...base, relationshipAccessId: 'r-none2' });
      assert.equal(await ledger.findRecord(deps, 'group', 'm', 'r-none2'), null);
      ledger.forgetScan(deps, 'group');
      assert.equal((await ledger.findRecord(deps, 'group', 'm', 'r-none2'))?.relationshipAccessId, 'r-none2');
      assert.ok(mall.calls.eventsGet > pages);
      // An account holding such a record keeps being scanned.
      const pages2 = mall.calls.eventsGet;
      await ledger.findRecord(deps, 'group', 'm', 'r-none3');
      assert.ok(mall.calls.eventsGet > pages2);
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
      return {
        invalidOperation (message, details) { const e = new Error(message); e.details = details; return e; },
        tooManyAttempts (retryAfterSeconds, options) { const e = new Error(options?.message); e.httpStatus = 429; e.retryAfterSeconds = retryAfterSeconds; e.details = options?.data; return e; },
      };
    }
    function run (mw, ctx, params = {}) {
      return new Promise((resolve) => mw(ctx, params, {}, (err) => resolve(err)));
    }
    const event = (content = {}) => ({ type: C.ET_MEMBER_ACCESS, streamIds: [TEAM], content: { counterparty: PATIENT, ...content } });

    it('[MA40] the gate refuses a non-member writer, a spent budget (429 with the seconds to wait) and a second mint in flight; an admitted write holds the lock, the mint token and the resolved target on the context', async () => {
      const registry = registryOf({ limits: { mint: { burst: 2, perMinute: 1 }, ask: { burst: 10, perMinute: 1 } } });
      const mw = createMemberAccessGateHook({ errors: errors(), mall: fakeMall(), options: OPTIONS, registry });
      let err = await run(mw, { user: { id: 'group' }, newEvent: event(), access: { id: 'p', type: 'personal', isPersonal: () => true } });
      assert.equal(err?.details?.id, CmcErrorIds.MEMBER_ACCESS_NOT_MEMBER);
      const ctx = { user: { id: 'group' }, newEvent: event(), access: MEMBERSHIP };
      assert.equal(await run(mw, ctx), undefined);
      assert.equal(ctx.cmc.memberMintLock, MemberMintRegistry.keyOf('acc-membership', 'acc-rel'));
      assert.deepEqual(ctx.cmc.memberMintReservation, { membershipAccessId: 'acc-membership', held: true, via: 'shared' });
      assert.equal(ctx.cmc.memberMintTarget.relationshipAccess.id, 'acc-rel');
      err = await run(mw, { user: { id: 'group' }, newEvent: event(), access: MEMBERSHIP });
      assert.equal(err?.details?.id, CmcErrorIds.MEMBER_ACCESS_IN_FLIGHT);
      registry.release(ctx.cmc.memberMintLock);
      assert.equal(await run(mw, { user: { id: 'group' }, newEvent: event(), access: MEMBERSHIP }), undefined);
      registry.release(MemberMintRegistry.keyOf('acc-membership', 'acc-rel'));
      err = await run(mw, { user: { id: 'group' }, newEvent: event(), access: MEMBERSHIP });
      assert.equal(err?.httpStatus, 429, 'third new access from a burst of 2');
      assert.deepEqual(err?.details, { id: CmcErrorIds.MEMBER_ACCESS_RATE_LIMITED, retryAfterSeconds: err.retryAfterSeconds });
      assert.ok(err.retryAfterSeconds >= 59, String(err.retryAfterSeconds));
      assert.equal(registry.inFlight(MemberMintRegistry.keyOf('acc-membership', 'acc-rel')), 0, 'a refusal leaves no lock');
      // A gate refusal is an API error with the id.
      err = await run(mw, { user: { id: 'group' }, newEvent: event({ expireAfter: 1 }), access: { ...MEMBERSHIP, id: 'acc-membership-2' } });
      assert.equal(err?.details?.id, CmcErrorIds.MEMBER_ACCESS_EXPIRY_OUT_OF_RANGE);
      assert.equal(await run(mw, { user: { id: 'group' }, newEvent: { type: 'note/txt' } }), undefined, 'other types pass');
    });

    it('[MA42] an invalid ask leaves the mint budget as it was; every ask takes an ask token, a refused one too; a spent mint budget admits an ask whose pair has a live record', async () => {
      const registry = registryOf({ limits: { mint: { burst: 1, perMinute: 1 }, ask: { burst: 4, perMinute: 1 } } });
      const mall = fakeMall();
      const mw = createMemberAccessGateHook({ errors: errors(), mall, options: OPTIONS, registry });
      const ctx = () => ({ user: { id: 'group' }, newEvent: event(), access: MEMBERSHIP });
      // 1: unknown patient: refused by the gate, the mint token untouched.
      let err = await run(mw, { ...ctx(), newEvent: event({ counterparty: { username: 'nobody', host: 'x.example.com' } }) });
      assert.equal(err?.details?.id, CmcErrorIds.MEMBER_ACCESS_RELATIONSHIP_NOT_FOUND);
      // 2: admitted with the one mint token.
      const c2 = ctx();
      assert.equal(await run(mw, c2), undefined);
      registry.release(c2.cmc.memberMintLock);
      // 3: no mint token, no live record: 429, the ask token is spent anyway.
      err = await run(mw, ctx());
      assert.equal(err?.httpStatus, 429);
      // 4: the pair now has a live record: admitted without a mint token.
      await ledger.writeRecord({ mall }, 'group', { membershipAccessId: 'acc-membership', member: MEMBER, relationshipAccessId: 'acc-rel', counterparty: PATIENT, scopeStreamId: TEAM, childAccessId: 'child-1', childName: 'n', expires: CHILD.expires, attribution: 'stamped', state: 'live', stateChangedAt: 1 });
      const c4 = ctx();
      assert.equal(await run(mw, c4), undefined);
      assert.deepEqual(c4.cmc.memberMintReservation, { membershipAccessId: 'acc-membership', held: false });
      registry.release(c4.cmc.memberMintLock);
      // 5: four asks taken (1 to 4): the ask budget refuses before anything else.
      err = await run(mw, ctx());
      assert.equal(err?.httpStatus, 429);
      assert.match(err.message, /member access requests/);
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
      const registry = registryOf();
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

    const PATIENT_Q = { username: 'pat-q', host: 'patient.example.com' };
    const RELATIONSHIP_Q = { ...RELATIONSHIP, id: 'acc-rel-q', clientData: { cmc: { ...RELATIONSHIP.clientData.cmc, counterparty: { ...PATIENT_Q, apiEndpoint: GRANT_ENDPOINT } } } };
    const gateErrors = {
      invalidOperation (message, details) { const e = new Error(message); e.details = details; return e; },
      tooManyAttempts (retryAfterSeconds, options) { const e = new Error(options?.message); e.httpStatus = 429; e.details = options?.data; return e; },
    };

    /** The gate then the synchronous dispatch, as events.create chains them. */
    function pipeline (mall, registry, core, worker = 'w') {
      const gate = createMemberAccessGateHook({ errors: gateErrors, mall, options: OPTIONS, registry });
      const disp = dispatchMod.createDispatchMiddleware({
        mall, fetch: core.fetch, selfIdentityFor: () => GROUP, memberAccess: OPTIONS, mintRegistry: registry,
      }, () => ({ triggerAccess: { id: 'acc-membership' } }));
      let n = 0;
      return async function ask (patient) {
        const ctx = { user: { id: 'group' }, newEvent: { type: C.ET_MEMBER_ACCESS, streamIds: [TEAM], content: { counterparty: patient } }, access: MEMBERSHIP };
        const err = await new Promise((resolve) => gate(ctx, {}, {}, (e) => resolve(e)));
        if (err != null) return { err };
        const ev = trigger({ counterparty: patient }, { id: 'trig-' + worker + '-' + (++n) });
        mall.eventsMap.set(ev.id, structuredClone(ev));
        const result = { event: structuredClone(ev) };
        await new Promise((resolve) => disp(ctx, {}, result, resolve));
        return { result };
      };
    }

    /** Answers a reuse read of child-p and mints any other child. */
    function routedCore (over = {}) {
      return fakePatientCore(({ method, path }) => {
        if (method === 'GET' && path === '/accesses/child-p') return over.get ?? { status: 200, body: { access: { ...CHILD, id: 'child-p' } } };
        if (method === 'POST') return over.post ?? created201({ id: 'child-new-' + Math.random().toString(36).slice(2, 8) });
        return { status: 200, body: {} };
      });
    }

    async function seedP (mall) {
      await ledger.writeRecord({ mall }, 'group', { membershipAccessId: 'acc-membership', member: MEMBER, relationshipAccessId: 'acc-rel', counterparty: PATIENT, scopeStreamId: TEAM, childAccessId: 'child-p', childName: 'n', expires: CHILD.expires, attribution: 'stamped', state: 'live', stateChangedAt: 1 });
    }

    it('[MA5D] a reuse gives its mint token back, so a new patient is still admitted; a mint keeps it', async () => {
      const mall = fakeMall({ accesses: [MEMBERSHIP, RELATIONSHIP, RELATIONSHIP_Q] });
      await seedP(mall);
      const registry = registryOf({ limits: { mint: { burst: 1, perMinute: 1 } } });
      const core = routedCore();
      const ask = pipeline(mall, registry, core);
      // P: a live child, reused (twice): the token comes back each time.
      for (let i = 0; i < 2; i++) {
        const r = await ask(PATIENT);
        assert.equal(r.err, undefined, String(r.err?.message));
        assert.equal(r.result.memberAccess.accessId, 'child-p');
      }
      // Q: a new access, admitted with the token the reuses gave back.
      const q = await ask(PATIENT_Q);
      assert.equal(q.err, undefined, 'a reuse must not spend the mint budget: ' + String(q.err?.message));
      assert.equal(q.result.event.content.status, 'completed');
      // The mint kept it: a second new access is refused.
      await ledger.setState({ mall }, 'group', ledger.pairEventIdOf('acc-membership', 'acc-rel-q'), 'deleted', q.result.memberAccess.accessId);
      const q2 = await ask(PATIENT_Q);
      assert.equal(q2.err?.httpStatus, 429);
      assert.equal(q2.err?.details?.id, CmcErrorIds.MEMBER_ACCESS_RATE_LIMITED);
      // P is still answered (a live record), without a token.
      const p = await ask(PATIENT);
      assert.equal(p.result.memberAccess.accessId, 'child-p');
    });

    it('[MA5F] two workers answering re-asks of a record at a random id at once both hand back the live child; nothing is deleted', async () => {
      const mall = fakeMall({ accesses: [MEMBERSHIP, RELATIONSHIP, RELATIONSHIP_Q] });
      legacyRecord(mall, { membershipAccessId: 'acc-membership', member: MEMBER, relationshipAccessId: 'acc-rel', counterparty: PATIENT, scopeStreamId: TEAM, childAccessId: 'child-p', childName: 'n', expires: CHILD.expires, attribution: 'stamped', state: 'live', stateChangedAt: 1 });
      const core = routedCore();
      // Two workers: each its own registry (the in-flight lock is per worker).
      const [a, b] = await Promise.all([pipeline(mall, registryOf(), core, 'a')(PATIENT), pipeline(mall, registryOf(), core, 'b')(PATIENT)]);
      for (const r of [a, b]) {
        assert.equal(r.err, undefined, String(r.err?.message));
        assert.equal(r.result.event.content.status, 'completed', JSON.stringify(r.result.event.content));
        assert.equal(r.result.memberAccess.accessId, 'child-p');
      }
      assert.deepEqual(core.calls.map((c) => c.method), ['GET', 'GET'], 'no DELETE of the live child');
      const records = await ledger.listRecords({ mall }, 'group');
      assert.deepEqual(records.map((r) => [r.eventId, r.childAccessId]), [[ledger.pairEventIdOf('acc-membership', 'acc-rel'), 'child-p']]);
    });

    it('[MA5G] the end of an admitted request is settled once: the lock released, the mint token given back unless minted, never twice', async () => {
      const registry = registryOf({ limits: { mint: { burst: 2, perMinute: 1 } } });
      const key = MemberMintRegistry.keyOf('acc-membership', 'acc-rel');
      assert.equal(registry.acquire(key), true);
      const taken = await registry.reserve('mint', 'acc-membership');
      assert.equal((await registry.reserve('mint', 'acc-membership')).ok, true, 'bucket now empty');
      const state = { memberMintLock: key, memberMintReservation: { membershipAccessId: 'acc-membership', held: true, via: taken.via } };
      await settleMemberMint(registry, state);
      await settleMemberMint(registry, state);
      assert.equal(registry.inFlight(key), 0);
      assert.deepEqual([(await registry.reserve('mint', 'acc-membership')).ok, (await registry.reserve('mint', 'acc-membership')).ok], [true, false], 'one token back, not two');
      // A mint keeps its token; no gate state is a no-op.
      assert.equal(registry.acquire(key), true);
      await settleMemberMint(registry, { memberMintLock: key, memberMintReservation: { membershipAccessId: 'acc-membership', held: true, via: 'shared' } }, 'minted');
      assert.equal(registry.inFlight(key), 0);
      assert.equal((await registry.reserve('mint', 'acc-membership')).ok, false);
      await settleMemberMint(registry, undefined);
      await settleMemberMint(registry, {});
    });

    it('[MA5E] a failed mint and a thrown handler give the token back; an ask admitted without one that needs a new child fails its trigger rate-limited', async () => {
      for (const over of [{ post: { status: 503, body: null } }, { post: new Error('boom') }]) {
        const mall = fakeMall({ accesses: [MEMBERSHIP, RELATIONSHIP, RELATIONSHIP_Q] });
        const registry = registryOf({ limits: { mint: { burst: 1, perMinute: 1 } } });
        const ask = pipeline(mall, registry, routedCore(over));
        const first = await ask(PATIENT_Q);
        assert.equal(first.result.event.content.status, 'failed');
        assert.equal((await registry.reserve('mint', 'acc-membership')).ok, true, 'given back: ' + JSON.stringify(over));
      }
      // The handler throws (the membership re-read fails): given back too.
      const mallT = fakeMall({ accesses: [MEMBERSHIP, RELATIONSHIP, RELATIONSHIP_Q] });
      const registryT = registryOf({ limits: { mint: { burst: 1, perMinute: 1 } } });
      const askT = pipeline(mallT, registryT, routedCore());
      mallT.accesses.getOne = async () => { throw new Error('storage down'); };
      const t = await askT(PATIENT_Q);
      assert.equal(t.result.event.content.status, 'failed');
      assert.equal(t.result.event.content.failure.reason, 'cmc-dispatch-handler-threw');
      assert.equal((await registryT.reserve('mint', 'acc-membership')).ok, true, 'given back after a throw');
      // Admitted on a live record, the child turns out to be gone: no token, the trigger fails.
      const mall = fakeMall({ accesses: [MEMBERSHIP, RELATIONSHIP, RELATIONSHIP_Q] });
      await seedP(mall);
      const registry = registryOf({ limits: { mint: { burst: 1, perMinute: 1 } } });
      assert.equal((await registry.reserve('mint', 'acc-membership')).ok, true, 'spent');
      const core = routedCore({ get: { status: 404, body: {} } });
      const r = await pipeline(mall, registry, core)(PATIENT);
      assert.equal(r.err, undefined);
      assert.equal(r.result.event.content.status, 'failed');
      assert.equal(r.result.event.content.failure.reason, CmcErrorIds.MEMBER_ACCESS_RATE_LIMITED);
      assert.ok(r.result.event.content.failure.detail.retryAfterMs >= 1000);
      assert.equal(core.calls.some((c) => c.method === 'POST'), false, 'nothing minted');
    });
  });
});
