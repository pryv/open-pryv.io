/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */

import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);

/**
 * CMC: a second invite on the same scope stream, accepted by the same
 * account, while a member access minted through the first grant lives on
 * the patient core.
 *
 * [CMCSA] runs a group, a member and a patient on one core through the
 * fetch shim (the harness of cmc-group-accounts). The rule: the latest accept
 * replaces the first. The patient core ends the former grant (and the member
 * accesses made through it) once the group's back-channel for the new one
 * arrives; the group core sweeps the former grant's member accesses through
 * it and closes the former invite. A member access never outlives the
 * membership. "An older core" is stood for in-process by turning one half of
 * the rule off for the second accept (replacedGrants.setOlderPeerForTests).
 */

/* global initTests, initCore, coreRequest, getNewFixture, assert, cuid */

const C = require('cmc');
const { buildFetchShim } = require('./cmc-fetch-shim.cjs');

const POLL_INTERVAL_MS = 100;
const POLL_TIMEOUT_MS = 10_000;
const TEST_HOST = 'x.pryv.me';
const APP = 'practice';
const APP_ROOT = ':_cmc:apps:' + APP;
const BASE_PERMISSIONS = [{ streamId: 'vitals', level: 'contribute' }, { streamId: 'notes', level: 'read' }];

function sleep (ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }

async function ensureStream (path, token, params) {
  const res = await coreRequest.post(path).set('Authorization', token).send(params);
  if (res.status !== 201 && res.body?.error?.id !== 'item-already-exists') {
    throw new Error('ensureStream(' + params.id + ') failed: ' + res.status + ' ' + JSON.stringify(res.body));
  }
}

async function pollUntil (label, fn, timeoutMs = POLL_TIMEOUT_MS) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    const v = await fn();
    if (v != null && v !== false) return v;
    await sleep(POLL_INTERVAL_MS);
  }
  throw new Error('poll timeout: ' + label);
}

/** Run `fn` with one half of the replace rule off, standing for a core of an earlier release. */
async function withOlderPeer (sides, fn) {
  const seam = C.replacedGrants?.setOlderPeerForTests;
  if (sides != null && typeof seam === 'function') seam(sides);
  try {
    return await fn();
  } finally {
    if (typeof seam === 'function') seam(null);
  }
}

