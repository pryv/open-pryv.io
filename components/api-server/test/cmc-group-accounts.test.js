/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */

import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);

/**
 * CMC group accounts, in-process integration.
 *
 * [CMCGA] runs three accounts on one core through the fetch shim: a group
 * (a practice), a member (a practitioner) and a patient. It covers the
 * membership (a member's request accepted by the group's owner or by a
 * delegate administrator, the rule on what a membership may ask), the
 * member access mint on the patient's account (the token answered once,
 * usable on the patient's core, the stamp the patient core completes, the
 * reuse and the re-mint, every refusal, a patient core of an older release),
 * offboarding by every path (the group revokes, the member leaves, a plain
 * delete, a detached administrator) with the sweep record, and the deletion
 * record every CMC teardown now leaves (readable with includeDeletions, the
 * webhooks and aliases released, a re-accept minting a fresh access).
 *
 * Set CMC_MINT_LATENCY_LOG=<file> to append the measured same-core mint
 * latency (milliseconds) to that file.
 */

/* global initTests, initCore, coreRequest, getNewFixture, assert, cuid */

const fs = require('node:fs');
const C = require('cmc');
const { buildFetchShim } = require('./cmc-fetch-shim.cjs');

const POLL_INTERVAL_MS = 100;
const POLL_TIMEOUT_MS = 10_000;
const TEST_HOST = 'x.pryv.me';
const APP = 'practice';
const APP_ROOT = ':_cmc:apps:' + APP;

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

