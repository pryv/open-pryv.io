/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);

/**
 * [OCMP] Re-authorization of OAuth registry clients, end to end: the consent
 * screen composes the user's current grant with the request (signed-in
 * `/oauth2/authorize/offer`), `/accept` binds it with `shownDigest` and then
 * applies exactly what was ticked; without it the consent is joined into the
 * grant. A grant that changes re-cuts its live sessions at once. Also: the
 * acknowledged change of subject mode, feature forbids, and the owner as the
 * only principal that consents.
 */

/* global initTests, initCore, coreRequest, getNewFixture, cuid */

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const oauth2 = require('oauth2');
const storage = require('oauth2/src/storage.ts');
const accessIndex = require('platform/src/accessIndex.ts');

const REDIRECT_URI = 'https://app.consent.test/redirect';
const CONSENT_URL = 'https://auth.test/oauth2-authorize';
const AUD = 'https://resource.test/base';
const DEFAULT_FORBIDS = [{ feature: 'webhooks', setting: 'forbidden' }, { feature: 'secretSharing', setting: 'forbidden' }];

// Toy grammar: `read/<s>`, `write/<s>`, `add/<s>` give one stream a level;
// `must/<s>` reads it, mandatory; `ctx/choice` lets the user pick entries;
// `ctx/locked` forbids secret sharing and webhooks.
const LEVEL_OF = { read: 'read', write: 'contribute', add: 'create-only', must: 'read' };
let tokenHookOverride = null;
const toyExtension = {
  apiVersion: 1,
  name: 'toy-consent',
  scopeGrammar: {
    parse (scopeString) {
      const tokens = [...new Set(scopeString.split(/\s+/).filter((t) => t !== ''))];
      const permissions = [];
      const entryLabels = {};
      for (const t of tokens) {
        if (t.startsWith('ctx/')) continue;
        const slash = t.indexOf('/');
        const level = LEVEL_OF[t.slice(0, slash)];
        if (slash <= 0 || level == null) return { ok: false, description: 'unknown token ' + t };
        const streamId = t.slice(slash + 1);
        permissions.push({ streamId, level, ...(t.startsWith('must/') ? { mandatory: true } : {}) });
        entryLabels['s|' + streamId + '|' + level] = { en: 'Stream ' + streamId };
      }
      if (tokens.includes('ctx/locked')) {
        permissions.push({ feature: 'secretSharing', setting: 'forbidden', mandatory: true },
          { feature: 'webhooks', setting: 'forbidden', mandatory: true });
      }
      return { ok: true, tokens, offer: { permissions, allowUserChoice: tokens.includes('ctx/choice'), entryLabels } };
    },
    echo ({ permissions, requestedTokens }) {
      const has = (s, levels) => permissions.some((p) => p.streamId === s && levels.includes(p.level));
      return requestedTokens.filter((t) => {
        if (t.startsWith('ctx/')) return true;
        const [kind, s] = t.split('/');
        if (kind === 'read' || kind === 'must') return has(s, ['read', 'contribute']);
        if (kind === 'write') return has(s, ['contribute']);
        return has(s, ['create-only', 'contribute']);
      });
    },
  },
  tokenResponse: (ctx) => (tokenHookOverride != null ? tokenHookOverride(ctx) : {}),
};

const SCOPE = ['read/a', 'read/b', 'read/c', 'write/a', 'write/b', 'add/a', 'must/a', 'read/zz', 'ctx/choice', 'ctx/locked'];

function baseOf (accessId) {
  return String(accessId).split(':')[0];
}

function streamsOf (permissions) {
  return permissions.filter((p) => p.streamId != null).map((p) => p.streamId + ':' + p.level).sort();
}

function pkce () {
  const verifier = crypto.randomBytes(32).toString('base64url');
  return { verifier, challenge: crypto.createHash('sha256').update(verifier).digest('base64url') };
}