describe('[CMCSA] cmc second accept on the same scope stream', function () {
  this.timeout(90_000);

  let group, member, patient;
  let originalFetch;
  let fixtures;

  before(async function () {
    await initTests();
    await initCore();
    originalFetch = globalThis.fetch;
    globalThis.fetch = buildFetchShim(originalFetch, global.coreServer);
    fixtures = getNewFixture();
    group = await makeActor('practice-' + cuid().slice(-8));
    member = await makeActor('amy-' + cuid().slice(-8));
    patient = await makeActor('pat-' + cuid().slice(-8));
    await ensureStream(patient.streamsPath, patient.token, { id: 'vitals', name: 'Vitals' });
    await ensureStream(patient.streamsPath, patient.token, { id: 'notes', name: 'Notes' });
  });

  after(async function () {
    if (C.replacedGrants?.setOlderPeerForTests != null) C.replacedGrants.setOlderPeerForTests(null);
    if (originalFetch != null) globalThis.fetch = originalFetch;
    if (fixtures != null) { try { await fixtures.clean(); } catch (_e) { /* best-effort */ } }
  });

  async function makeActor (username) {
    const token = cuid();
    const u = await fixtures.user(username);
    await u.access({ token, type: 'personal' });
    await u.session(token);
    return {
      username,
      token,
      fixture: u,
      streamsPath: '/' + username + '/streams',
      eventsPath: '/' + username + '/events',
      accessesPath: '/' + username + '/accesses',
      accessInfoPath: '/' + username + '/access-info',
    };
  }

  async function accessesOf (actor, token = actor.token, query = {}) {
    const res = await coreRequest.get(actor.accessesPath).set('Authorization', token).query(query);
    assert.strictEqual(res.status, 200, JSON.stringify(res.body));
    return res.body;
  }

  async function tokenLivesOn (owner, token) {
    const res = await coreRequest.get(owner.accessInfoPath).set('Authorization', token);
    return res.status === 200 ? res.body : null;
  }

  async function pollTokenDead (owner, token, label) {
    await pollUntil(label + ': the token still authenticates on ' + owner.username, async () => (await tokenLivesOn(owner, token)) == null);
  }

  async function eventOf (owner, id) {
    const r = await coreRequest.get(owner.eventsPath + '/' + id).set('Authorization', owner.token);
    return r.body?.event ?? null;
  }

  async function inviteStatus (id) {
    return (await eventOf(group, id))?.content ?? null;
  }

  async function pollInvite (id, status, label) {
    return await pollUntil(label + ': invite ' + id + ' not ' + status, async () => {
      const c = await inviteStatus(id);
      return c?.status === status ? c : null;
    }).catch(async (err) => { throw new Error(err.message + ' (is ' + JSON.stringify(await inviteStatus(id)) + ')'); });
  }

  async function groupUserId () {
    const users = await require('business/src/users/index.ts').getUsersRepository();
    return await users.getUserIdForUsername(group.username);
  }

  async function ledgerRecords (membershipAccessId) {
    const mall = await require('mall').getMall();
    return (await C.memberLedger.listRecords({ mall }, await groupUserId())).filter((r) => r.membershipAccessId === membershipAccessId);
  }

  /** Strip the grant key from a record, as written by a core of an earlier release. */
  async function makeLegacy (record) {
    const mall = await require('mall').getMall();
    await mall.events.updateWithMerge(await groupUserId(), record.eventId, (stored) => {
      const content = { ...stored.content };
      delete content.grantKey;
      delete content.viaAccessId;
      return { ...stored, content };
    }, null, { skipVersioning: true });
  }

  /** Back-channel deliveries the patient core has finished handling. */
  async function settledBackChannels () {
    const r = await coreRequest.get(patient.eventsPath).set('Authorization', patient.token)
      .query({ streams: [':_cmc:inbox'], types: ['consent/back-channel-cmc'], limit: 1000 });
    return (r.body?.events || []).filter((e) => e.content?.status === 'completed' || e.content?.status === 'failed').length;
  }

  async function joinGroup (team) {
    const teamStream = APP_ROOT + ':' + team;
    await ensureStream(member.streamsPath, member.token, { id: APP_ROOT, parentId: ':_cmc:apps', name: APP });
    await ensureStream(member.streamsPath, member.token, { id: teamStream, parentId: APP_ROOT, name: team });
    const reqRes = await coreRequest.post(member.eventsPath).set('Authorization', member.token).send({
      streamIds: [teamStream],
      type: 'consent/request-cmc',
      content: {
        to: null,
        capabilityRequested: true,
        request: {
          title: { en: 'Join ' + team },
          description: { en: 'membership request' },
          consent: { en: 'Let me in.' },
          membership: true,
          permissions: [{ streamId: teamStream, level: 'contribute' }],
          features: { chat: false, systemMessaging: true },
        },
        requesterMeta: { username: member.username, appId: APP },
      },
    });
    assert.strictEqual(reqRes.status, 201, JSON.stringify(reqRes.body));
    const capabilityUrl = reqRes.body.event.content.capabilityUrl;
    await ensureStream(group.streamsPath, group.token, { id: APP_ROOT, parentId: ':_cmc:apps', name: APP });
    const accRes = await coreRequest.post(group.eventsPath).set('Authorization', group.token).send({
      streamIds: [APP_ROOT],
      type: 'consent/accept-cmc',
      content: { capabilityUrl, accessName: 'member-' + team + '-' + Date.now() },
    });
    assert.strictEqual(accRes.status, 201, JSON.stringify(accRes.body));
    const requestEventId = reqRes.body.event.id;
    const mirror = await pollUntil('membership accept in the member inbox', async () => {
      const r = await coreRequest.get(member.eventsPath).set('Authorization', member.token)
        .query({ streams: [':_cmc:inbox'], types: ['consent/accept-cmc'], limit: 100 });
      return (r.body?.events || []).find((e) => e.content?.inviteEventId === requestEventId && e.content?.from?.username === group.username &&
        e.content?.membership === true && typeof e.content?.grantedAccess?.apiEndpoint === 'string' && e.content.grantedAccess.apiEndpoint.includes('@'));
    });
    const membershipToken = new URL(mirror.content.grantedAccess.apiEndpoint).username;
    const membershipAccess = await pollUntil('membership access stamped with the member back-channel', async () => {
      const { accesses } = await accessesOf(group);
      return accesses.find((a) => a.clientData?.cmc?.role === 'member' && a.token === membershipToken &&
        typeof a.clientData.cmc.counterparty?.apiEndpoint === 'string');
    });
    return { teamStream, membershipToken, membershipAccess, requestEventId };
  }

  /**
   * One invite on `scope` published with `inviterToken` and accepted by the
   * patient. `exceptGrantIds` lists the grants already on the patient
   * account: the one returned is the grant this accept made. `request`
   * overrides the invite's terms (permissions, accessType).
   */
  async function invitePatient (scope, inviterToken, exceptGrantIds = [], request = {}) {
    const reqRes = await coreRequest.post(group.eventsPath).set('Authorization', inviterToken).send({
      streamIds: [scope],
      type: 'consent/request-cmc',
      content: {
        to: null,
        capabilityRequested: true,
        request: {
          title: { en: 'Share your vitals' },
          description: { en: 'patient invite' },
          consent: { en: 'I consent.' },
          accessType: 'app',
          permissions: BASE_PERMISSIONS,
          features: { chat: false },
          ...request,
        },
        requesterMeta: { username: group.username, appId: APP },
      },
    });
    assert.strictEqual(reqRes.status, 201, JSON.stringify(reqRes.body));
    const inviteEventId = reqRes.body.event.id;
    const capabilityUrl = reqRes.body.event.content.capabilityUrl;
    await ensureStream(patient.streamsPath, patient.token, { id: APP_ROOT, parentId: ':_cmc:apps', name: APP });
    const accRes = await coreRequest.post(patient.eventsPath).set('Authorization', patient.token).send({
      streamIds: [APP_ROOT],
      type: 'consent/accept-cmc',
      content: { capabilityUrl, accessName: 'grant-' + cuid().slice(-6) },
    });
    return {
      inviteEventId,
      accRes,
      acceptEventId: accRes.body?.event?.id ?? null,
      grant: accRes.status === 201 ? await grantMadeBy(scope, exceptGrantIds) : null,
    };
  }

  async function grantMadeBy (scope, exceptGrantIds) {
    return await pollUntil('patient grant with the back-channel stamped', async () => {
      const { accesses } = await accessesOf(patient);
      return accesses.find((a) => !exceptGrantIds.includes(a.id) && a.clientData?.cmc?.role === 'counterparty' &&
        a.clientData.cmc.counterparty?.username === group.username && a.clientData.cmc.scopeStreamId === scope &&
        typeof a.clientData.cmc.counterparty.apiEndpoint === 'string');
    });
  }

  /** An invite accepted with one half of the rule off, returned once the patient core finished the back-channel. */
  async function invitePatientSettled (scope, inviterToken, exceptGrantIds, olderPeer = null, request = {}) {
    const before = await settledBackChannels();
    return await withOlderPeer(olderPeer, async () => {
      const r = await invitePatient(scope, inviterToken, exceptGrantIds, request);
      if (r.accRes.status === 201) {
        await pollUntil('the back-channel of the new grant handled on the patient core', async () => (await settledBackChannels()) > before);
      }
      return r;
    });
  }

  async function grantsOn (scope) {
    const { accesses } = await accessesOf(patient);
    return accesses.filter((a) => a.clientData?.cmc?.role === 'counterparty' && a.clientData.cmc.counterparty?.username === group.username &&
      a.clientData.cmc.scopeStreamId === scope);
  }

  async function relationshipOf (scope) {
    const { accesses } = await accessesOf(group);
    return accesses.filter((a) => a.clientData?.cmc?.role === 'counterparty' && a.clientData.cmc.counterparty?.username === patient.username &&
      a.clientData.cmc.scopeStreamId === scope);
  }

  async function mint (teamStream, membershipToken, extra = {}) {
    return await coreRequest.post(group.eventsPath).set('Authorization', membershipToken).send({
      streamIds: [teamStream],
      type: 'consent/member-access-cmc',
      content: { counterparty: { username: patient.username, host: TEST_HOST }, ...extra },
    });
  }

  function childOf (ask) {
    return { token: new URL(ask.body.memberAccess.apiEndpoint).username, accessId: ask.body.memberAccess.accessId, name: ask.body.memberAccess.name };
  }

  async function sweepRecordFor (membershipAccessId) {
    return await pollUntil('sweep record for ' + membershipAccessId, async () => {
      const r = await coreRequest.get(group.eventsPath).set('Authorization', group.token)
        .query({ streams: [APP_ROOT], types: ['consent/member-revoke-cmc'], limit: 100 });
      return (r.body?.events || []).find((e) => e.content?.membershipAccessId === membershipAccessId &&
        (e.content?.status === 'completed' || e.content?.status === 'failed'));
    });
  }

  /**
   * The setup most cases start from: a membership, invite 1 accepted, a
   * member access minted through grant 1, then invite 2 on the same stream
   * accepted by the same patient (with `olderPeer` standing for a core of an
   * earlier release during that second accept).
   */
  async function setup (team, olderPeer = null) {
    const m = await joinGroup(team);
    const first = await invitePatient(m.teamStream, m.membershipToken);
    assert.strictEqual(first.accRes.status, 201, JSON.stringify(first.accRes.body));
    const ask = await mint(m.teamStream, m.membershipToken);
    assert.strictEqual(ask.status, 201, JSON.stringify(ask.body));
    assert.ok(ask.body.memberAccess != null, 'premise: a member access: ' + JSON.stringify(ask.body));
    const child = childOf(ask);
    assert.ok((await tokenLivesOn(patient, child.token)) != null, 'premise: the member access opens the patient account');
    const second = await invitePatientSettled(m.teamStream, m.membershipToken, [first.grant.id], olderPeer);
    assert.strictEqual(second.accRes.status, 201, 'the second accept is taken: ' + JSON.stringify(second.accRes.body));
    return { m, first, second, child };
  }

  async function revokeMembership (m) {
    const rev = await coreRequest.post(group.eventsPath).set('Authorization', group.token).send({
      streamIds: [m.teamStream], type: 'consent/revoke-cmc', content: { accessId: m.membershipAccess.id },
    });
    assert.strictEqual(rev.status, 201, JSON.stringify(rev.body));
    await pollTokenDead(group, m.membershipToken, 'membership');
  }

  async function patientWithdraws (g) {
    const collectors = g.permissions.find((x) => /:collectors:/.test(x.streamId))?.streamId;
    const rev = await coreRequest.post(patient.eventsPath).set('Authorization', patient.token).send({
      streamIds: [collectors ?? APP_ROOT], type: 'consent/revoke-cmc', content: { accessId: g.id },
    });
    assert.strictEqual(rev.status, 201, JSON.stringify(rev.body));
    await pollTokenDead(patient, g.token, 'grant ' + g.id);
  }

  it('[CSA01] the group removes the member after the second accept (no new ask): the member access made through grant 1 dies on the patient core', async function () {
    const { m, child } = await setup('team-sa01');
    await revokeMembership(m);
    // The member access may already be gone (ended with the grant it was made
    // through), in which case the removal has nothing left to sweep.
    await pollTokenDead(patient, child.token, 'CSA01 member access');
    const { accesses } = await accessesOf(patient);
    assert.ok(!accesses.some((a) => a.id === child.accessId), 'the person no longer lists the member access');
  });

  it('[CSA02] the member asks again after the second accept: the ask is answered with an access that works, and the removal ends every member access', async function () {
    const { m, child } = await setup('team-sa02');
    const again = await mint(m.teamStream, m.membershipToken);
    assert.strictEqual(again.status, 201, JSON.stringify(again.body));
    assert.strictEqual(again.body.event?.content?.status, 'completed', 'the re-ask completes: ' + JSON.stringify(again.body.event?.content));
    const now = new URL(again.body.memberAccess.apiEndpoint).username;
    assert.ok((await tokenLivesOn(patient, now)) != null, 'the answered access opens the patient account');
    await revokeMembership(m);
    await sweepRecordFor(m.membershipAccess.id);
    await pollTokenDead(patient, now, 'CSA02 answered member access');
    await pollTokenDead(patient, child.token, 'CSA02 first member access');
  });

  it('[CSA03] no grant on the patient account is left that the group side cannot name: after the second accept, one grant and one relationship on the scope', async function () {
    const { m, second } = await setup('team-sa03');
    // The patient core settled the back-channel of grant 2 before setup returned.
    const grants = (await grantsOn(m.teamStream)).map((g) => g.id);
    const relationships = (await relationshipOf(m.teamStream)).map((r) => r.id);
    assert.deepStrictEqual(grants, [second.grant.id], 'grants on the patient account');
    assert.strictEqual(relationships.length, 1, 'relationships on the group ' + JSON.stringify(relationships));
  });

  it('[CSA04] the patient withdraws grant 2: grant 1 is already gone, and nothing of the relationship is left on either side; both invites end revoked', async function () {
    const { m, first, second, child } = await setup('team-sa04');
    await pollTokenDead(patient, first.grant.token, 'CSA04 grant 1 (replaced by the second accept)');
    await patientWithdraws(second.grant);
    await pollTokenDead(patient, child.token, 'CSA04 member access');
    await pollUntil('CSA04: the group still holds a relationship to the patient on the scope', async () => (await relationshipOf(m.teamStream)).length === 0);
    const invite1 = await pollInvite(first.inviteEventId, 'revoked', 'CSA04');
    assert.deepStrictEqual(invite1.replacedBy, { inviteEventId: second.inviteEventId }, 'invite 1 was replaced by invite 2');
    const invite2 = await pollInvite(second.inviteEventId, 'revoked', 'CSA04');
    assert.strictEqual(invite2.replacedBy, undefined, 'invite 2 ended by the withdrawal');
  });

  it('[CSA05] after the second accept: grant 1 is ended on the patient core (token dead, deletion record), its member access dead, its accept marked replaced by accept 2; one grant and one relationship on the scope', async function () {
    const { m, first, second, child } = await setup('team-sa05');
    await pollTokenDead(patient, first.grant.token, 'CSA05 grant 1');
    await pollTokenDead(patient, child.token, 'CSA05 member access of grant 1');
    const { accessDeletions } = await accessesOf(patient, patient.token, { includeDeletions: true });
    assert.ok((accessDeletions ?? []).some((d) => d.id === first.grant.id), 'grant 1 has a deletion record');
    const accept1 = await pollUntil('accept 1 marked withdrawn', async () => (await eventOf(patient, first.acceptEventId))?.content?.withdrawal);
    assert.strictEqual(accept1.by, 'replaced');
    assert.strictEqual(accept1.accessId, first.grant.id);
    assert.deepStrictEqual(accept1.replacedBy, { acceptEventId: second.acceptEventId, accessId: second.grant.id });
    assert.strictEqual((await eventOf(patient, second.acceptEventId))?.content?.withdrawal, undefined, 'accept 2 stands');
    assert.deepStrictEqual((await grantsOn(m.teamStream)).map((g) => g.id), [second.grant.id]);
    assert.strictEqual((await relationshipOf(m.teamStream)).length, 1);
    assert.ok((await tokenLivesOn(patient, second.grant.token)) != null, 'grant 2 works');
    // The ledger named the grant that made the member access: its id from the
    // access's stamp (the create answer carries it), and a key, no endpoint.
    const record = (await ledgerRecords(m.membershipAccess.id)).find((r) => r.childAccessId === child.accessId);
    assert.strictEqual(record?.viaAccessId, first.grant.id);
    assert.match(record?.grantKey ?? '', /^[0-9a-f]{16}$/);
    assert.strictEqual(JSON.stringify(record).includes(first.grant.token), false, 'no grant token in the ledger');
  });

  it('[CSA06] invite 1 reads revoked with replacedBy naming invite 2, invite 2 accepted, both on the same relationship; no revoke arrives on the group side', async function () {
    const { m, first, second } = await setup('team-sa06');
    const invite1 = await pollInvite(first.inviteEventId, 'revoked', 'CSA06');
    assert.deepStrictEqual(invite1.replacedBy, { inviteEventId: second.inviteEventId });
    assert.strictEqual(typeof invite1.revokedAt, 'number');
    const invite2 = await inviteStatus(second.inviteEventId);
    assert.strictEqual(invite2.status, 'accepted');
    const [relationship] = await relationshipOf(m.teamStream);
    assert.strictEqual(invite1.backChannelAccessId, relationship.id);
    assert.strictEqual(invite2.backChannelAccessId, relationship.id);
    await pollTokenDead(patient, first.grant.token, 'CSA06 grant 1');
    await sleep(500);
    const r = await coreRequest.get(group.eventsPath).set('Authorization', group.token)
      .query({ streams: [':_cmc:inbox'], types: ['consent/revoke-cmc'], limit: 1000 });
    const arrivals = (r.body?.events || []).filter((e) => e.content?.scopeStreamId === m.teamStream || e.content?.acceptEventId === first.acceptEventId);
    assert.deepStrictEqual(arrivals.map((e) => e.id), [], 'no revoke notice for the replaced grant');
  });

  it('[CSA07] invite 2 with other terms: an ask beyond invite 1 is refused before and answered after the second accept; a third invite with a non-delegable grant leaves no member access of the earlier grants', async function () {
    const m = await joinGroup('team-sa07');
    const wider = [{ streamId: 'vitals', level: 'contribute' }, { streamId: 'notes', level: 'contribute' }];
    const first = await invitePatient(m.teamStream, m.membershipToken);
    assert.strictEqual(first.accRes.status, 201, JSON.stringify(first.accRes.body));
    const c1 = childOf(await mint(m.teamStream, m.membershipToken));
    const refused = await mint(m.teamStream, m.membershipToken, { permissions: [{ streamId: 'notes', level: 'contribute' }] });
    assert.strictEqual(refused.body?.error?.data?.id, 'cmc-member-access-permissions-not-subset', 'beyond invite 1: ' + JSON.stringify(refused.body));
    const second = await invitePatientSettled(m.teamStream, m.membershipToken, [first.grant.id], null, { permissions: wider });
    assert.strictEqual(second.accRes.status, 201, JSON.stringify(second.accRes.body));
    await pollTokenDead(patient, c1.token, 'CSA07 member access of grant 1');
    const answered = await mint(m.teamStream, m.membershipToken, { permissions: [{ streamId: 'notes', level: 'contribute' }] });
    assert.strictEqual(answered.status, 201, JSON.stringify(answered.body));
    assert.strictEqual(answered.body.event?.content?.status, 'completed', JSON.stringify(answered.body.event?.content));
    const c2 = childOf(answered);
    assert.ok((await tokenLivesOn(patient, c2.token)) != null, 'the wider access works');
    // A third invite whose grant is not delegable.
    const third = await invitePatientSettled(m.teamStream, m.membershipToken, [first.grant.id, second.grant.id], null, { permissions: wider, accessType: 'shared' });
    assert.strictEqual(third.accRes.status, 201, JSON.stringify(third.accRes.body));
    await pollTokenDead(patient, c2.token, 'CSA07 member access of grant 2');
    await pollTokenDead(patient, second.grant.token, 'CSA07 grant 2');
    const notDelegable = await mint(m.teamStream, m.membershipToken);
    assert.strictEqual(notDelegable.body?.event?.content?.failure?.reason, 'cmc-member-access-grant-not-delegable', JSON.stringify(notDelegable.body));
    assert.deepStrictEqual((await grantsOn(m.teamStream)).map((g) => g.id), [third.grant.id]);
  });

  it('[CSA08] an older patient core (it keeps grant 1): the group sweeps grant 1\'s member access through it at the second accept and closes invite 1; a new ask is answered and the removal ends it', async function () {
    const { m, first, second, child } = await setup('team-sa08', { accepter: true });
    await pollTokenDead(patient, child.token, 'CSA08 member access swept through grant 1');
    const record = await pollUntil('the pair record settled deleted', async () =>
      (await ledgerRecords(m.membershipAccess.id)).find((r) => r.childAccessId === child.accessId && r.state === 'deleted'));
    assert.strictEqual(record.state, 'deleted');
    const invite1 = await pollInvite(first.inviteEventId, 'revoked', 'CSA08');
    assert.deepStrictEqual(invite1.replacedBy, { inviteEventId: second.inviteEventId });
    assert.ok((await tokenLivesOn(patient, first.grant.token)) != null, 'the older patient core kept grant 1 (held by nobody now)');
    const again = await mint(m.teamStream, m.membershipToken);
    assert.strictEqual(again.status, 201, JSON.stringify(again.body));
    assert.strictEqual(again.body.event?.content?.status, 'completed', JSON.stringify(again.body.event?.content));
    const fresh = childOf(again);
    await revokeMembership(m);
    await sweepRecordFor(m.membershipAccess.id);
    await pollTokenDead(patient, fresh.token, 'CSA08 member access of grant 2');
  });

  it('[CSA09] an older group core (no close-out): the patient core ends grant 1 and its member access; a new ask is answered under the same name; the removal ends the new member access and reports only it', async function () {
    const { m, first, child } = await setup('team-sa09', { requester: true });
    await pollTokenDead(patient, first.grant.token, 'CSA09 grant 1');
    await pollTokenDead(patient, child.token, 'CSA09 member access of grant 1');
    assert.strictEqual((await inviteStatus(first.inviteEventId)).status, 'accepted', 'an older group core leaves invite 1 as it was');
    const again = await mint(m.teamStream, m.membershipToken);
    assert.strictEqual(again.status, 201, JSON.stringify(again.body));
    assert.strictEqual(again.body.event?.content?.status, 'completed', JSON.stringify(again.body.event?.content));
    const fresh = childOf(again);
    assert.strictEqual(fresh.name, child.name, 'the name was free again');
    await revokeMembership(m);
    const sweep = await sweepRecordFor(m.membershipAccess.id);
    await pollTokenDead(patient, fresh.token, 'CSA09 new member access');
    const outcome = Object.fromEntries((sweep.content.outcome ?? []).map((o) => [o.childAccessId, o]));
    assert.strictEqual(outcome[fresh.accessId]?.result, 'deleted', JSON.stringify(sweep.content));
    assert.deepStrictEqual(Object.keys(outcome), [fresh.accessId], 'the access of grant 1, proved gone by the free name, is not reported');
  });

  it('[CSA10] state left by an earlier release (two live grants, a record without a key): a new ask is answered under the fallback name and the old member access tracked residual; the removal reports it residual, never absent; a third accept ends both earlier grants and the old access', async function () {
    const { m, first, second, child } = await setup('team-sa10', { accepter: true, requester: true });
    assert.ok((await tokenLivesOn(patient, first.grant.token)) != null, 'premise: grant 1 still lives');
    assert.ok((await tokenLivesOn(patient, child.token)) != null, 'premise: its member access still lives');
    const legacy = (await ledgerRecords(m.membershipAccess.id)).find((r) => r.childAccessId === child.accessId);
    await makeLegacy(legacy);
    // (a) the ask is answered; the old access stays tracked.
    const again = await mint(m.teamStream, m.membershipToken);
    assert.strictEqual(again.status, 201, JSON.stringify(again.body));
    assert.strictEqual(again.body.event?.content?.status, 'completed', JSON.stringify(again.body.event?.content));
    const fresh = childOf(again);
    assert.match(fresh.name, new RegExp('^' + child.name + '-[0-9a-f]{8}$'));
    assert.ok((await tokenLivesOn(patient, child.token)) != null, 'the old access is out of reach of grant 2, still alive');
    const kept = (await ledgerRecords(m.membershipAccess.id)).find((r) => r.childAccessId === child.accessId);
    assert.deepStrictEqual([kept?.state, kept?.residualReason], ['residual', 'grant-replaced']);
    // (b) the removal: the new access dies, the old one is reported residual.
    await revokeMembership(m);
    const sweep = await sweepRecordFor(m.membershipAccess.id);
    await pollTokenDead(patient, fresh.token, 'CSA10 new member access');
    assert.strictEqual(sweep.content.status, 'failed', JSON.stringify(sweep.content));
    assert.strictEqual(sweep.content.failure?.reason, 'cmc-member-revoke-residual');
    const outcome = Object.fromEntries((sweep.content.outcome ?? []).map((o) => [o.childAccessId, o]));
    assert.strictEqual(outcome[child.accessId]?.result, 'residual', JSON.stringify(sweep.content.outcome));
    assert.ok((sweep.content.residuals ?? []).some((r) => r.childAccessId === child.accessId), 'named with its expiry');
    // (c) a third accept on the stream ends grant 1, grant 2 and the old access.
    const third = await invitePatientSettled(m.teamStream, group.token, [first.grant.id, second.grant.id]);
    assert.strictEqual(third.accRes.status, 201, JSON.stringify(third.accRes.body));
    await pollTokenDead(patient, first.grant.token, 'CSA10 grant 1');
    await pollTokenDead(patient, second.grant.token, 'CSA10 grant 2');
    await pollTokenDead(patient, child.token, 'CSA10 old member access');
  });

  /** The patient ends grant 2 while the member access of grant 1 lives; the record of that access once settled. */
  async function withdrawGrant2 (m, second, child) {
    assert.ok((await tokenLivesOn(patient, child.token)) != null, 'premise: the member access of grant 1 lives');
    await patientWithdraws(second.grant);
    await pollUntil('the group relationship ended', async () => (await relationshipOf(m.teamStream)).length === 0);
    return await pollUntil('the record settled', async () => {
      const r = (await ledgerRecords(m.membershipAccess.id)).find((x) => x.childAccessId === child.accessId);
      return r != null && r.state !== 'live' ? r : null;
    });
  }

  it('[CSA11] two live grants (an older patient and group core), the patient withdraws grant 2 while a member access of grant 1 lives: the group records that access residual, not absent, and keeps it so through the ledger pass and the removal of the member', async function () {
    const { m, second, child } = await setup('team-sa11', { accepter: true, requester: true });
    const record = await withdrawGrant2(m, second, child);
    assert.deepStrictEqual([record.state, record.residualReason], ['residual', 'grant-replaced'], JSON.stringify(record));
    assert.ok((await tokenLivesOn(patient, child.token)) != null, 'it does live on (grant 1 is not ended by the withdrawal of grant 2)');
    // The relationship access is gone now: a later pass or sweep must not settle the record as gone.
    const sweeper = await require('api-server/src/methods/helpers/cmcMemberSweep.ts').buildMemberSweep();
    await sweeper.runLedgerPass(await groupUserId());
    const afterPass = (await ledgerRecords(m.membershipAccess.id)).find((x) => x.childAccessId === child.accessId);
    assert.deepStrictEqual([afterPass.state, afterPass.residualReason], ['residual', 'grant-replaced'], 'after the ledger pass: ' + JSON.stringify(afterPass));
    await revokeMembership(m);
    const sweep = await sweepRecordFor(m.membershipAccess.id);
    assert.strictEqual(sweep.content.status, 'failed', JSON.stringify(sweep.content));
    assert.strictEqual(sweep.content.failure?.reason, 'cmc-member-revoke-residual');
    const outcome = Object.fromEntries((sweep.content.outcome ?? []).map((o) => [o.childAccessId, o]));
    assert.deepStrictEqual(outcome[child.accessId], { childAccessId: child.accessId, result: 'residual', reason: 'grant-replaced' });
    const afterSweep = (await ledgerRecords(m.membershipAccess.id)).find((x) => x.childAccessId === child.accessId);
    assert.strictEqual(afterSweep.state, 'residual');
  });

  it('[CSA16] two live grants (an older patient and group core), the group removes the member: the access of grant 1 is reported residual as a child of a former grant (no call through grant 2), never absent', async function () {
    const { m, child } = await setup('team-sa16', { accepter: true, requester: true });
    assert.ok((await tokenLivesOn(patient, child.token)) != null, 'premise: the member access of grant 1 lives');
    await revokeMembership(m);
    const sweep = await sweepRecordFor(m.membershipAccess.id);
    assert.strictEqual(sweep.content.status, 'failed', JSON.stringify(sweep.content));
    const outcome = Object.fromEntries((sweep.content.outcome ?? []).map((o) => [o.childAccessId, o]));
    assert.deepStrictEqual(outcome[child.accessId], { childAccessId: child.accessId, result: 'residual', reason: 'grant-replaced' });
    assert.ok((await tokenLivesOn(patient, child.token)) != null, 'out of reach of grant 2: it lives to its expiry');
  });

  it('[CSA15] the same with the record written by an earlier release (no grant key): the patient withdrawing grant 2 leaves it residual, grant unknown, not absent', async function () {
    const { m, second, child } = await setup('team-sa15', { accepter: true, requester: true });
    await makeLegacy((await ledgerRecords(m.membershipAccess.id)).find((r) => r.childAccessId === child.accessId));
    const record = await withdrawGrant2(m, second, child);
    assert.deepStrictEqual([record.state, record.residualReason], ['residual', 'grant-unknown'], JSON.stringify(record));
    assert.ok((await tokenLivesOn(patient, child.token)) != null, 'it does live on');
  });

  it('[CSA12] accepts on two different scope streams by one patient: two grants, two relationships, nothing replaced, both invites accepted', async function () {
    const m = await joinGroup('team-sa12');
    const ward = m.teamStream + ':ward';
    await ensureStream(group.streamsPath, group.token, { id: ward, parentId: m.teamStream, name: 'ward' });
    const a = await invitePatientSettled(m.teamStream, m.membershipToken, []);
    assert.strictEqual(a.accRes.status, 201, JSON.stringify(a.accRes.body));
    const b = await invitePatientSettled(ward, m.membershipToken, [a.grant.id]);
    assert.strictEqual(b.accRes.status, 201, JSON.stringify(b.accRes.body));
    await sleep(500);
    assert.ok((await tokenLivesOn(patient, a.grant.token)) != null, 'grant on the team stream lives');
    assert.ok((await tokenLivesOn(patient, b.grant.token)) != null, 'grant on the ward lives');
    assert.strictEqual((await relationshipOf(m.teamStream)).length, 1);
    assert.strictEqual((await relationshipOf(ward)).length, 1);
    assert.strictEqual((await inviteStatus(a.inviteEventId)).status, 'accepted');
    assert.strictEqual((await inviteStatus(b.inviteEventId)).status, 'accepted');
    assert.strictEqual((await eventOf(patient, a.acceptEventId))?.content?.withdrawal, undefined);
  });

  it('[CSA13] after a replace, a late revoke notice naming accept 1 reaches the group: marked superseded, nothing torn down, invite 1 stays revoked', async function () {
    const { m, first, second } = await setup('team-sa13');
    await pollTokenDead(patient, first.grant.token, 'CSA13 grant 1');
    await pollInvite(first.inviteEventId, 'revoked', 'CSA13');
    const [relationship] = await relationshipOf(m.teamStream);
    const late = await coreRequest.post(group.eventsPath).set('Authorization', relationship.token).send({
      streamIds: [':_cmc:inbox'],
      type: 'consent/revoke-cmc',
      content: { accessId: first.grant.id, acceptEventId: first.acceptEventId, revokedAt: Date.now() / 1000 - 5, scopeStreamId: m.teamStream },
    });
    assert.strictEqual(late.status, 201, JSON.stringify(late.body));
    const arrival = await pollUntil('the late notice marked', async () => {
      const e = await eventOf(group, late.body.event.id);
      return e?.content?.superseded != null ? e : null;
    });
    assert.strictEqual(arrival.content.superseded, 'relationship-re-established');
    assert.strictEqual((await relationshipOf(m.teamStream)).length, 1, 'the relationship stands');
    assert.ok((await tokenLivesOn(patient, second.grant.token)) != null, 'grant 2 works');
    assert.strictEqual((await inviteStatus(first.inviteEventId)).status, 'revoked');
    assert.strictEqual((await inviteStatus(second.inviteEventId)).status, 'accepted');
  });

  it('[CSA14] a member joins the same team twice, then the group removes the member: no member access survives', async function () {
    const m1 = await joinGroup('team-sa14');
    const first = await invitePatient(m1.teamStream, m1.membershipToken);
    assert.strictEqual(first.accRes.status, 201, JSON.stringify(first.accRes.body));
    const ask1 = await mint(m1.teamStream, m1.membershipToken);
    assert.strictEqual(ask1.status, 201, JSON.stringify(ask1.body));
    const c1 = childOf(ask1);
    const m2 = await joinGroup('team-sa14');
    assert.notStrictEqual(m2.membershipAccess.id, m1.membershipAccess.id, 'premise: a second membership');
    const ask2 = await mint(m2.teamStream, m2.membershipToken);
    assert.strictEqual(ask2.status, 201, JSON.stringify(ask2.body));
    const c2 = childOf(ask2);
    await revokeMembership(m2);
    await pollTokenDead(patient, c2.token, 'CSA14 member access of membership 2');
    await pollTokenDead(patient, c1.token, 'CSA14 member access of membership 1');
    await pollTokenDead(group, m1.membershipToken, 'CSA14 membership 1');
  });
});