describe('[CMCGA] cmc group accounts (in-process integration)', function () {
  this.timeout(90_000);

  let group, member, patient, admin;
  let originalFetch;
  let fixtures;

  before(async function () {
    await initTests();
    await initCore();
    // The shared in-process core registers a fixed method-family list whose
    // first-booting caller decides the set; the delegations family is needed
    // here (api.register overwrites idempotently).
    await require('api-server/src/methods/delegations.ts').default(global.app.api);
    originalFetch = globalThis.fetch;
    globalThis.fetch = buildFetchShim(originalFetch, global.coreServer);
    fixtures = getNewFixture();
    group = await makeActor('practice-' + cuid().slice(-8));
    member = await makeActor('amy-' + cuid().slice(-8));
    patient = await makeActor('pat-' + cuid().slice(-8));
    admin = await makeActor('carer-' + cuid().slice(-8));
    await ensureStream(patient.streamsPath, patient.token, { id: 'vitals', name: 'Vitals' });
    await ensureStream(patient.streamsPath, patient.token, { id: 'notes', name: 'Notes' });
    await ensureStream(patient.streamsPath, patient.token, { id: 'private', name: 'Private' });
  });

  after(async function () {
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
      webhooksPath: '/' + username + '/webhooks',
      delegationsPath: '/' + username + '/delegations',
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

  /**
   * The member asks to join `team` of the group; `accepter` (the owner's
   * token or a delegate PAT) approves `granted`. Returns the membership
   * access as the group sees it (back-channel stamped) and the member's
   * token on it.
   */
  async function joinGroup (team, { accepterToken = group.token, granted } = {}) {
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
    const accRes = await coreRequest.post(group.eventsPath).set('Authorization', accepterToken).send({
      streamIds: [APP_ROOT],
      type: 'consent/accept-cmc',
      content: { capabilityUrl, accessName: 'member-' + team + '-' + Date.now(), ...(granted != null ? { grantedPermissions: granted } : {}) },
    });
    assert.strictEqual(accRes.status, 201, JSON.stringify(accRes.body));
    // The mirror of THIS request (several joins land in the same inbox).
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
    return { teamStream, membershipToken, membershipAccess, acceptEventId: accRes.body.event.id, mirror };
  }

  /**
   * A patient invite published on the group's team stream (by the member,
   * through the membership) and accepted by the patient. Returns the group's
   * relationship access (its grant endpoint stamped) and the patient's grant.
   */
  async function invitePatient (teamStream, inviterToken, { accessType = 'app', permissions, sub } = {}) {
    const inviteStream = sub != null ? teamStream + ':' + sub : teamStream;
    if (sub != null) await ensureStream(group.streamsPath, inviterToken, { id: inviteStream, parentId: teamStream, name: sub });
    const reqRes = await coreRequest.post(group.eventsPath).set('Authorization', inviterToken).send({
      streamIds: [inviteStream],
      type: 'consent/request-cmc',
      content: {
        to: null,
        capabilityRequested: true,
        request: {
          title: { en: 'Share your vitals' },
          description: { en: 'patient invite' },
          consent: { en: 'I consent.' },
          accessType,
          permissions: permissions ?? [{ streamId: 'vitals', level: 'contribute' }, { streamId: 'notes', level: 'read' }],
          features: { chat: false },
        },
        requesterMeta: { username: group.username, appId: APP },
      },
    });
    assert.strictEqual(reqRes.status, 201, JSON.stringify(reqRes.body));
    const capabilityUrl = reqRes.body.event.content.capabilityUrl;
    await ensureStream(patient.streamsPath, patient.token, { id: APP_ROOT, parentId: ':_cmc:apps', name: APP });
    const accRes = await coreRequest.post(patient.eventsPath).set('Authorization', patient.token).send({
      streamIds: [APP_ROOT],
      type: 'consent/accept-cmc',
      content: { capabilityUrl, accessName: 'grant-' + inviteStream.split(':').pop() + '-' + Date.now() },
    });
    assert.strictEqual(accRes.status, 201, JSON.stringify(accRes.body));
    const relationship = await pollUntil('group relationship access with the grant endpoint', async () => {
      const { accesses } = await accessesOf(group);
      return accesses.find((a) => a.clientData?.cmc?.role === 'counterparty' && a.clientData.cmc.counterparty?.username === patient.username &&
        a.clientData.cmc.scopeStreamId === inviteStream && typeof a.clientData.cmc.counterparty.apiEndpoint === 'string' &&
        a.clientData.cmc.counterparty.apiEndpoint.includes('@'));
    });
    const grant = await pollUntil('patient grant with the back-channel stamped', async () => {
      const { accesses } = await accessesOf(patient);
      return accesses.find((a) => a.clientData?.cmc?.role === 'counterparty' && a.clientData.cmc.counterparty?.username === group.username &&
        a.clientData.cmc.scopeStreamId === inviteStream && typeof a.clientData.cmc.counterparty.apiEndpoint === 'string');
    });
    return { inviteStream, relationship, grant, patientAcceptEventId: accRes.body.event.id };
  }

  async function mint (teamStream, membershipToken, content = {}, { streamId } = {}) {
    const t0 = Date.now();
    const res = await coreRequest.post(group.eventsPath).set('Authorization', membershipToken).send({
      streamIds: [streamId ?? teamStream],
      type: 'consent/member-access-cmc',
      content: { counterparty: { username: patient.username, host: TEST_HOST }, ...content },
    });
    return { res, ms: Date.now() - t0 };
  }

  async function sweepRecordFor (membershipAccessId, reason) {
    return await pollUntil('sweep record ' + reason + ' for ' + membershipAccessId, async () => {
      const r = await coreRequest.get(group.eventsPath).set('Authorization', group.token)
        .query({ streams: [APP_ROOT], types: ['consent/member-revoke-cmc'], limit: 100 });
      return (r.body?.events || []).find((e) => e.content?.membershipAccessId === membershipAccessId && e.content?.reason === reason &&
        (e.content?.status === 'completed' || e.content?.status === 'failed'));
    });
  }

  describe('[CMCGA-JOIN] joining a group', function () {
    it('[GA01] a membership request accepted by the owner mints a member-role access with its record; the member cannot accept consents for the group', async function () {
      const { membershipAccess, membershipToken, teamStream, mirror } = await joinGroup('team-join');
      assert.strictEqual(membershipAccess.type, 'shared');
      assert.deepStrictEqual(membershipAccess.clientData.cmc.membership, { approvedBy: null, requestedScopes: [teamStream] });
      assert.deepStrictEqual(membershipAccess.clientData.cmc.features, { chat: false, systemMessaging: true });
      assert.deepStrictEqual(membershipAccess.clientData.cmc.counterparty.username, member.username);
      assert.ok(membershipAccess.permissions.some((p) => p.streamId === teamStream && p.level === 'contribute'));
      assert.ok(!membershipAccess.permissions.some((p) => /:chats/.test(p.streamId)), 'no chat channel');
      assert.strictEqual(mirror.content.membership, true);
      // The team exists on the group account, provisioned by the approval.
      const teams = await coreRequest.get(group.streamsPath).set('Authorization', group.token).query({ parentId: APP_ROOT });
      assert.ok(JSON.stringify(teams.body).includes(teamStream), 'the granted team is provisioned: ' + JSON.stringify(teams.body));
      // Not exempt from the personal-token gate.
      const acc = await coreRequest.post(group.eventsPath).set('Authorization', membershipToken).send({
        streamIds: [teamStream], type: 'consent/accept-cmc', content: { capabilityUrl: 'https://x@y.example.com/' },
      });
      assert.strictEqual(acc.status, 400, JSON.stringify(acc.body));
      assert.strictEqual(acc.body.error?.data?.id, C.CmcErrorIds.ACCEPT_REQUIRES_PERSONAL_TOKEN);
      // No alert channel to the group.
      const collectors = membershipAccess.permissions.find((p) => /:collectors:/.test(p.streamId))?.streamId;
      assert.ok(collectors != null, 'the membership holds the collectors channel');
      const alert = await coreRequest.post(group.eventsPath).set('Authorization', membershipToken).send({
        streamIds: [collectors], type: 'notification/alert-cmc', content: { level: 'info', title: { en: 't' }, body: { en: 'b' } },
      });
      assert.strictEqual(alert.status, 403, JSON.stringify(alert.body));
      assert.strictEqual(alert.body.error?.data?.id, C.CmcErrorIds.MEMBER_CHANNEL_NOT_SUPPORTED);
    });

    it('[GA02] a membership offer asking for the inbox or a delegable access is refused at write', async function () {
      const teamStream = APP_ROOT + ':team-bad';
      await ensureStream(member.streamsPath, member.token, { id: APP_ROOT, parentId: ':_cmc:apps', name: APP });
      await ensureStream(member.streamsPath, member.token, { id: teamStream, parentId: APP_ROOT, name: 'team-bad' });
      for (const request of [
        { permissions: [{ streamId: ':_cmc:inbox', level: 'read' }] },
        { permissions: [{ streamId: teamStream, level: 'contribute' }], accessType: 'app' },
        { permissions: [{ streamId: teamStream, level: 'manage' }] },
      ]) {
        const res = await coreRequest.post(member.eventsPath).set('Authorization', member.token).send({
          streamIds: [teamStream],
          type: 'consent/request-cmc',
          content: { to: null, capabilityRequested: true, request: { title: { en: 't' }, description: { en: 'd' }, consent: { en: 'c' }, membership: true, ...request }, requesterMeta: { username: member.username, appId: APP } },
        });
        assert.strictEqual(res.status, 400, JSON.stringify(res.body));
        assert.strictEqual(res.body.error?.data?.id, C.CmcErrorIds.MEMBERSHIP_PERMISSIONS_INVALID, JSON.stringify(request));
      }
    });
  });

  describe('[CMCGA-MINT] a member access on the patient account', function () {
    let m, p;
    before(async function () {
      m = await joinGroup('team-mint');
      p = await invitePatient(m.teamStream, m.membershipToken);
    });

    it('[GA10] the member asks and receives, once, an endpoint that works on the patient core; the patient core completes the stamp; the record holds no token', async function () {
      const { res, ms } = await mint(m.teamStream, m.membershipToken);
      assert.strictEqual(res.status, 201, JSON.stringify(res.body));
      if (process.env.CMC_MINT_LATENCY_LOG) fs.appendFileSync(process.env.CMC_MINT_LATENCY_LOG, 'same-core mint latency ms: ' + ms + '\n');
      const ma = res.body.memberAccess;
      assert.ok(ma != null, 'memberAccess in the response: ' + JSON.stringify(res.body));
      assert.strictEqual(ma.attribution, 'stamped');
      assert.match(ma.name, /^cmc-member--/);
      assert.ok(typeof ma.expires === 'number' && ma.expires > Date.now() / 1000 + 80_000, 'about a day');
      const childToken = new URL(ma.apiEndpoint).username;
      assert.ok(childToken.length > 0);
      const event = res.body.event;
      assert.strictEqual(event.content.status, 'completed', JSON.stringify(event.content));
      assert.deepStrictEqual(event.content.memberAccess, { accessId: ma.accessId, name: ma.name, expires: ma.expires, attribution: 'stamped' });
      assert.deepStrictEqual(event.content.member, { username: member.username, host: TEST_HOST });
      assert.strictEqual(event.content.relationshipAccessId, p.relationship.id);
      assert.strictEqual(JSON.stringify(event).includes(childToken), false, 'the stored trigger holds no token');
      const stored = (await coreRequest.get(group.eventsPath + '/' + event.id).set('Authorization', group.token)).body.event;
      assert.strictEqual(JSON.stringify(stored).includes(childToken), false);
      assert.strictEqual(stored.content.status, 'completed');

      // On the patient core: the token reads what was offered, nothing more,
      // and is attributed to the member and the group.
      const info = await tokenLivesOn(patient, childToken);
      assert.ok(info != null, 'the child authenticates on the patient core');
      const stamp = info.clientData?.cmc;
      assert.deepStrictEqual(stamp, {
        role: 'member-child',
        member: { username: member.username, host: TEST_HOST },
        group: { username: group.username, host: TEST_HOST },
        viaAccessId: p.grant.id,
        scopeStreamId: p.inviteStream,
        appCode: APP,
      });
      assert.strictEqual(/[a-z]+:\/\/[^/\s"]*@/.test(JSON.stringify(info.clientData)), false, 'no endpoint in the child clientData');
      const ok = await coreRequest.get(patient.eventsPath).set('Authorization', childToken).query({ streams: ['vitals'] });
      assert.strictEqual(ok.status, 200, JSON.stringify(ok.body));
      const no = await coreRequest.get(patient.eventsPath).set('Authorization', childToken).query({ streams: ['private'] });
      assert.notStrictEqual(no.status, 200, 'a stream outside the offer is refused');
      const noAccesses = await coreRequest.get(patient.accessesPath).set('Authorization', childToken);
      assert.strictEqual(noAccesses.status, 403, 'a shared child cannot call accesses.*');
      const { accesses } = await accessesOf(patient);
      const child = accesses.find((a) => a.id === ma.accessId);
      assert.strictEqual(child.createdBy, p.grant.id, 'the child is created by the grant');
      assert.strictEqual(child.type, 'shared');
    });

    it('[GA11] a second ask reuses the same child; different permissions re-mint it', async function () {
      const a = (await mint(m.teamStream, m.membershipToken)).res;
      const b = (await mint(m.teamStream, m.membershipToken)).res;
      assert.strictEqual(a.status, 201, JSON.stringify(a.body));
      assert.strictEqual(b.status, 201, JSON.stringify(b.body));
      assert.strictEqual(b.body.memberAccess.accessId, a.body.memberAccess.accessId, 'reused');
      assert.strictEqual(new URL(b.body.memberAccess.apiEndpoint).username, new URL(a.body.memberAccess.apiEndpoint).username, 'the token is re-read');
      const c = (await mint(m.teamStream, m.membershipToken, { permissions: [{ streamId: 'vitals', level: 'contribute' }], expireAfter: 3600 })).res;
      assert.strictEqual(c.status, 201, JSON.stringify(c.body));
      assert.notStrictEqual(c.body.memberAccess.accessId, a.body.memberAccess.accessId, 're-minted');
      assert.ok(c.body.memberAccess.expires < Date.now() / 1000 + 3700);
      assert.strictEqual(await tokenLivesOn(patient, new URL(a.body.memberAccess.apiEndpoint).username), null, 'the stale child is deleted');
    });

    it('[GA12] every refusal at write carries its id; a non-delegable grant fails the trigger', async function () {
      const cases = [
        [{ token: group.token }, C.CmcErrorIds.MEMBER_ACCESS_NOT_MEMBER],
        [{ content: { scopeStreamId: APP_ROOT + ':team-other' } }, C.CmcErrorIds.MEMBER_ACCESS_SCOPE_OUTSIDE_MEMBERSHIP],
        [{ content: { counterparty: { username: 'nobody-' + cuid().slice(-6), host: TEST_HOST } } }, C.CmcErrorIds.MEMBER_ACCESS_RELATIONSHIP_NOT_FOUND],
        [{ content: { expireAfter: 10 } }, C.CmcErrorIds.MEMBER_ACCESS_EXPIRY_OUT_OF_RANGE],
        [{ content: { permissions: [{ streamId: 'notes', level: 'contribute' }] } }, C.CmcErrorIds.MEMBER_ACCESS_PERMISSIONS_NOT_SUBSET],
        [{ content: { permissions: [{ streamId: 'private', level: 'read' }] } }, C.CmcErrorIds.MEMBER_ACCESS_PERMISSIONS_NOT_SUBSET],
      ];
      for (const [over, id] of cases) {
        const { res } = await mint(m.teamStream, over.token ?? m.membershipToken, over.content ?? {});
        assert.strictEqual(res.status, 400, id + ': ' + JSON.stringify(res.body));
        assert.strictEqual(res.body.error?.data?.id, id, JSON.stringify(res.body));
      }
      // A plain shared grant: the patient core cannot mint through it.
      const m2 = await joinGroup('team-shared');
      await invitePatient(m2.teamStream, m2.membershipToken, { accessType: 'shared' });
      const { res } = await mint(m2.teamStream, m2.membershipToken);
      assert.strictEqual(res.status, 201, JSON.stringify(res.body));
      assert.strictEqual(res.body.memberAccess, undefined);
      assert.strictEqual(res.body.event.content.status, 'failed');
      assert.strictEqual(res.body.event.content.failure?.reason, C.CmcErrorIds.MEMBER_ACCESS_GRANT_NOT_DELEGABLE);
    });

    it('[GA14] a member access never outlives the membership: a membership with an end date caps the child, a shortened one re-mints within the new bound', async function () {
      const m4 = await joinGroup('team-exp');
      await invitePatient(m4.teamStream, m4.membershipToken);
      const end = Math.floor(Date.now() / 1000) + 3600;
      const upd = await coreRequest.put(group.accessesPath + '/' + m4.membershipAccess.id).set('Authorization', group.token).send({ expireAfter: 3600 });
      assert.strictEqual(upd.status, 200, JSON.stringify(upd.body));
      const first = (await mint(m4.teamStream, m4.membershipToken)).res;
      assert.strictEqual(first.status, 201, JSON.stringify(first.body));
      assert.ok(first.body.memberAccess.expires <= end + 5, 'capped at the membership: ' + first.body.memberAccess.expires + ' <= ' + end);
      const shorter = Math.floor(Date.now() / 1000) + 1800;
      // An updated access is addressed by the id the last answer returned (its serial).
      const upd2 = await coreRequest.put(group.accessesPath + '/' + upd.body.access.id).set('Authorization', group.token).send({ expireAfter: 1800 });
      assert.strictEqual(upd2.status, 200, JSON.stringify(upd2.body));
      const second = (await mint(m4.teamStream, m4.membershipToken)).res;
      assert.strictEqual(second.status, 201, JSON.stringify(second.body));
      assert.notStrictEqual(second.body.memberAccess.accessId, first.body.memberAccess.accessId, 're-minted within the new bound');
      assert.ok(second.body.memberAccess.expires <= shorter + 5);
      assert.strictEqual(await tokenLivesOn(patient, new URL(first.body.memberAccess.apiEndpoint).username), null, 'the longer child is gone');
      // A membership with less than minTtl left refuses.
      const upd3 = await coreRequest.put(group.accessesPath + '/' + upd2.body.access.id).set('Authorization', group.token).send({ expireAfter: 30 });
      assert.strictEqual(upd3.status, 200, JSON.stringify(upd3.body));
      const third = (await mint(m4.teamStream, m4.membershipToken)).res;
      assert.strictEqual(third.status, 400);
      assert.strictEqual(third.body.error?.data?.id, C.CmcErrorIds.MEMBER_ACCESS_EXPIRY_OUT_OF_RANGE);
    });

    it('[GA15] a member asks for named data streams only: a star offer yields no default and a star ask is refused', async function () {
      const m5 = await joinGroup('team-star');
      await invitePatient(m5.teamStream, m5.membershipToken, { permissions: [{ streamId: '*', level: 'read' }] });
      let r = (await mint(m5.teamStream, m5.membershipToken, { permissions: [{ streamId: '*', level: 'read' }] })).res;
      assert.strictEqual(r.status, 400);
      assert.strictEqual(r.body.error?.data?.id, C.CmcErrorIds.MEMBER_ACCESS_PERMISSIONS_NOT_SUBSET);
      r = (await mint(m5.teamStream, m5.membershipToken)).res;
      assert.strictEqual(r.status, 400, 'no named data stream was offered');
      assert.strictEqual(r.body.error?.data?.id, C.CmcErrorIds.MEMBER_ACCESS_PERMISSIONS_NOT_SUBSET);
    });

    it('[GA13] a patient core of an older release refuses the stamp: the access is minted name-only', async function () {
      const m3 = await joinGroup('team-old');
      await invitePatient(m3.teamStream, m3.membershipToken);
      const shim = globalThis.fetch;
      let refused = 0;
      globalThis.fetch = async (url, init) => {
        const u = new URL(url);
        if ((init?.method ?? 'GET') === 'POST' && u.pathname.endsWith('/accesses') && typeof init?.body === 'string' && init.body.includes('"cmc"')) {
          refused += 1;
          return { status: 400, ok: false, async json () { return { error: { id: 'invalid-operation', data: { id: 'cmc-clientdata-cmc-forbidden' } } }; }, async text () { return ''; } };
        }
        return shim(url, init);
      };
      try {
        const { res } = await mint(m3.teamStream, m3.membershipToken);
        assert.strictEqual(res.status, 201, JSON.stringify(res.body));
        assert.strictEqual(refused, 1);
        assert.strictEqual(res.body.memberAccess.attribution, 'name-only');
        const info = await tokenLivesOn(patient, new URL(res.body.memberAccess.apiEndpoint).username);
        assert.ok(info != null);
        assert.strictEqual(info.clientData?.cmc, undefined, 'no stamp');
        assert.match(info.name, /^cmc-member--/);
      } finally {
        globalThis.fetch = shim;
      }
    });
  });

  describe('[CMCGA-END] offboarding by every path', function () {
    async function liveChild (m, p) {
      const { res } = await mint(m.teamStream, m.membershipToken);
      assert.strictEqual(res.status, 201, JSON.stringify(res.body));
      const token = new URL(res.body.memberAccess.apiEndpoint).username;
      assert.ok((await tokenLivesOn(patient, token)) != null, 'premise: the child works');
      return { token, accessId: res.body.memberAccess.accessId };
    }

    it('[GA20] the group revokes the membership: the child dies on the patient core, the sweep is recorded, the member is told', async function () {
      const m = await joinGroup('team-rev');
      const p = await invitePatient(m.teamStream, m.membershipToken);
      const child = await liveChild(m, p);
      const rev = await coreRequest.post(group.eventsPath).set('Authorization', group.token).send({
        streamIds: [m.teamStream], type: 'consent/revoke-cmc', content: { accessId: m.membershipAccess.id },
      });
      assert.strictEqual(rev.status, 201, JSON.stringify(rev.body));
      await pollTokenDead(patient, child.token, 'GA20');
      const sweep = await sweepRecordFor(m.membershipAccess.id, 'revoke');
      assert.strictEqual(sweep.content.status, 'completed', JSON.stringify(sweep.content));
      assert.deepStrictEqual(sweep.content.member, { username: member.username, host: TEST_HOST });
      assert.deepStrictEqual(sweep.content.outcome, [{ childAccessId: child.accessId, result: 'deleted' }]);
      assert.deepStrictEqual(sweep.content.residuals, []);
      assert.strictEqual(JSON.stringify(sweep).includes(child.token), false);
      await pollTokenDead(group, m.membershipToken, 'GA20 membership');
      // The member's back-channel to the group is gone too.
      await pollUntil('member back-channel deleted', async () => {
        const { accesses } = await accessesOf(member);
        return !accesses.some((a) => a.clientData?.cmc?.role === 'counterparty' && a.clientData.cmc.counterparty?.username === group.username && a.clientData.cmc.scopeStreamId === m.teamStream);
      });
    });

    it('[GA21] the member leaves (revokes its back-channel): the group deletes the membership and sweeps', async function () {
      const m = await joinGroup('team-leave');
      const p = await invitePatient(m.teamStream, m.membershipToken);
      const child = await liveChild(m, p);
      const { accesses } = await accessesOf(member);
      const backChannel = accesses.find((a) => a.clientData?.cmc?.role === 'counterparty' && a.clientData.cmc.counterparty?.username === group.username && a.clientData.cmc.scopeStreamId === m.teamStream);
      assert.ok(backChannel != null);
      const rev = await coreRequest.post(member.eventsPath).set('Authorization', member.token).send({
        streamIds: [m.teamStream], type: 'consent/revoke-cmc', content: { accessId: backChannel.id },
      });
      assert.strictEqual(rev.status, 201, JSON.stringify(rev.body));
      await pollTokenDead(patient, child.token, 'GA21');
      await pollTokenDead(group, m.membershipToken, 'GA21 membership');
      const sweep = await sweepRecordFor(m.membershipAccess.id, 'revoke');
      assert.deepStrictEqual(sweep.content.outcome, [{ childAccessId: child.accessId, result: 'deleted' }]);
    });

    it('[GA22] a plain accesses.delete of the membership sweeps; a deletion record stays, readable with includeDeletions', async function () {
      const m = await joinGroup('team-del');
      const p = await invitePatient(m.teamStream, m.membershipToken);
      const child = await liveChild(m, p);
      const del = await coreRequest.delete(group.accessesPath + '/' + m.membershipAccess.id).set('Authorization', group.token);
      assert.strictEqual(del.status, 200, JSON.stringify(del.body));
      await pollTokenDead(patient, child.token, 'GA22');
      const sweep = await sweepRecordFor(m.membershipAccess.id, 'accesses.delete');
      assert.deepStrictEqual(sweep.content.outcome, [{ childAccessId: child.accessId, result: 'deleted' }]);
      const { accessDeletions } = await accessesOf(group, group.token, { includeDeletions: true });
      const record = accessDeletions.find((d) => d.id === m.membershipAccess.id);
      assert.ok(record != null, 'the membership keeps its deletion record');
      assert.ok(typeof record.deleted === 'number');
      assert.strictEqual(record.token, undefined);
      // The child, deleted by the sweep through the grant, keeps its record on the patient side.
      const patientDeletions = (await accessesOf(patient, patient.token, { includeDeletions: true })).accessDeletions;
      const childRecord = patientDeletions.find((d) => d.id === child.accessId);
      assert.ok(childRecord != null, 'the swept child keeps its name: ' + JSON.stringify(patientDeletions.map((d) => d.id)));
      assert.match(childRecord.name, /^cmc-member--/);
    });

    it('[GA23] a membership a delegate administrator approved ends with the delegation; the sweep says detach', async function () {
      // The carer becomes a delegate of the group account.
      const reqRes = await coreRequest.post(group.delegationsPath + '/attach-request').set('Authorization', group.token).send({ delegateUsername: admin.username });
      assert.strictEqual(reqRes.status, 201, JSON.stringify(reqRes.body));
      const accRes = await coreRequest.post(admin.delegationsPath + '/controlled/' + group.username + '/accept').set('Authorization', admin.token).send({});
      assert.strictEqual(accRes.status, 200, JSON.stringify(accRes.body));
      const tokRes = await coreRequest.post(admin.delegationsPath + '/controlled/' + group.username + '/token').set('Authorization', admin.token).send({});
      assert.strictEqual(tokRes.status, 200, JSON.stringify(tokRes.body));
      const pat = tokRes.body.token;
      const m = await joinGroup('team-deleg', { accepterToken: pat });
      assert.deepStrictEqual(m.membershipAccess.clientData.cmc.membership.approvedBy?.delegate?.username, admin.username);
      assert.strictEqual(typeof m.membershipAccess.clientData.delegation?.relId, 'string', 'the membership carries the delegation lineage');
      const p = await invitePatient(m.teamStream, m.membershipToken);
      const child = await liveChild(m, p);
      const det = await coreRequest.delete(group.delegationsPath + '/delegates/' + admin.username).set('Authorization', group.token);
      assert.strictEqual(det.status, 200, JSON.stringify(det.body));
      await pollTokenDead(group, m.membershipToken, 'GA23 membership');
      await pollTokenDead(patient, child.token, 'GA23 child');
      const sweep = await sweepRecordFor(m.membershipAccess.id, 'detach');
      assert.deepStrictEqual(sweep.content.outcome, [{ childAccessId: child.accessId, result: 'deleted' }]);
    });

    it('[GA24] the patient withdraws: the grant and the children die on the patient core; the member cannot mint any more', async function () {
      const m = await joinGroup('team-pat');
      const p = await invitePatient(m.teamStream, m.membershipToken);
      const child = await liveChild(m, p);
      const collectors = p.grant.permissions.find((x) => /:collectors:/.test(x.streamId))?.streamId;
      const rev = await coreRequest.post(patient.eventsPath).set('Authorization', patient.token).send({
        streamIds: [collectors ?? APP_ROOT], type: 'consent/revoke-cmc', content: { accessId: p.grant.id },
      });
      assert.strictEqual(rev.status, 201, JSON.stringify(rev.body));
      await pollTokenDead(patient, child.token, 'GA24');
      assert.strictEqual(await tokenLivesOn(patient, p.grant.token), null, 'the grant is gone');
      await pollUntil('group relationship deleted', async () => {
        const { accesses } = await accessesOf(group);
        return !accesses.some((a) => a.id === p.relationship.id);
      });
      const { res } = await mint(m.teamStream, m.membershipToken);
      assert.strictEqual(res.status, 400);
      assert.strictEqual(res.body.error?.data?.id, C.CmcErrorIds.MEMBER_ACCESS_RELATIONSHIP_NOT_FOUND);
      // Both sides keep a deletion record of their half.
      const patientDeletions = (await accessesOf(patient, patient.token, { includeDeletions: true })).accessDeletions;
      assert.ok(patientDeletions.some((d) => d.id === p.grant.id), 'the grant keeps its deletion record');
      assert.ok(patientDeletions.some((d) => d.id === child.accessId), 'the cascaded child keeps its deletion record');
      const groupDeletions = (await accessesOf(group, group.token, { includeDeletions: true })).accessDeletions;
      assert.ok(groupDeletions.some((d) => d.id === p.relationship.id), 'the back-channel keeps its deletion record');
    });
  });

  describe('[CMCGA-DEL] every CMC teardown is the route deletion', function () {
    it('[GA30] a consent revoke deletes the webhooks of the grant and releases the alias of a sub-access, and a re-accept mints a fresh grant', async function () {
      const m = await joinGroup('team-side');
      const p = await invitePatient(m.teamStream, m.membershipToken);
      // A webhook the grant owns on the patient account.
      const wh = await coreRequest.post(patient.webhooksPath).set('Authorization', p.grant.token).send({ url: 'https://example.com/hook-' + cuid().slice(-6) });
      assert.strictEqual(wh.status, 201, JSON.stringify(wh.body));
      // A sub-access the grant created with an alias.
      const sub = await coreRequest.post(patient.accessesPath).set('Authorization', p.grant.token)
        .send({ name: 'sub-' + cuid().slice(-6), type: 'shared', randomAlias: true, permissions: [{ streamId: 'notes', level: 'read' }] });
      assert.strictEqual(sub.status, 201, JSON.stringify(sub.body));
      const { alias, token: subToken, id: subId } = sub.body.access;
      assert.ok(alias != null);
      assert.strictEqual((await coreRequest.get('/' + alias + '/access-info').set('Authorization', subToken)).status, 200);

      const collectors = p.grant.permissions.find((x) => /:collectors:/.test(x.streamId))?.streamId;
      const rev = await coreRequest.post(patient.eventsPath).set('Authorization', patient.token).send({
        streamIds: [collectors ?? APP_ROOT], type: 'consent/revoke-cmc', content: { accessId: p.grant.id },
      });
      assert.strictEqual(rev.status, 201, JSON.stringify(rev.body));
      await pollTokenDead(patient, subToken, 'GA30 sub-access');
      assert.strictEqual((await coreRequest.get('/' + alias + '/access-info').set('Authorization', subToken)).status, 404, 'the alias no longer resolves');
      const hooks = await coreRequest.get(patient.webhooksPath).set('Authorization', patient.token);
      assert.strictEqual(hooks.status, 200);
      assert.ok(!hooks.body.webhooks.some((h) => h.id === wh.body.webhook.id), 'the grant\'s webhook is deleted');
      const deletions = (await accessesOf(patient, patient.token, { includeDeletions: true })).accessDeletions;
      assert.ok(deletions.some((d) => d.id === subId), 'the sub-access keeps its deletion record');

      // A re-accept mints a fresh grant rather than healing the deleted row.
      const again = await invitePatient(m.teamStream, m.membershipToken);
      assert.notStrictEqual(again.grant.id, p.grant.id);
      assert.notStrictEqual(again.relationship.id, p.relationship.id, 'the group side mints a fresh back-channel too');
      assert.ok((await tokenLivesOn(patient, again.grant.token)) != null);
      const { res } = await mint(m.teamStream, m.membershipToken);
      assert.strictEqual(res.status, 201, JSON.stringify(res.body));
      assert.strictEqual(res.body.memberAccess?.attribution, 'stamped');
    });

    it('[GA31] an app token may delete the shared accesses it created only', async function () {
      const appToken = cuid();
      const appId = cuid();
      await patient.fixture.access({ id: appId, token: appToken, type: 'app', permissions: [{ streamId: 'notes', level: 'manage' }] });
      const planted = cuid();
      await patient.fixture.access({ id: planted, token: cuid(), type: 'app', name: 'planted-' + planted.slice(-6), createdBy: appId, permissions: [{ streamId: 'notes', level: 'read' }] });
      const own = await coreRequest.post(patient.accessesPath).set('Authorization', appToken).send({ name: 'own-' + cuid().slice(-6), type: 'shared', permissions: [{ streamId: 'notes', level: 'read' }] });
      assert.strictEqual(own.status, 201, JSON.stringify(own.body));
      const refused = await coreRequest.delete(patient.accessesPath + '/' + planted).set('Authorization', appToken);
      assert.strictEqual(refused.status, 403, JSON.stringify(refused.body));
      const ok = await coreRequest.delete(patient.accessesPath + '/' + own.body.access.id).set('Authorization', appToken);
      assert.strictEqual(ok.status, 200, JSON.stringify(ok.body));
    });
  });

  describe('[CMCGA-ERASE] the group account is deleted while a member access lives on a patient core', function () {
    // Last in the file: it erases the group, so it takes a fresh one.
    let adminKey;
    before(async function () {
      await require('api-server/src/methods/auth/delete.ts').default(global.app.api);
      adminKey = (await require('@pryv/boiler').getConfig()).get('auth:adminAccessKey');
      group = await makeActor('practice-erase-' + cuid().slice(-8));
    });

    it('[GA40] the child is deleted on the patient core through the grant before the erasure; the grant itself dies with the account-deletion notice', async function () {
      const m = await joinGroup('team-erase');
      const p = await invitePatient(m.teamStream, m.membershipToken);
      const { res } = await mint(m.teamStream, m.membershipToken);
      assert.strictEqual(res.status, 201, JSON.stringify(res.body));
      const childToken = new URL(res.body.memberAccess.apiEndpoint).username;
      assert.ok((await tokenLivesOn(patient, childToken)) != null, 'premise: the child works');
      const del = await coreRequest.delete('/users/' + group.username).set('Authorization', adminKey);
      assert.strictEqual(del.status, 200, JSON.stringify(del.body));
      await pollTokenDead(patient, childToken, 'GA40 child');
      await pollUntil('GA40: the patient still holds the grant to the erased group', async () => {
        const { accesses } = await accessesOf(patient);
        return !accesses.some((a) => a.id === p.grant.id);
      });
      assert.strictEqual((await coreRequest.get(group.accessInfoPath).set('Authorization', m.membershipToken)).status, 404, 'the group is gone');
    });
  });
});
