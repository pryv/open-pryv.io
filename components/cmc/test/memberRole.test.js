/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);

/**
 * CMC plugin, group accounts: the `member` role and the membership offer.
 *
 * [CMCMB] covers what a membership offer may ask, the `member` role's
 * admission across the hooks (a peer for protocol deliveries, a local actor
 * for triggers), the patient-side admission of the member stamp on
 * accesses.create and the guard against stripping it on update, and the
 * accept that mints a membership access.
 */

const assert = require('node:assert/strict');
const C = require('../src/constants.ts');
const V = require('../src/validators.ts');
const { CmcErrorIds } = require('../src/errorIds.ts');
const hooks = require('../src/hooks.ts');
const { createInboxWriteHook } = require('../src/inboxWriteHook.ts');
const { dispatch } = require('../src/dispatch.ts');
const { selectRelationshipAccess } = require('../src/relationshipKey.ts');
const { handleAccept } = require('../src/handleAccept.ts');
const { handleIncomingAccept } = require('../src/handleIncomingAccept.ts');
const { handleRevoke } = require('../src/handleRevoke.ts');
const { handleIncomingRevoke } = require('../src/handleIncomingRevoke.ts');
const { handleSystemAlert } = require('../src/handleSystem.ts');
const { handleChat } = require('../src/handleChat.ts');
const { handleIncomingBackChannel } = require('../src/handleIncomingBackChannel.ts');
const { createAccessesDeletePostHook } = require('../src/accessesDeleteHook.ts');
const { assertOutboundUrl, fakeUpdateWithMerge } = require('./_fake-assertions.cjs');

function fakeErrors () {
  const captured = [];
  return {
    captured,
    factory: {
      invalidOperation (message, details) {
        const e = new Error(message); e.details = details; e.kind = 'invalidOperation'; captured.push(e); return e;
      },
      forbidden (message, details) {
        const e = new Error(message); e.details = details; e.kind = 'forbidden'; captured.push(e); return e;
      },
    },
  };
}

function run (mw, context, params, result) {
  return new Promise((resolve) => { mw(context, params, result, (err) => resolve(err)); });
}

function fakeFetch (responses) {
  const calls = [];
  let idx = 0;
  return {
    fetch (url, init) {
      assertOutboundUrl(url, init);
      calls.push({ url, init });
      const spec = Array.isArray(responses) ? responses[idx++] : responses;
      if (spec instanceof Error) return Promise.reject(spec);
      return Promise.resolve({
        status: spec.status,
        ok: spec.status >= 200 && spec.status < 300,
        async json () { return spec.body; },
        async text () { return JSON.stringify(spec.body); },
      });
    },
    calls,
  };
}

const MEMBER_ID = { username: 'dr-amy', host: 'member.example.com' };
const GROUP_ID = { username: 'practice', host: 'group.example.com' };
const TEAM_A = ':_cmc:apps:practice:team-a';

const MEMBERSHIP_ACCESS = {
  id: 'acc-membership',
  type: 'shared',
  clientData: {
    cmc: {
      role: 'member',
      appCode: 'practice',
      scopeStreamId: TEAM_A,
      counterparty: { ...MEMBER_ID, apiEndpoint: 'https://member-bc-tok@member.example.com/', remoteCollectorStreamId: TEAM_A + ':collectors:practice--group-example-com' },
      membership: { approvedBy: null, requestedScopes: [TEAM_A] },
    },
  },
};

const MEMBERSHIP_OFFER_REQUEST = {
  title: { en: 'Join team A' },
  description: { en: 'd' },
  consent: { en: 'c' },
  membership: true,
  permissions: [{ streamId: TEAM_A, level: 'contribute' }],
};