describe('[OCMP] OAuth registry clients: composed re-consent, subject change, forbids', function () {
  this.timeout(60000);

  let fixtures, restoreConfig, platformDB, clientId, openClientId;

  before(async function () {
    await initTests();
    await initCore();
    fixtures = getNewFixture();
    restoreConfig = require('test-helpers').injectTestConfigSnapshot({ oauth: { consentUrl: CONSENT_URL } });
    oauth2.extension.setExtension(toyExtension);
    platformDB = require('storages').platformDB;
    const row = {
      kind: 'registry',
      redirectUris: [REDIRECT_URI],
      grantTypes: ['authorization_code', 'refresh_token'],
      tokenEndpointAuthMethod: 'none',
      allowedAudiences: [AUD],
      subjectType: 'public',
      scope: SCOPE,
    };
    clientId = 'Cmp.' + cuid().slice(-10);
    await oauth2.persistClient(platformDB, { ...row, clientId });
    openClientId = 'Opn.' + cuid().slice(-10);
    await oauth2.persistClient(platformDB, { ...row, clientId: openClientId, allowFeatures: ['webhooks', 'secretSharing'] });
  });

  after(async function () {
    oauth2.extension._resetForTests();
    if (restoreConfig != null) restoreConfig();
    for (const id of [clientId, openClientId]) {
      try { await storage.deleteClient(platformDB, id); } catch (_) { /* best-effort */ }
    }
    if (fixtures != null) await fixtures.clean();
  });

  afterEach(() => { tokenHookOverride = null; });

  /** A fresh user with streams a, b, c and one event in each. */
  async function newUser () {
    const username = cuid();
    const token = cuid();
    const user = await fixtures.user(username);
    await user.access({ token, type: 'personal' });
    await user.session(token);
    for (const id of ['a', 'b', 'c']) {
      const s = await coreRequest.post('/' + username + '/streams').set('Authorization', token).send({ id, name: id });
      assert.equal(s.status, 201, JSON.stringify(s.body));
      const e = await coreRequest.post('/' + username + '/events').set('Authorization', token)
        .send({ streamIds: [id], type: 'note/txt', content: id });
      assert.equal(e.status, 201, JSON.stringify(e.body));
    }
    return { username, token };
  }

  async function authorize (scope, cid = clientId) {
    const { verifier, challenge } = pkce();
    const res = await coreRequest.get('/oauth2/authorize').query({
      client_id: cid,
      redirect_uri: REDIRECT_URI,
      response_type: 'code',
      state: 'csrf-' + cuid(),
      code_challenge: challenge,
      code_challenge_method: 'S256',
      scope,
      aud: AUD,
    });
    assert.equal(res.status, 302, res.text);
    const loc = res.headers.location;
    assert.ok(loc.startsWith(CONSENT_URL + '?state='), 'unexpected redirect: ' + loc);
    return { verifier, state: new URL(loc).searchParams.get('state'), cid };
  }

  function offer (state, who) {
    return coreRequest.post('/oauth2/authorize/offer')
      .send({ state, ...(who != null ? { username: who.username, userToken: who.token } : {}) });
  }

  function accept (state, who, grantedPermissions, extra = {}) {
    return coreRequest.post('/oauth2/authorize/accept')
      .send({ state, username: who.username, userToken: who.token, grantedPermissions, ...extra });
  }

  function exchange (flow, acceptRes) {
    const code = new URL(acceptRes.body.redirectTo).searchParams.get('code');
    return coreRequest.post('/oauth2/token').type('form').send({
      grant_type: 'authorization_code', code, code_verifier: flow.verifier, client_id: flow.cid, redirect_uri: REDIRECT_URI,
    });
  }

  function refresh (refreshToken, cid = clientId) {
    return coreRequest.post('/oauth2/token').type('form').send({ grant_type: 'refresh_token', refresh_token: refreshToken, client_id: cid });
  }

  /**
   * A whole consent. `composed`: the consent UI signs in at /offer and posts
   * `shownDigest`; `keep` filters the entries the user leaves ticked.
   */
  async function consent (who, scope, { composed = true, keep = null, cid = clientId, ack } = {}) {
    const flow = await authorize(scope, cid);
    const o = await offer(flow.state, composed ? who : null);
    assert.equal(o.status, 200, JSON.stringify(o.body));
    const shown = o.body.offer.permissions;
    const granted = (keep == null ? shown : shown.filter(keep)).map(({ currentlyGranted: _c, ...p }) => p);
    const a = await accept(flow.state, who, granted, {
      ...(composed ? { shownDigest: o.body.shownDigest } : {}),
      ...(ack != null ? { acknowledgeSubjectChange: ack } : {}),
    });
    return { flow, offer: o.body, accept: a };
  }

  async function consentAndToken (who, scope, opts) {
    const c = await consent(who, scope, opts);
    assert.equal(c.accept.status, 200, JSON.stringify(c.accept.body));
    const t = await exchange(c.flow, c.accept);
    assert.equal(t.status, 200, JSON.stringify(t.body));
    return t.body;
  }

  async function accesses (who) {
    const res = await coreRequest.get('/' + who.username + '/accesses').set('Authorization', who.token);
    assert.equal(res.status, 200, JSON.stringify(res.body));
    return res.body.accesses;
  }

  async function grantOf (who, cid = clientId) {
    const list = (await accesses(who)).filter((a) => a.name === 'oauth-grant:' + cid);
    assert.ok(list.length <= 1, 'one grant per client');
    return list[0] ?? null;
  }

  function readStream (who, token, streamId) {
    return coreRequest.get('/' + who.username + '/events').query({ streams: JSON.stringify([streamId]) }).set('Authorization', token);
  }

  function ownerUpdate (who, grant, update) {
    return coreRequest.put('/' + who.username + '/accesses/' + encodeURIComponent(grant.id)).set('Authorization', who.token).send(update);
  }

  it('[OCMP1] the signed-in offer composes the grant with the request; signed out or with another token, the request only', async () => {
    const who = await newUser();
    await consentAndToken(who, 'read/a write/b');
    assert.deepEqual(streamsOf((await grantOf(who)).permissions), ['a:read', 'b:contribute']);

    const flow = await authorize('read/b read/c');
    const composed = await offer(flow.state, who);
    assert.equal(composed.status, 200, JSON.stringify(composed.body));
    assert.equal(composed.body.authenticated, true);
    assert.deepEqual(composed.body.offer.permissions, [
      { streamId: 'a', level: 'read', currentlyGranted: true },
      { streamId: 'b', level: 'contribute', currentlyGranted: true },
      { streamId: 'c', level: 'read' },
    ]);
    assert.deepEqual(composed.body.currentGrant, { subjectMode: 'account' });
    assert.equal(composed.body.subjectChange, null);
    assert.equal(typeof composed.body.shownDigest, 'string');
    // The display members of the offer are kept.
    assert.equal(composed.body.offer.randomAlias, false);
    assert.deepEqual(composed.body.offer.entryLabels['s|c|read'], { en: 'Stream c' });

    const plain = await offer(flow.state);
    assert.equal(plain.status, 200);
    assert.equal(plain.body.authenticated, undefined);
    assert.equal(plain.body.shownDigest, undefined);
    assert.deepEqual(plain.body.offer.permissions, [{ streamId: 'b', level: 'read' }, { streamId: 'c', level: 'read' }]);

    const bad = await offer(flow.state, { username: who.username, token: 'not-a-token' });
    assert.equal(bad.status, 200);
    assert.equal(bad.body.authenticated, false);
    assert.equal(bad.body.shownDigest, undefined);
    assert.deepEqual(bad.body.offer, plain.body.offer);

    // An app token of the user is not the owner signing in.
    const app = await coreRequest.post('/' + who.username + '/accesses').set('Authorization', who.token)
      .send({ type: 'app', name: 'other-app', permissions: [{ streamId: 'a', level: 'read' }] });
    assert.equal(app.status, 201, JSON.stringify(app.body));
    const byApp = await offer(flow.state, { username: who.username, token: app.body.access.token });
    assert.equal(byApp.body.authenticated, false);
  });

  it('[OCMP2] read held, create-only requested: invalid_scope at /offer and at /accept, grant unchanged', async () => {
    const who = await newUser();
    await consentAndToken(who, 'read/a');
    const before = await grantOf(who);
    const flow = await authorize('add/a');
    const o = await offer(flow.state, who);
    assert.equal(o.status, 400, JSON.stringify(o.body));
    assert.equal(o.body.error, 'invalid_scope');
    assert.match(o.body.error_description, /conflicting permission level/);
    const a = await accept(flow.state, who, [{ streamId: 'a', level: 'create-only' }]);
    assert.equal(a.status, 400, JSON.stringify(a.body));
    assert.equal(a.body.error, 'invalid_scope');
    assert.equal((await grantOf(who)).id, before.id);
  });

  it('[OCMP3] untick a granted stream: the grant narrows exactly, another chain\'s live session is re-cut at once, its refresh narrows', async () => {
    const who = await newUser();
    const first = await consentAndToken(who, 'offline_access read/a read/b ctx/choice');
    assert.equal((await readStream(who, first.access_token, 'b')).status, 200);

    const c = await consent(who, 'read/a ctx/choice', { keep: (p) => p.streamId === 'a' });
    assert.deepEqual(c.offer.offer.permissions.map((p) => p.streamId + ':' + (p.currentlyGranted === true)), ['a:true', 'b:true']);
    assert.equal(c.accept.status, 200, JSON.stringify(c.accept.body));
    const grant = await grantOf(who);
    assert.deepEqual(grant.permissions, [{ streamId: 'a', level: 'read' }, ...DEFAULT_FORBIDS]);

    // The other chain's live session lost `b` without waiting for a refresh.
    assert.equal((await readStream(who, first.access_token, 'b')).status, 403);
    assert.equal((await readStream(who, first.access_token, 'a')).status, 200);
    const r = await refresh(first.refresh_token);
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.deepEqual(r.body.scope.split(' ').sort(), ['ctx/choice', 'offline_access', 'read/a']);
    assert.equal((await readStream(who, r.body.access_token, 'b')).status, 403);
  });

  it('[OCMP4] untick everything but the mandatory entries; a mandatory entry cannot be unticked', async () => {
    const who = await newUser();
    const refused = await consent(who, 'must/a read/b ctx/choice', { keep: (p) => p.streamId === 'b' });
    assert.equal(refused.accept.status, 400, JSON.stringify(refused.accept.body));
    assert.match(refused.accept.body.error_description, /mandatory/);
    const ok = await consent(who, 'must/a read/b ctx/choice', { keep: (p) => p.mandatory === true });
    assert.equal(ok.accept.status, 200, JSON.stringify(ok.accept.body));
    assert.deepEqual((await grantOf(who)).permissions, [{ streamId: 'a', level: 'read' }, ...DEFAULT_FORBIDS]);
  });

  it('[OCMP5] all or nothing with a current grant: the whole composition, i.e. the union', async () => {
    const who = await newUser();
    await consentAndToken(who, 'read/a');
    const partial = await consent(who, 'read/b', { keep: (p) => p.streamId === 'b' });
    assert.equal(partial.accept.status, 400, JSON.stringify(partial.accept.body));
    assert.match(partial.accept.body.error_description, /all-or-nothing/);
    const all = await consent(who, 'read/b');
    assert.equal(all.accept.status, 200, JSON.stringify(all.accept.body));
    assert.deepEqual(streamsOf((await grantOf(who)).permissions), ['a:read', 'b:read']);
  });

  it('[OCMP6] a consent UI posting no shownDigest: joined into the grant, never narrows', async () => {
    const who = await newUser();
    await consentAndToken(who, 'read/a read/b');
    await consentAndToken(who, 'read/a', { composed: false });
    assert.deepEqual(streamsOf((await grantOf(who)).permissions), ['a:read', 'b:read']);
    await consentAndToken(who, 'read/a read/c ctx/choice', { composed: false, keep: (p) => p.streamId === 'c' });
    assert.deepEqual(streamsOf((await grantOf(who)).permissions), ['a:read', 'b:read', 'c:read']);
  });

  it('[OCMP7] a stale shownDigest: 400 consent-out-of-date, nothing written', async () => {
    const who = await newUser();
    await consentAndToken(who, 'read/a');
    const flow = await authorize('read/b');
    const o = await offer(flow.state, who);
    const granted = o.body.offer.permissions.map(({ currentlyGranted: _c, ...p }) => p);
    const forged = await accept(flow.state, who, granted, { shownDigest: 'not-the-digest' });
    assert.equal(forged.status, 400, JSON.stringify(forged.body));
    assert.deepEqual(forged.body, {
      error: 'invalid_request',
      error_description: 'the consent screen is out of date, restart the authorization flow',
      reason: 'consent-out-of-date',
    });
    // The grant changed since the screen was shown (the owner edited it).
    const grant = await grantOf(who);
    assert.equal((await ownerUpdate(who, grant, { permissions: [{ streamId: 'a', level: 'read' }, { streamId: 'c', level: 'read' }] })).status, 200);
    const stale = await accept(flow.state, who, granted, { shownDigest: o.body.shownDigest });
    assert.equal(stale.status, 400, JSON.stringify(stale.body));
    assert.equal(stale.body.reason, 'consent-out-of-date');
    assert.deepEqual(streamsOf((await grantOf(who)).permissions), ['a:read', 'c:read']);
  });

  it('[OCMP8] the grant\'s forbids stay across a replace, shown locked; the default forbids are re-applied, never shown', async () => {
    const who = await newUser();
    await consentAndToken(who, 'read/a ctx/choice');
    const grant = await grantOf(who);
    // The owner drops the defaults and adds a restriction of their own.
    const upd = await ownerUpdate(who, grant, { permissions: [{ streamId: 'a', level: 'read' }, { feature: 'selfRevoke', setting: 'forbidden' }] });
    assert.equal(upd.status, 200, JSON.stringify(upd.body));
    const c = await consent(who, 'read/a read/b ctx/choice', { keep: (p) => p.streamId !== 'a' });
    assert.deepEqual(c.offer.offer.permissions.filter((p) => p.feature != null),
      [{ feature: 'selfRevoke', setting: 'forbidden', mandatory: true, currentlyGranted: true }]);
    assert.equal(c.accept.status, 200, JSON.stringify(c.accept.body));
    const after = await grantOf(who);
    assert.deepEqual(after.permissions, [
      { streamId: 'b', level: 'read' },
      { feature: 'selfRevoke', setting: 'forbidden' },
      ...DEFAULT_FORBIDS,
    ]);
  });

  it('[OCMP9] the owner narrows the grant: its sessions are re-cut at once; one left with no reach is deleted, its chain dead', async () => {
    const who = await newUser();
    const s1 = await consentAndToken(who, 'offline_access read/a read/b');
    const s2 = await consentAndToken(who, 'offline_access read/b', { composed: false });
    const grant = await grantOf(who);
    const upd = await ownerUpdate(who, grant, { permissions: [{ streamId: 'a', level: 'read' }] });
    assert.equal(upd.status, 200, JSON.stringify(upd.body));
    assert.equal((await readStream(who, s1.access_token, 'b')).status, 403);
    assert.equal((await readStream(who, s1.access_token, 'a')).status, 200);
    // No reach left: the session is gone.
    assert.equal((await readStream(who, s2.access_token, 'b')).status, 403);
    const sessions = (await accesses(who)).filter((a) => a.name === 'oauth:' + clientId);
    assert.equal(sessions.length, 1, 'the session with no reach is deleted');
    assert.deepEqual(streamsOf(sessions[0].permissions), ['a:read']);
    const dead = await refresh(s2.refresh_token);
    assert.equal(dead.status, 400, JSON.stringify(dead.body));
    assert.equal(dead.body.error, 'invalid_grant');
    const alive = await refresh(s1.refresh_token);
    assert.equal(alive.status, 200, JSON.stringify(alive.body));
    assert.deepEqual(alive.body.scope.split(' ').sort(), ['offline_access', 'read/a']);
  });

  it('[OCMP10] write narrowed to read by the owner: the refreshed scope echoes read, not write', async () => {
    const who = await newUser();
    const t = await consentAndToken(who, 'offline_access write/a');
    assert.deepEqual(t.scope.split(' ').sort(), ['offline_access', 'write/a']);
    const grant = await grantOf(who);
    assert.equal((await ownerUpdate(who, grant, { permissions: [{ streamId: 'a', level: 'read' }] })).status, 200);
    const r = await refresh(t.refresh_token);
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.deepEqual(r.body.scope.split(' ').sort(), ['offline_access']);
    const write = await coreRequest.post('/' + who.username + '/events').set('Authorization', r.body.access_token)
      .send({ streamIds: ['a'], type: 'note/txt', content: 'x' });
    assert.equal(write.status, 403, JSON.stringify(write.body));
  });

  it('[OCMP10b] read narrowed to nothing on one of two streams: the echo keeps the other', async () => {
    const who = await newUser();
    const t = await consentAndToken(who, 'offline_access write/a read/b');
    const grant = await grantOf(who);
    assert.equal((await ownerUpdate(who, grant, { permissions: [{ streamId: 'a', level: 'read' }, { streamId: 'b', level: 'read' }] })).status, 200);
    const r = await refresh(t.refresh_token);
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.deepEqual(r.body.scope.split(' ').sort(), ['offline_access', 'read/b']);
  });

  it('[OCMP11] a change of subject mode needs the acknowledgement; then the old grant goes and a new one is made', async () => {
    const who = await newUser();
    // A grant the app sees through a pseudonym (made here through the API:
    // this core does not issue pseudonymous grants yet).
    const seeded = await coreRequest.post('/' + who.username + '/accesses').set('Authorization', who.token).send({
      type: 'app', name: 'oauth-grant:' + clientId, deviceName: 'oauth-grant', permissions: [{ streamId: 'a', level: 'read' }], randomAlias: true,
    });
    assert.equal(seeded.status, 201, JSON.stringify(seeded.body));
    assert.equal(typeof seeded.body.access.alias, 'string');
    // An updated grant: its wire id carries a version serial.
    const bumped = await ownerUpdate(who, seeded.body.access, { permissions: [{ streamId: 'a', level: 'read' }, { streamId: 'b', level: 'read' }] });
    assert.equal(bumped.status, 200, JSON.stringify(bumped.body));
    assert.notEqual(bumped.body.access.id, seeded.body.access.id);

    const flow = await authorize('read/a');
    const o = await offer(flow.state, who);
    assert.equal(o.status, 200, JSON.stringify(o.body));
    assert.deepEqual(o.body.currentGrant, { subjectMode: 'pseudonym' });
    assert.deepEqual(o.body.subjectChange, { from: 'pseudonym', to: 'account' });
    const granted = o.body.offer.permissions.map(({ currentlyGranted: _c, ...p }) => p);

    const unacknowledged = await accept(flow.state, who, granted, { shownDigest: o.body.shownDigest });
    assert.equal(unacknowledged.status, 400, JSON.stringify(unacknowledged.body));
    assert.deepEqual(unacknowledged.body, {
      error: 'invalid_request',
      error_description: 'the change of identity mode must be acknowledged',
      reason: 'subject-change-unacknowledged',
    });
    // A consent UI that did not compose posts the request as it showed it.
    const noScreen = await accept(flow.state, who, [{ streamId: 'a', level: 'read' }], { acknowledgeSubjectChange: true });
    assert.equal(noScreen.status, 400, JSON.stringify(noScreen.body));
    assert.equal(noScreen.body.reason, 'subject-change-unacknowledged');
    assert.equal((await grantOf(who)).id, bumped.body.access.id, 'grant untouched');

    const auditSingleton = require('audit').default;
    const original = auditSingleton.eventForUser;
    const granteds = [];
    auditSingleton.eventForUser = async function (userId, row, event) {
      if (event === 'oauth.consent.granted') granteds.push(row.content.record);
      return await original.apply(this, arguments);
    };
    let ok;
    try {
      ok = await accept(flow.state, who, granted, { shownDigest: o.body.shownDigest, acknowledgeSubjectChange: true });
    } finally {
      auditSingleton.eventForUser = original;
    }
    assert.equal(ok.status, 200, JSON.stringify(ok.body));
    const now = await grantOf(who);
    assert.notEqual(baseOf(now.id), baseOf(seeded.body.access.id));
    assert.equal(now.alias ?? null, null);
    assert.equal((await accesses(who)).some((a) => baseOf(a.id) === baseOf(seeded.body.access.id)), false);
    assert.ok(granteds.some((r) => r.clientId === clientId &&
      JSON.stringify(r.subjectChange) === JSON.stringify({ from: 'pseudonym', to: 'account' })), JSON.stringify(granteds));
  });

  it('[OCMP12] grammar forbids pass and reach the grant and the session; the defaults go unless allowed on the client row', async () => {
    const who = await newUser();
    const c = await consent(who, 'read/a ctx/locked');
    assert.deepEqual(c.offer.offer.permissions.filter((p) => p.feature != null), [
      { feature: 'secretSharing', setting: 'forbidden', mandatory: true },
      { feature: 'webhooks', setting: 'forbidden', mandatory: true },
    ]);
    assert.equal(c.accept.status, 200, JSON.stringify(c.accept.body));
    const t = await exchange(c.flow, c.accept);
    assert.equal(t.status, 200, JSON.stringify(t.body));
    const grant = await grantOf(who);
    assert.deepEqual(streamsOf(grant.permissions), ['a:read']);
    assert.deepEqual(grant.permissions.filter((p) => p.feature != null).map((p) => p.feature + ':' + p.setting).sort(),
      ['secretSharing:forbidden', 'webhooks:forbidden']);
    const session = (await accesses(who)).find((a) => a.name === 'oauth:' + clientId);
    assert.deepEqual(session.permissions.filter((p) => p.feature != null).map((p) => p.feature + ':' + p.setting).sort(),
      ['secretSharing:forbidden', 'selfRevoke:allowed', 'webhooks:forbidden']);
    const hook = await coreRequest.post('/' + who.username + '/webhooks').set('Authorization', t.body.access_token)
      .send({ url: 'https://hooks.test/notify' });
    assert.equal(hook.status, 403, JSON.stringify(hook.body));
    // Unticking a forbid is refused, even with user choice.
    const dropped = await consent(who, 'read/a ctx/locked ctx/choice', { keep: (p) => p.feature == null });
    assert.equal(dropped.accept.status, 400, JSON.stringify(dropped.accept.body));
    assert.match(dropped.accept.body.error_description, /mandatory/);
    // A client allowed both features: its grants carry no default forbid.
    await consentAndToken(who, 'read/a', { cid: openClientId });
    assert.deepEqual((await grantOf(who, openClientId)).permissions, [{ streamId: 'a', level: 'read' }]);
  });

  it('[OCMP13] only the account owner consents: an app token of the user is refused, nothing minted', async () => {
    const who = await newUser();
    const app = await coreRequest.post('/' + who.username + '/accesses').set('Authorization', who.token)
      .send({ type: 'app', name: 'some-app', permissions: [{ streamId: 'a', level: 'read' }] });
    assert.equal(app.status, 201, JSON.stringify(app.body));
    const flow = await authorize('read/a');
    const o = await offer(flow.state);
    const res = await accept(flow.state, { username: who.username, token: app.body.access.token }, o.body.offer.permissions);
    assert.equal(res.status, 403, JSON.stringify(res.body));
    assert.equal(res.body.error, 'access_denied');
    assert.equal(await grantOf(who), null);
    assert.equal((await accesses(who)).some((a) => a.name === 'oauth:' + clientId), false);
  });

  it('[OCMP14] display names in the consent body never create a stream', async () => {
    const who = await newUser();
    const flow = await authorize('read/zz');
    await offer(flow.state);
    await accept(flow.state, who, [{ streamId: 'zz', level: 'read', defaultName: 'Created by a consent' }]);
    const streams = await coreRequest.get('/' + who.username + '/streams').set('Authorization', who.token);
    assert.equal(streams.status, 200);
    assert.equal(streams.body.streams.some((s) => s.id === 'zz'), false, JSON.stringify(streams.body.streams.map((s) => s.id)));
  });

  it('[OCMP15] an expired grant does not block the next consent: it is withdrawn and a fresh one made', async () => {
    const who = await newUser();
    await consentAndToken(who, 'read/a');
    const grant = await grantOf(who);
    assert.equal((await ownerUpdate(who, grant, { expireAfter: 0 })).status, 200);
    await new Promise((resolve) => setTimeout(resolve, 1100));
    await consentAndToken(who, 'read/b');
    const fresh = await grantOf(who);
    assert.notEqual(baseOf(fresh.id), baseOf(grant.id));
    assert.deepEqual(streamsOf(fresh.permissions), ['b:read']);
  });

  it('[OCMP16] a session removed after a failed code exchange is tombstoned in the access index', async () => {
    const who = await newUser();
    const c = await consent(who, 'read/a');
    assert.equal(c.accept.status, 200, JSON.stringify(c.accept.body));
    const session = (await accesses(who)).find((a) => a.name === 'oauth:' + clientId);
    assert.ok(await accessIndex.getAccessIndex(platformDB, baseOf(session.id)) != null, 'indexed at the mint');
    tokenHookOverride = () => { throw new Error('extension outage'); };
    const t = await exchange(c.flow, c.accept);
    assert.equal(t.status, 500, JSON.stringify(t.body));
    const row = await accessIndex.getAccessIndex(platformDB, baseOf(session.id));
    assert.ok(row != null && row.deleted != null, JSON.stringify(row));
  });
});