describe('[CMCMB] cmc group accounts: the member role and the membership offer', () => {
  describe('[CMCMB-OFFER] what a membership offer may ask', () => {
    it('[MB01] request.membership is a boolean; the admissible offer validates', () => {
      assert.equal(V.validate('consent/request-cmc', { to: null, request: MEMBERSHIP_OFFER_REQUEST }).valid, true);
      const bad = V.validate('consent/request-cmc', { to: null, request: { ...MEMBERSHIP_OFFER_REQUEST, membership: 'yes' } });
      assert.equal(bad.valid, false);
      assert.ok(bad.errors.some((e) => e.includes('membership')));
    });

    it('[MB02] the inbox, the star, a chats leaf, manage, a feature permission and a delegable type are violations', () => {
      const cases = [
        { permissions: [{ streamId: ':_cmc:inbox', level: 'read' }] },
        { permissions: [{ streamId: '*', level: 'read' }] },
        { permissions: [{ streamId: TEAM_A + ':chats', level: 'read' }] },
        { permissions: [{ streamId: TEAM_A + ':collectors:x--y', level: 'contribute' }] },
        { permissions: [{ streamId: TEAM_A, level: 'manage' }] },
        { permissions: [{ streamId: TEAM_A, level: 'create-only' }] },
        { permissions: [{ streamId: TEAM_A, level: 'read' }, { feature: 'selfRevoke', setting: 'forbidden' }] },
        { permissions: [{ streamId: TEAM_A, level: 'read' }], accessType: 'app' },
      ];
      for (const c of cases) {
        const violations = V.membershipOfferViolations({ ...MEMBERSHIP_OFFER_REQUEST, ...c });
        assert.ok(violations.length > 0, 'expected a violation for ' + JSON.stringify(c));
      }
      assert.deepEqual(V.membershipOfferViolations({ ...MEMBERSHIP_OFFER_REQUEST, accessType: 'shared' }), []);
      assert.deepEqual(V.membershipOfferViolations({ ...MEMBERSHIP_OFFER_REQUEST, permissions: [{ streamId: TEAM_A, level: 'read' }] }), []);
    });

    it('[MB03] the offer hook refuses a violation with cmc-membership-permissions-invalid and forces allowUserChoice + chat off', async () => {
      const { factory } = fakeErrors();
      const mw = hooks.createMembershipOfferHook({ errors: factory });
      const refused = { newEvent: { type: 'consent/request-cmc', content: { to: null, request: { ...MEMBERSHIP_OFFER_REQUEST, permissions: [{ streamId: ':_cmc:inbox', level: 'read' }] } } } };
      const err = await run(mw, refused, {}, {});
      assert.equal(err?.details?.id, CmcErrorIds.MEMBERSHIP_PERMISSIONS_INVALID);

      const ctx = { newEvent: { type: 'consent/request-cmc', content: { to: null, request: { ...MEMBERSHIP_OFFER_REQUEST, allowUserChoice: false, features: { chat: true, systemMessaging: true } } } } };
      assert.equal(await run(mw, ctx, {}, {}), undefined);
      assert.equal(ctx.newEvent.content.request.allowUserChoice, true);
      assert.deepEqual(ctx.newEvent.content.request.features, { chat: false, systemMessaging: true });

      // An ordinary offer is left as sent.
      const plain = { newEvent: { type: 'consent/request-cmc', content: { to: null, request: { ...MEMBERSHIP_OFFER_REQUEST, membership: false, allowUserChoice: false } } } };
      assert.equal(await run(mw, plain, {}, {}), undefined);
      assert.equal(plain.newEvent.content.request.allowUserChoice, false);
    });

    it('[MB04] a client write of consent/member-revoke-cmc is refused for every token, personal included', async () => {
      const { factory } = fakeErrors();
      const mw = hooks.createMemberRevokeWriteGuardHook({ errors: factory });
      const err = await run(mw, { newEvent: { type: 'consent/member-revoke-cmc', content: {} }, access: { isPersonal: () => true } }, {}, {});
      assert.equal(err?.kind, 'forbidden');
      assert.equal(err?.details?.id, CmcErrorIds.PROTECTED_EVENT_WRITE);
      assert.equal(await run(mw, { newEvent: { type: 'consent/member-access-cmc', content: {} } }, {}, {}), undefined);
    });
  });

  describe('[CMCMB-STAMP] the member stamp on the patient core', () => {
    const GRANT = {
      id: 'acc-grant',
      type: 'app',
      clientData: {
        cmc: {
          role: 'counterparty',
          appCode: 'practice',
          scopeStreamId: TEAM_A,
          counterparty: { ...GROUP_ID, apiEndpoint: 'https://group-bc-tok@group.example.com/', remoteChatStreamId: TEAM_A + ':chats:x', remoteCollectorStreamId: TEAM_A + ':collectors:x' },
          backChannelApiEndpoint: 'https://group-bc-tok@group.example.com/',
        },
      },
    };
    const PAYLOAD = { role: 'member-child', member: { ...MEMBER_ID } };

    it('[MB10] a delegable grant may create a child with exactly the member stamp; the stored stamp is built from the grant, field by field, with no URL userinfo', async () => {
      const { factory } = fakeErrors();
      const mw = hooks.createAccessCreateForgePreventionHook({ errors: factory });
      const params = { type: 'shared', permissions: [], clientData: { cmc: PAYLOAD, other: 1 } };
      assert.equal(await run(mw, { access: GRANT }, params, {}), undefined);
      assert.deepEqual(params.clientData, {
        other: 1,
        cmc: {
          role: 'member-child',
          member: MEMBER_ID,
          group: GROUP_ID,
          viaAccessId: 'acc-grant',
          scopeStreamId: TEAM_A,
          appCode: 'practice',
        },
      });
      const serialized = JSON.stringify(params.clientData);
      assert.equal(serialized.includes('tok'), false, 'no token from the grant reaches the child: ' + serialized);
      assert.equal(/[a-z]+:\/\/[^/]*@/.test(serialized), false, 'no URL with userinfo in the child clientData');
    });

    it('[MB11] the stamp is refused for a non-delegable grant, a non-grant caller and a personal token (cmc-clientdata-cmc-forbidden)', async () => {
      const { factory } = fakeErrors();
      const mw = hooks.createAccessCreateForgePreventionHook({ errors: factory });
      for (const access of [
        { ...GRANT, type: 'shared' },
        { id: 'x', type: 'app', clientData: {} },
        { id: 'p', type: 'personal', isPersonal: () => true },
        { ...GRANT, clientData: { cmc: { ...GRANT.clientData.cmc, role: 'member' } } },
        undefined,
      ]) {
        const err = await run(mw, { access }, { clientData: { cmc: PAYLOAD } }, {});
        assert.equal(err?.details?.id, CmcErrorIds.CLIENTDATA_CMC_FORBIDDEN, JSON.stringify(access));
      }
    });

    it('[MB12] a payload that is not exactly the member stamp is refused with cmc-member-stamp-invalid', async () => {
      const { factory } = fakeErrors();
      const mw = hooks.createAccessCreateForgePreventionHook({ errors: factory });
      const bad = [
        { role: 'counterparty', member: MEMBER_ID },
        { role: 'member-child', member: MEMBER_ID, group: GROUP_ID },
        { role: 'member-child', member: { username: 'a' } },
        { role: 'member-child', member: { ...MEMBER_ID, apiEndpoint: 'https://t@x/' } },
        { role: 'member-child', member: { username: '', host: 'h' } },
        { role: 'member-child', member: { username: 'a'.repeat(201), host: 'h' } },
        { role: 'member-child', member: { username: 'dr amy', host: 'h' } },
        { role: 'member-child', member: { username: 'amy\n<script>', host: 'h' } },
        { role: 'member-child', member: { username: 'amy', host: 'h\x7f' } },
        { role: 'member-child', member: { username: 'amy‮', host: 'h' } },
        { role: 'member-child', member: { username: 'a​my', host: 'h' } },
        { role: 'member-child', member: { username: 'amy\x85', host: 'h' } },
        { role: 'member-child', member: { username: '⁦amy', host: 'h' } },
        { role: 'member-child', member: { username: 'amy', host: 'h﻿' } },
        { role: 'member-child' },
        'member-child',
      ];
      for (const cmc of bad) {
        const err = await run(mw, { access: GRANT }, { clientData: { cmc } }, {});
        assert.equal(err?.details?.id, CmcErrorIds.MEMBER_STAMP_INVALID, JSON.stringify(cmc));
      }
      // A stamped child holds named data streams only.
      for (const permissions of [[{ streamId: '*', level: 'read' }], [{ streamId: ':_cmc:inbox', level: 'read' }]]) {
        const err = await run(mw, { access: GRANT }, { permissions, clientData: { cmc: PAYLOAD } }, {});
        assert.equal(err?.details?.id, CmcErrorIds.MEMBER_STAMP_INVALID, JSON.stringify(permissions));
      }
    });

    it('[MB13] an update that would remove the stamp ({ cmc: null }, { clientData: null }) is refused; other clientData keys and an untouched clientData pass', async () => {
      const { factory } = fakeErrors();
      const guard = hooks.createAccessUpdateStampGuardHook({ errors: factory });
      const target = { id: 'child', clientData: { cmc: { role: 'member-child' } } };
      for (const clientData of [{ cmc: null }, null, { cmc: undefined }]) {
        const err = await run(guard, {}, { id: 'child', update: { clientData }, targetAccess: target }, {});
        assert.equal(err?.details?.id, CmcErrorIds.CLIENTDATA_CMC_FORBIDDEN, JSON.stringify(clientData));
      }
      assert.equal(await run(guard, {}, { id: 'child', update: { clientData: { other: 1 } }, targetAccess: target }, {}), undefined, 'another key merges beside the stamp');
      assert.equal(await run(guard, {}, { id: 'child', update: { name: 'n' }, targetAccess: target }, {}), undefined);
      assert.equal(await run(guard, {}, { id: 'plain', update: { clientData: null }, targetAccess: { id: 'plain', clientData: { x: 1 } } }, {}), undefined);
    });
  });

  describe('[CMCMB-PEER] a member is a peer for protocol deliveries', () => {
    it('[MB20] the inbox admits a membership access for the inbox types and stamps content.from from its identity', async () => {
      const { factory } = fakeErrors();
      const mw = createInboxWriteHook({ errors: factory });
      for (const type of C.EVENT_TYPES_INBOX) {
        const ctx = { newEvent: { streamIds: [':_cmc:inbox'], type, content: { from: { username: 'forged', host: 'evil' }, accessId: 'x' } }, access: MEMBERSHIP_ACCESS };
        assert.equal(await run(mw, ctx, {}, {}), undefined, type);
        assert.deepEqual(ctx.newEvent.content.from, MEMBER_ID);
      }
      const err = await run(mw, { newEvent: { streamIds: [':_cmc:inbox'], type: 'consent/accept-cmc', content: {} }, access: MEMBERSHIP_ACCESS }, {}, {});
      assert.equal(err?.details?.id, 'cmc-event-type-not-allowed');
    });

    it('[MB21] a chat or a user alert written by a member is refused with cmc-member-channel-not-supported; a scope request passes', async () => {
      const { factory } = fakeErrors();
      const gate = hooks.createCounterpartyFeatureGateHook({ errors: factory });
      for (const type of [C.ET_CHAT, C.ET_SYSTEM_ALERT, C.ET_SYSTEM_ACK]) {
        const err = await run(gate, { newEvent: { type, streamIds: [TEAM_A + ':collectors:x'] }, access: MEMBERSHIP_ACCESS }, {}, {});
        assert.equal(err?.kind, 'forbidden', type);
        assert.equal(err?.details?.id, CmcErrorIds.MEMBER_CHANNEL_NOT_SUPPORTED, type);
      }
      assert.equal(await run(gate, { newEvent: { type: C.ET_SYSTEM_SCOPE_REQUEST }, access: MEMBERSHIP_ACCESS }, {}, {}), undefined);
      // The member stamp on a from-carrying write comes from the membership.
      const stamp = hooks.createCounterpartyFromStampingHook({ errors: factory });
      const ctx = { newEvent: { type: C.ET_SYSTEM_SCOPE_REQUEST, streamIds: [TEAM_A + ':collectors:x'], content: { from: { username: 'forged', host: 'evil' } } }, access: MEMBERSHIP_ACCESS };
      assert.equal(await run(stamp, ctx, {}, {}), undefined);
      assert.deepEqual(ctx.newEvent.content.from, MEMBER_ID);
    });

    it('[MB22] dispatch treats an event a membership access wrote as peer-delivered (no outbound ping-pong)', async () => {
      const calls = [];
      const mall = {
        accesses: { async get () { return [MEMBERSHIP_ACCESS]; } },
        events: {
          async updateWithMerge (...a) { return fakeUpdateWithMerge(this, ...a); },
          async getOne () { return { id: 'ev1', type: C.ET_SYSTEM_SCOPE_REQUEST, content: {} }; },
          async update (u, e) { calls.push(e); },
        },
      };
      const { fetch, calls: outbound } = fakeFetch({ status: 201, body: {} });
      const r = await dispatch({
        userId: 'group',
        event: { id: 'ev1', type: C.ET_SYSTEM_SCOPE_REQUEST, streamIds: [TEAM_A + ':collectors:x'], createdBy: 'acc-membership caller-1', content: { newPermissions: [{ streamId: 'a', level: 'read' }] } },
        deps: { mall, fetch, selfIdentityFor: () => GROUP_ID, enqueueRetries: false },
      });
      assert.deepEqual({ status: r.status, reason: r.reason }, { status: 'skipped', reason: 'cmc-incoming-from-peer' });
      assert.equal(outbound.length, 0);
    });

    it('[MB23] selectRelationshipAccess takes a list of roles; the group resolves a membership with both', () => {
      const accesses = [MEMBERSHIP_ACCESS, { id: 'other', clientData: { cmc: { role: 'counterparty', scopeStreamId: TEAM_A, counterparty: { username: 'pat', host: 'p.example.com' } } } }];
      const key = { username: MEMBER_ID.username, hostSlug: 'member-example-com' };
      assert.equal(selectRelationshipAccess({ accesses, counterparty: key, scopeStreamId: TEAM_A }), null, 'counterparty only by default');
      assert.equal(selectRelationshipAccess({ accesses, role: C.RELATIONSHIP_ROLES, counterparty: key, scopeStreamId: TEAM_A })?.id, 'acc-membership');
      assert.equal(selectRelationshipAccess({ accesses, role: 'member', counterparty: key, scopeStreamId: TEAM_A })?.id, 'acc-membership');
    });

    it('[MB24] the member\'s back-channel delivery stamps the membership access on the group side', async () => {
      const updates = [];
      const mall = { accesses: { async get () { return [{ ...MEMBERSHIP_ACCESS, clientData: { cmc: { ...MEMBERSHIP_ACCESS.clientData.cmc, counterparty: MEMBER_ID } } }]; }, async update (u, p) { updates.push(p); return null; } } };
      const r = await handleIncomingBackChannel({
        userId: 'group',
        event: { type: C.ET_BACK_CHANNEL, streamIds: [':_cmc:inbox'], content: { from: MEMBER_ID, apiEndpoint: 'https://bc-tok@member.example.com/', remoteCollectorStreamId: TEAM_A + ':collectors:practice--group-example-com', scopeStreamId: TEAM_A } },
        deps: { mall },
      });
      assert.equal(r.ok, true, JSON.stringify(r));
      assert.equal(updates[0].id, 'acc-membership');
      assert.equal(updates[0].update.clientData.cmc.role, 'member', 'the role is kept');
      assert.equal(updates[0].update.clientData.cmc.counterparty.apiEndpoint, 'https://bc-tok@member.example.com/');
    });

    it('[MB25] one account holding both roles under one scope: a back-channel stamps the access it was written with, and a revoke tears down same-role siblings only', async () => {
      const both = { username: 'staff', host: 'member.example.com' };
      const membership = { id: 'acc-m', created: 2, clientData: { cmc: { role: 'member', scopeStreamId: TEAM_A, counterparty: both } } };
      const patientRel = { id: 'acc-p', created: 1, clientData: { cmc: { role: 'counterparty', scopeStreamId: TEAM_A, counterparty: both } } };
      const updates = [];
      const mall = { accesses: { async get () { return [membership, patientRel]; }, async update (u, p) { updates.push(p); return null; } } };
      const content = { from: both, apiEndpoint: 'https://g@patient.example.com/', scopeStreamId: TEAM_A, remoteCollectorStreamId: TEAM_A + ':collectors:x' };
      let r = await handleIncomingBackChannel({ userId: 'group', event: { type: C.ET_BACK_CHANNEL, streamIds: [':_cmc:inbox'], createdBy: 'acc-p caller', content }, deps: { mall } });
      assert.equal(r.ok, true, JSON.stringify(r));
      assert.equal(updates[0].id, 'acc-p', 'bound to the writer, not the newest same-identity access');
      r = await handleIncomingBackChannel({ userId: 'group', event: { type: C.ET_BACK_CHANNEL, streamIds: [':_cmc:inbox'], createdBy: 'acc-m', content }, deps: { mall } });
      assert.equal(updates[1].id, 'acc-m');
      const deleted = [];
      const mall2 = { accesses: { async get () { return [membership, patientRel]; }, async delete (u, p) { deleted.push(p.id); } }, events: { async updateWithMerge () { return null; }, async getOne () { return null; }, async update () {} } };
      const rr = await handleIncomingRevoke({ userId: 'group', event: { type: C.ET_REVOKE, streamIds: [':_cmc:inbox'], createdBy: 'acc-m', content: {} }, deps: { mall: mall2 } });
      assert.deepEqual(rr.deletedAccessIds, ['acc-m'], 'the patient relationship of the same person stays');
    });
  });

  describe('[CMCMB-ACCEPT] accepting a membership', () => {
    const MEMBERSHIP_OFFER = {
      id: 'evt-offer-m',
      type: 'consent/request-cmc',
      content: {
        request: { ...MEMBERSHIP_OFFER_REQUEST, permissions: [{ streamId: TEAM_A, level: 'contribute' }, { streamId: ':_cmc:apps:practice:team-b', level: 'contribute' }], features: { chat: true } },
        requesterMeta: { username: MEMBER_ID.username, appId: 'practice' },
        requesterUsername: MEMBER_ID.username,
        requesterHost: MEMBER_ID.host,
        originStreamId: TEAM_A,
        capabilityId: 'cap-m',
      },
    };
    function fakeMall () {
      const calls = { accessesCreated: [], streamsCreated: [] };
      return {
        calls,
        accesses: {
          async create (u, p) { calls.accessesCreated.push(p); return { id: 'acc-m', token: 't', apiEndpoint: 'https://t@group.example.com/', ...p }; },
          async get () { return []; },
          async delete () {},
        },
        events: { async updateWithMerge () { return null; }, async update () {} },
        streams: { async create (u, p) { calls.streamsCreated.push(p.id); return { id: p.id }; } },
      };
    }

    it('[MB30] the owner accepts a team: the access is a shared member-role access without chat, the membership record names the requested scopes, the teams exist, the delivered accept is marked', async () => {
      const mall = fakeMall();
      const { fetch, calls } = fakeFetch([{ status: 200, body: { events: [MEMBERSHIP_OFFER] } }, { status: 201, body: { event: { id: 'r' } } }]);
      const r = await handleAccept({
        userId: 'group',
        triggerEvent: { id: 'evt-acc-m', type: 'consent/accept-cmc', streamIds: [':_cmc:apps:practice'], content: { capabilityUrl: 'https://Tok@member.example.com/', grantedPermissions: [{ streamId: TEAM_A, level: 'contribute' }], features: { chat: true } } },
        selfIdentity: GROUP_ID,
        // No triggerAccess: the tree-aware consent guard needs a live mall
        // (covered by the api-server suite); the pure subset rule still runs.
        deps: { mall, fetch },
      });
      assert.equal(r.ok, true, JSON.stringify(r));
      const created = mall.calls.accessesCreated[0];
      assert.equal(created.type, 'shared');
      assert.equal(created.clientData.cmc.role, 'member');
      assert.deepEqual(created.clientData.cmc.membership, { approvedBy: null, requestedScopes: [TEAM_A, ':_cmc:apps:practice:team-b'] });
      assert.deepEqual(created.clientData.cmc.features, { chat: false, systemMessaging: true });
      assert.ok(created.permissions.some((p) => p.streamId === TEAM_A && p.level === 'contribute'));
      assert.equal(created.permissions.some((p) => p.streamId === ':_cmc:apps:practice:team-b'), false, 'the administrator narrowed to team A');
      assert.equal(created.permissions.some((p) => p.streamId === ':_cmc:inbox' && p.level === 'create-only'), true);
      assert.equal(created.permissions.some((p) => /:chats/.test(p.streamId)), false, 'no chat channel for a membership');
      assert.ok(mall.calls.streamsCreated.includes(TEAM_A), 'the granted team is provisioned: ' + mall.calls.streamsCreated.join(','));
      assert.ok(mall.calls.streamsCreated.includes(':_cmc:apps:practice'));
      const delivered = JSON.parse(calls[1].init.body);
      assert.equal(delivered.content.membership, true);
      assert.deepEqual(r.features, { chat: false, systemMessaging: true });
    });

    it('[MB35] any offer asking a stream the plugin manages on the accepter\'s account fails the accept with cmc-offer-stream-not-offerable, minting nothing', async () => {
      const mall = fakeMall();
      const offer = { ...MEMBERSHIP_OFFER, content: { ...MEMBERSHIP_OFFER.content, request: { ...MEMBERSHIP_OFFER.content.request, membership: false, permissions: [{ streamId: 'fertility', level: 'read' }, { streamId: ':_cmc:inbox', level: 'read' }] } } };
      const { fetch } = fakeFetch([{ status: 200, body: { events: [offer] } }]);
      const r = await handleAccept({
        userId: 'group',
        triggerEvent: { id: 'evt-acc-p', type: 'consent/accept-cmc', streamIds: [':_cmc:apps:practice'], content: { capabilityUrl: 'https://Tok@member.example.com/' } },
        selfIdentity: GROUP_ID,
        deps: { mall, fetch },
      });
      assert.equal(r.ok, false);
      assert.equal(r.reason, CmcErrorIds.OFFER_STREAM_NOT_OFFERABLE);
      assert.ok(r.detail.errors[0].includes(':_cmc:inbox'));
      assert.equal(mall.calls.accessesCreated.length, 0);
    });

    it('[MB31] an offer that asks more than a membership may hold fails the accept with cmc-membership-permissions-invalid, minting nothing', async () => {
      const mall = fakeMall();
      const offer = { ...MEMBERSHIP_OFFER, content: { ...MEMBERSHIP_OFFER.content, request: { ...MEMBERSHIP_OFFER.content.request, accessType: 'app' } } };
      const { fetch } = fakeFetch([{ status: 200, body: { events: [offer] } }]);
      const r = await handleAccept({
        userId: 'group',
        triggerEvent: { id: 'evt-acc-m', type: 'consent/accept-cmc', streamIds: [':_cmc:apps:practice'], content: { capabilityUrl: 'https://Tok@member.example.com/' } },
        selfIdentity: GROUP_ID,
        deps: { mall, fetch },
      });
      assert.equal(r.ok, false);
      assert.equal(r.reason, CmcErrorIds.MEMBERSHIP_PERMISSIONS_INVALID);
      assert.equal(mall.calls.accessesCreated.length, 0);
    });

    it('[MB32] a delegate administrator\'s accept records approvedBy with the delegate identity and the relationship', async () => {
      const mall = fakeMall();
      mall.accesses.getOne = async (u, { id }) => (id === 'pat-1' ? { id: 'pat-1', clientData: { delegation: { kind: 'delegate-pat', relId: 'rel-1', delegate: { username: 'carer', hostSlug: 'x' } } } } : null);
      const { fetch } = fakeFetch([{ status: 200, body: { events: [MEMBERSHIP_OFFER] } }, { status: 201, body: {} }]);
      const lineage = { kind: 'delegated-child', relId: 'rel-1', delegate: { username: 'carer', hostSlug: 'x', secret: 'never' }, viaAccessId: 'pat-1' };
      const r = await handleAccept({
        userId: 'group',
        triggerEvent: { id: 'evt-acc-m', type: 'consent/accept-cmc', streamIds: [':_cmc:apps:practice'], content: { capabilityUrl: 'https://Tok@member.example.com/', approvedBy: { relId: 'rel-1' } } },
        selfIdentity: GROUP_ID,
        deps: {
          mall,
          fetch,
          triggerAccess: { canCreateAccess: async () => true },
          lineageOf: (access) => (access?.id === 'pat-1' ? { kind: 'delegate-pat', relId: 'rel-1', delegate: lineage.delegate, viaAccessId: 'pat-1' } : lineage),
          relationshipExists: async () => true,
        },
      });
      assert.equal(r.ok, true, JSON.stringify(r));
      const created = mall.calls.accessesCreated[0];
      assert.deepEqual(created.clientData.cmc.membership.approvedBy, { delegate: { username: 'carer', hostSlug: 'x' }, relId: 'rel-1' });
      assert.equal(created.clientData.delegation.relId, 'rel-1');
    });

    it('[MB34] a delegate administrator cannot approve their own membership', async () => {
      const mall = fakeMall();
      mall.accesses.getOne = async (u, { id }) => (id === 'pat-1' ? { id: 'pat-1', clientData: { delegation: { kind: 'delegate-pat', relId: 'rel-1', delegate: { username: 'carer', hostSlug: 'member-example-com' } } } } : null);
      const { fetch } = fakeFetch([{ status: 200, body: { events: [{ ...MEMBERSHIP_OFFER, content: { ...MEMBERSHIP_OFFER.content, requesterUsername: 'carer', requesterHost: 'member.example.com' } }] } }]);
      const lineage = { kind: 'delegated-child', relId: 'rel-1', delegate: { username: 'carer', hostSlug: 'member-example-com' }, viaAccessId: 'pat-1' };
      const r = await handleAccept({
        userId: 'group',
        triggerEvent: { id: 'evt-acc-m', type: 'consent/accept-cmc', streamIds: [':_cmc:apps:practice'], content: { capabilityUrl: 'https://Tok@member.example.com/', approvedBy: { relId: 'rel-1' } } },
        selfIdentity: GROUP_ID,
        deps: {
          mall,
          fetch,
          relationshipExists: async () => true,
          triggerAccess: { canCreateAccess: async () => true },
          lineageOf: (access) => (access?.id === 'pat-1' ? { kind: 'delegate-pat', relId: 'rel-1', delegate: lineage.delegate, viaAccessId: 'pat-1' } : lineage),
        },
      });
      assert.equal(r.ok, false);
      assert.equal(r.reason, CmcErrorIds.MEMBERSHIP_PERMISSIONS_INVALID);
      assert.equal(mall.calls.accessesCreated.length, 0);
    });

    it('[MB33] the member side marks its inbox mirror from its own copy of the offer, never from the delivered accept alone when a copy exists', async () => {
      async function mirrorOf (requestEvent, delivered) {
        const created = [];
        const mall = {
          accesses: { async create (u, p) { return { id: 'bc', apiEndpoint: 'https://b@m/', ...p }; }, async get () { return []; } },
          events: {
            async get () { return requestEvent ? [requestEvent] : []; },
            async getOne (u, id) { return requestEvent?.id === id ? requestEvent : null; },
            async create (u, p) { created.push(p); return { id: 'm' }; },
            async updateWithMerge () { return null; },
          },
          streams: { async create (u, p) { return { id: p.id }; } },
        };
        await handleIncomingAccept({
          userId: 'member',
          acceptEvent: { id: 'acc', type: 'consent/accept-cmc', streamIds: [':_cmc:_internal:responses:cap-m'], content: { grantedAccess: { apiEndpoint: 'https://g@group.example.com/' }, from: GROUP_ID, originalEventId: 'req', requesterOriginStreamId: TEAM_A, ...delivered } },
          selfIdentity: MEMBER_ID,
          deps: { mall },
        });
        return created.find((e) => e.streamIds?.includes(':_cmc:inbox'))?.content;
      }
      const membershipRequest = { id: 'req', type: 'consent/request-cmc', streamIds: [':_cmc:_internal:offer:cap-m'], content: { request: MEMBERSHIP_OFFER_REQUEST } };
      assert.equal((await mirrorOf(membershipRequest, {})).membership, true);
      const plainRequest = { ...membershipRequest, content: { request: { ...MEMBERSHIP_OFFER_REQUEST, membership: false } } };
      assert.equal((await mirrorOf(plainRequest, { membership: true })).membership, undefined, 'the delivered claim does not override our copy');
      assert.equal((await mirrorOf(null, { membership: true })).membership, true, 'without a copy the delivered value decides');
    });
  });

  describe('[CMCMB-END] a membership ends like a relationship', () => {
    function revokeMall (accesses) {
      const calls = { deleted: [] };
      return {
        calls,
        accesses: { async get () { return accesses.filter((a) => !calls.deleted.includes(a.id)); }, async delete (u, p) { calls.deleted.push(p.id); } },
        events: { async updateWithMerge () { return null; }, async getOne () { return null; }, async update () {} },
      };
    }

    it('[MB40] the group revokes a membership by access id: the membership access is deleted and the member told through its back-channel', async () => {
      const mall = revokeMall([MEMBERSHIP_ACCESS]);
      const { fetch, calls } = fakeFetch({ status: 201, body: {} });
      const r = await handleRevoke({
        userId: 'group',
        triggerEvent: { id: 'rv', type: 'consent/revoke-cmc', streamIds: [TEAM_A], content: { accessId: 'acc-membership' } },
        selfIdentity: GROUP_ID,
        deps: { mall, fetch },
      });
      assert.equal(r.ok, true, JSON.stringify(r));
      assert.deepEqual(mall.calls.deleted, ['acc-membership']);
      assert.equal(r.peerNotified, true);
      assert.ok(calls[0].url.startsWith('https://member.example.com/'));
    });

    it('[MB41] a member leaving delivers its revoke through the membership access: the incoming handler deletes that access', async () => {
      const mall = revokeMall([MEMBERSHIP_ACCESS]);
      const r = await handleIncomingRevoke({
        userId: 'group',
        event: { id: 'in', type: 'consent/revoke-cmc', streamIds: [':_cmc:inbox'], createdBy: 'acc-membership', content: { accessId: 'their-bc' } },
        deps: { mall },
      });
      assert.equal(r.ok, true, JSON.stringify(r));
      assert.deepEqual(r.deletedAccessIds, ['acc-membership']);
    });

    it('[MB42] a raw delete of a membership access notifies the member like any relationship access', async () => {
      const { fetch, calls } = fakeFetch({ status: 201, body: {} });
      const hook = createAccessesDeletePostHook({ fetch });
      const [res] = await hook('group', [MEMBERSHIP_ACCESS]);
      assert.deepEqual({ attempted: res.attempted, peerNotified: res.peerNotified }, { attempted: true, peerNotified: true });
      const body = JSON.parse(calls[0].init.body);
      assert.equal(body.type, 'consent/revoke-cmc');
      assert.equal(body.content.accessId, 'acc-membership');
    });

    it('[MB43] an alert to a member is delivered through the membership access; a chat toward a member is refused with cmc-member-channel-not-supported', async () => {
      const slug = MEMBER_ID.username + '--member-example-com';
      const { fetch } = fakeFetch({ status: 201, body: {} });
      const alert = await handleSystemAlert({
        userId: 'group',
        triggerEvent: { id: 'al', type: C.ET_SYSTEM_ALERT, streamIds: [TEAM_A + ':collectors:' + slug], content: { level: 'info', title: { en: 't' }, body: { en: 'b' } } },
        selfIdentity: GROUP_ID,
        deps: { mall: { accesses: { async get () { return [MEMBERSHIP_ACCESS]; } } }, fetch },
      });
      assert.equal(alert.ok, true, JSON.stringify(alert));
      const chat = await handleChat({
        userId: 'group',
        triggerEvent: { id: 'ch', type: C.ET_CHAT, streamIds: [TEAM_A + ':chats:' + slug], content: { content: 'hi' } },
        selfIdentity: GROUP_ID,
        deps: { mall: { accesses: { async get () { return [MEMBERSHIP_ACCESS]; } } }, fetch },
      });
      assert.equal(chat.ok, false);
      assert.equal(chat.reason, CmcErrorIds.MEMBER_CHANNEL_NOT_SUPPORTED);
    });
  });
});
