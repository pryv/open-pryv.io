/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);

/**
 * [OPSE] Pseudonymous OAuth subjects. A registry grant made for a pseudonym
 * (an offer with `randomAlias`, or a `pairwise` client) carries an alias;
 * every session minted under it carries the same alias, is used at that
 * alias only, and the account's username reaches the app in no answer. The
 * alias is released when its last holder is deleted.
 */

/* global initTests, initCore, coreRequest, cuid, withInjectedConfig */

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const oauth2 = require('oauth2');
const storage = require('oauth2/src/storage.ts');

const REDIRECT_URI = 'https://app.pseudo.test/redirect';
const CONSENT_URL = 'https://auth.test/oauth2-authorize';
const AUD = 'https://resource.test/base';

// Toy grammar: `read/<s>` reads one stream; `ctx/user` asks for the subject
// in the token response; `ctx/pseudo` asks for a pseudonym.
const toyExtension = {
  apiVersion: 1,
  name: 'toy-pseudo',
  scopeGrammar: {
    parse (scopeString) {
      const tokens = [...new Set(scopeString.split(/\s+/).filter((t) => t !== ''))];
      const permissions = [];
      for (const t of tokens) {
        if (t === 'ctx/user' || t === 'ctx/pseudo') continue;
        if (!t.startsWith('read/')) return { ok: false, description: 'unknown token ' + t };
        permissions.push({ streamId: t.slice('read/'.length), level: 'read' });
      }
      return { ok: true, tokens, offer: { permissions, randomAlias: tokens.includes('ctx/pseudo') } };
    },
    echo ({ permissions, requestedTokens }) {
      return requestedTokens.filter((t) => t === 'ctx/user' || t === 'ctx/pseudo' ||
        permissions.some((p) => p.level === 'read' && 'read/' + p.streamId === t));
    },
  },
  tokenResponse: (ctx) => (ctx.scopeTokens.includes('ctx/user') ? { user: ctx.subject } : {}),
};

const SCOPE = ['read/health', 'read/diary', 'ctx/user', 'ctx/pseudo'];

function pkce () {
  const verifier = crypto.randomBytes(32).toString('base64url');
  return { verifier, challenge: crypto.createHash('sha256').update(verifier).digest('base64url') };
}

function baseOf (accessId) {
  return String(accessId).split(':')[0];
}

describe('[OPSE] pseudonymous OAuth subjects (alias on grants and sessions, alias-bound addressing)', function () {
  this.timeout(120000);

  let name, userId, who, platformDB, restoreConfig, usersRepository, usersIndex, storageLayer;
  let publicClient, pairwiseClient, otherPairwiseClient;
  const clients = [];
  let attachedEvent;

  async function registry (prefix, extra) {
    const clientId = prefix + '.' + cuid().slice(-10);
    await oauth2.persistClient(platformDB, {
      clientId,
      kind: 'registry',
      redirectUris: [REDIRECT_URI],
      grantTypes: ['authorization_code', 'refresh_token'],
      tokenEndpointAuthMethod: 'none',
      allowedAudiences: [AUD],
      subjectType: 'public',
      scope: SCOPE,
      ...extra,
    });
    clients.push(clientId);
    return clientId;
  }

  before(async function () {
    await initTests();
    await initCore();
    restoreConfig = require('test-helpers').injectTestConfigSnapshot({ oauth: { consentUrl: CONSENT_URL } });
    oauth2.extension.setExtension(toyExtension);
    platformDB = require('storages').platformDB;
    usersRepository = await require('business/src/users/index.ts').getUsersRepository();
    usersIndex = await require('storage').getUsersLocalIndex();
    storageLayer = await require('storage').getStorageLayer();

    // A registered account: its internal id differs from its username.
    name = 'opse' + cuid().toLowerCase().slice(1, 12);
    const reg = await coreRequest.post('/users').send({
      appId: 'pryv-test',
      username: name,
      password: 'opse-passw0rd',
      email: name + '@opse.example.com',
      insurancenumber: String(Math.floor(Math.random() * 90000) + 10000),
      language: 'en',
    });
    assert.equal(reg.status, 201, JSON.stringify(reg.body));
    userId = await usersRepository.getUserIdForUsername(name);
    assert.notEqual(userId, name);
    const login = await coreRequest.post('/' + name + '/auth/login').set('Origin', 'http://test.pryv.local')
      .send({ username: name, password: 'opse-passw0rd', appId: 'pryv-test' });
    assert.equal(login.status, 200, JSON.stringify(login.body));
    who = { username: name, token: login.body.token };
    for (const id of ['health', 'diary']) {
      const s = await coreRequest.post('/' + name + '/streams').set('Authorization', who.token).send({ id, name: id });
      assert.equal(s.status, 201, JSON.stringify(s.body));
    }
    const ev = await coreRequest.post('/' + name + '/events').set('Authorization', who.token)
      .field('event', JSON.stringify({ streamIds: ['health'], type: 'note/txt', content: 'with a file' }))
      .attach('file', Buffer.from('opse attachment'), 'opse.txt');
    assert.equal(ev.status, 201, JSON.stringify(ev.body));
    attachedEvent = ev.body.event;

    publicClient = await registry('Pub');
    pairwiseClient = await registry('Pw', { subjectType: 'pairwise' });
    otherPairwiseClient = await registry('Pw2', { subjectType: 'pairwise' });
  });

  after(async function () {
    oauth2.extension._resetForTests();
    if (restoreConfig != null) restoreConfig();
    for (const id of clients) {
      try { await storage.deleteClient(platformDB, id); } catch (_) { /* best-effort */ }
    }
    try { if (userId != null) await usersRepository.deleteOne(userId, who.username); } catch (_) { /* deleted by a test */ }
  });

  // --- helpers ---

  async function authorize (scope, cid) {
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

  async function offer (flow, signedIn = false) {
    const res = await coreRequest.post('/oauth2/authorize/offer')
      .send({ state: flow.state, ...(signedIn ? { username: who.username, userToken: who.token } : {}) });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    return res.body;
  }

  function accept (flow, grantedPermissions, extra = {}) {
    return coreRequest.post('/oauth2/authorize/accept').send({
      state: flow.state, username: who.username, userToken: who.token, grantedPermissions, ...extra,
    });
  }

  async function exchange (flow, acceptRes) {
    assert.equal(acceptRes.status, 200, JSON.stringify(acceptRes.body));
    const code = new URL(acceptRes.body.redirectTo).searchParams.get('code');
    const res = await coreRequest.post('/oauth2/token').type('form').send({
      grant_type: 'authorization_code', code, code_verifier: flow.verifier, client_id: flow.cid, redirect_uri: REDIRECT_URI,
    });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    return res.body;
  }

  /** authorize, offer (signed out), accept everything shown, exchange. */
  async function runFlow (scope, cid) {
    const flow = await authorize(scope, cid);
    const o = await offer(flow);
    const a = await accept(flow, o.offer.permissions);
    return await exchange(flow, a);
  }

  function refresh (refreshToken, cid) {
    return coreRequest.post('/oauth2/token').type('form').send({ grant_type: 'refresh_token', refresh_token: refreshToken, client_id: cid });
  }

  async function accessList () {
    const res = await coreRequest.get('/' + who.username + '/accesses').set('Authorization', who.token);
    assert.equal(res.status, 200, JSON.stringify(res.body));
    return res.body.accesses;
  }

  async function grantOf (cid) {
    const list = (await accessList()).filter((a) => a.name === 'oauth-grant:' + cid);
    assert.ok(list.length <= 1, 'one grant per client: ' + JSON.stringify(list));
    return list[0] ?? null;
  }

  async function sessionsOf (cid) {
    return (await accessList()).filter((a) => a.name === 'oauth:' + cid);
  }

  async function aliases () {
    return (await usersIndex.getAliasesForId(userId)).sort();
  }

  function ownerDelete (id) {
    return coreRequest.delete('/' + who.username + '/accesses/' + encodeURIComponent(id)).set('Authorization', who.token);
  }

  /** The answer to a token this core does not know, at `path`. */
  async function unknownTokenAnswer (path) {
    const res = await coreRequest.get(path).set('Authorization', 'no-such-token-' + cuid());
    assert.equal(res.status, 403, JSON.stringify(res.body));
    return res;
  }

  /** `res` answers exactly like an unknown token at the same path. */
  async function assertLikeUnknownToken (res, path) {
    const unknown = await unknownTokenAnswer(path);
    assert.equal(res.status, unknown.status, JSON.stringify(res.body));
    assert.deepEqual(res.body.error, unknown.body.error);
    assert.equal(res.headers['pryv-access-id'], undefined, 'no access id on a refusal');
    assert.equal(unknown.headers['pryv-access-id'], undefined);
  }

  function assertNoUsername (label, body) {
    const text = typeof body === 'string' ? body : JSON.stringify(body);
    assert.ok(!text.includes(who.username), label + ' carries the username: ' + text);
    assert.ok(!text.includes(userId), label + ' carries the user id: ' + text);
  }

  // --- tests ---

  let first; // the first pairwise session: { token, alias }

  it('[OPSE1] a pairwise consent: grant and session carry one alias; the username is in no answer the app gets', async () => {
    const before = await aliases();
    const flow = await authorize('offline_access read/health ctx/user', pairwiseClient);
    const o = await offer(flow);
    assert.equal(o.offer.randomAlias, true);
    assertNoUsername('/offer', o);
    const t = await exchange(flow, await accept(flow, o.offer.permissions));
    const grant = await grantOf(pairwiseClient);
    assert.match(grant.alias, /^r-[a-z0-9]{8}$/);
    const [session] = await sessionsOf(pairwiseClient);
    assert.equal(session.alias, grant.alias, 'the session carries the grant\'s alias');
    assert.deepEqual(await aliases(), [...before, grant.alias].sort(), 'one alias minted');
    first = { token: t.access_token, refresh: t.refresh_token, alias: grant.alias, sessionId: session.id };

    // Token response: the subject is the alias, no apiEndpoint.
    assert.equal(t.user, grant.alias);
    assert.equal(t.apiEndpoint, undefined);
    assertNoUsername('token response', t);

    const at = (p) => '/' + grant.alias + p;
    const info = await coreRequest.get(at('/access-info')).set('Authorization', t.access_token);
    assert.equal(info.status, 200, JSON.stringify(info.body));
    assert.equal(info.body.user.username, grant.alias);
    assert.equal(info.body.alias, grant.alias);
    assertNoUsername('access-info', info.body);

    const own = await coreRequest.get(at('/accesses/' + encodeURIComponent(session.id))).set('Authorization', t.access_token);
    assert.equal(own.status, 200, JSON.stringify(own.body));
    assert.ok(own.body.access.apiEndpoint.includes(grant.alias), own.body.access.apiEndpoint);
    assertNoUsername('accesses.getOne (own row)', own.body);

    const events = await coreRequest.get(at('/events')).set('Authorization', t.access_token);
    assert.equal(events.status, 200, JSON.stringify(events.body));
    const withFile = events.body.events.find((e) => e.id === attachedEvent.id);
    assert.ok(withFile?.attachments?.[0]?.readToken, 'the attachment comes with its read token: ' + JSON.stringify(withFile));
    assertNoUsername('events.get', events.body);
    const file = withFile.attachments[0];
    const download = await coreRequest.get(at('/events/' + withFile.id + '/' + file.id + '?readToken=' + encodeURIComponent(file.readToken)));
    assert.equal(download.status, 200, download.text);

    const missing = await coreRequest.get(at('/events/no-such-event')).set('Authorization', t.access_token);
    assert.ok(missing.status >= 400, JSON.stringify(missing.body));
    assertNoUsername('an error answer', missing.body);

    // The app's subject on a refresh: the same alias, still no endpoint.
    const r = await refresh(t.refresh_token, pairwiseClient);
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.user, grant.alias);
    assert.equal(r.body.apiEndpoint, undefined);
    assertNoUsername('refresh response', r.body);
    first.token = r.body.access_token;
    first.refresh = r.body.refresh_token;
  });

  it('[OPSE2] a refreshed session carries the same alias, and its apiEndpoint is the alias one', async () => {
    const sessions = await sessionsOf(pairwiseClient);
    assert.ok(sessions.length >= 2);
    for (const s of sessions) {
      assert.equal(s.alias, first.alias);
      assert.ok(s.apiEndpoint.includes(first.alias) && !s.apiEndpoint.includes(who.username), s.apiEndpoint);
    }
    const info = await coreRequest.get('/' + first.alias + '/access-info').set('Authorization', first.token);
    assert.equal(info.status, 200, JSON.stringify(info.body));
    assert.equal(info.body.user.username, first.alias);
  });

  it('[OPSE3] a re-authorization, at the same and at a wider scope, keeps the grant and its alias', async () => {
    const before = await grantOf(pairwiseClient);
    await runFlow('read/health', pairwiseClient);
    const wider = await runFlow('read/health read/diary ctx/user', pairwiseClient);
    const after = await grantOf(pairwiseClient);
    assert.equal(baseOf(after.id), baseOf(before.id));
    assert.equal(after.alias, before.alias);
    assert.equal(wider.user, before.alias);
    for (const s of await sessionsOf(pairwiseClient)) assert.equal(s.alias, before.alias);
  });

  it('[OPSE4] a second client of the same user gets another alias', async () => {
    const t = await runFlow('read/health ctx/user', otherPairwiseClient);
    const grant = await grantOf(otherPairwiseClient);
    assert.match(grant.alias, /^r-[a-z0-9]{8}$/);
    assert.notEqual(grant.alias, first.alias);
    assert.equal(t.user, grant.alias);
  });

  it('[OPSE5] a session is used at its alias only: at the username, at another alias, it answers like an unknown token', async () => {
    const other = await grantOf(otherPairwiseClient);
    const otherToken = (await runFlow('read/health', otherPairwiseClient)).access_token;
    // At the username.
    const atName = '/' + who.username + '/access-info';
    await assertLikeUnknownToken(await coreRequest.get(atName).set('Authorization', first.token), atName);
    const eventsAtName = '/' + who.username + '/events';
    await assertLikeUnknownToken(await coreRequest.get(eventsAtName).set('Authorization', first.token), eventsAtName);
    // At another client's alias, either way round.
    const atOther = '/' + other.alias + '/access-info';
    await assertLikeUnknownToken(await coreRequest.get(atOther).set('Authorization', first.token), atOther);
    const atFirst = '/' + first.alias + '/access-info';
    await assertLikeUnknownToken(await coreRequest.get(atFirst).set('Authorization', otherToken), atFirst);
    // The attachment read token too.
    const events = await coreRequest.get('/' + first.alias + '/events').set('Authorization', first.token);
    const file = events.body.events.find((e) => e.id === attachedEvent.id).attachments[0];
    const viaName = await coreRequest.get('/' + who.username + '/events/' + attachedEvent.id + '/' + file.id + '?readToken=' + encodeURIComponent(file.readToken));
    assert.equal(viaName.status, 403, viaName.text);
    assert.equal(viaName.body.error.id, 'invalid-access-token');
    assert.equal(viaName.headers['pryv-access-id'], undefined);
    // The owner's own session is used at any of the account's names.
    const owner = await coreRequest.get(atFirst).set('Authorization', who.token);
    assert.equal(owner.status, 200, JSON.stringify(owner.body));
  });

  it('[OPSE6] deleting one session keeps the alias (the grant and the other sessions hold it)', async () => {
    const sessions = await sessionsOf(pairwiseClient);
    assert.ok(sessions.length >= 2);
    const doomed = sessions.find((s) => s.id !== baseOf(first.sessionId)) ?? sessions[0];
    const del = await ownerDelete(doomed.id);
    assert.equal(del.status, 200, JSON.stringify(del.body));
    assert.ok((await aliases()).includes(first.alias), 'the alias is still held');
    const live = (await sessionsOf(pairwiseClient)).find((s) => s.id !== doomed.id);
    const info = await coreRequest.get('/' + first.alias + '/access-info').set('Authorization', live.token);
    assert.equal(info.status, 200, JSON.stringify(info.body));
  });

  it('[OPSE7] deleting the grant deletes its sessions (an expired one included) and releases the alias once; the next consent gets a new one', async () => {
    const grant = await grantOf(pairwiseClient);
    const sessions = await sessionsOf(pairwiseClient);
    // One session expired: it can no longer authenticate but still carries the alias.
    const user = { id: userId, username: who.username };
    await new Promise((resolve, reject) => storageLayer.accesses.updateOne(user, { id: baseOf(sessions[0].id) },
      { expires: Date.now() / 1000 - 60 }, (err) => (err != null ? reject(err) : resolve())));
    const del = await ownerDelete(grant.id);
    assert.equal(del.status, 200, JSON.stringify(del.body));
    assert.equal((await sessionsOf(pairwiseClient)).length, 0);
    const all = await coreRequest.get('/' + who.username + '/accesses').query({ includeExpired: true }).set('Authorization', who.token);
    assert.equal(all.body.accesses.some((a) => a.alias === grant.alias), false, 'no row holds the alias any more');
    assert.equal((await aliases()).includes(grant.alias), false, 'the alias is released');
    const gone = await coreRequest.get('/' + grant.alias + '/access-info').set('Authorization', first.token);
    assert.equal(gone.status, 404, JSON.stringify(gone.body));
    const t = await runFlow('read/health ctx/user', pairwiseClient);
    const fresh = await grantOf(pairwiseClient);
    assert.notEqual(fresh.alias, grant.alias);
    assert.equal(t.user, fresh.alias);
  });

  it('[OPSE8] refresh-token reuse ends the chain and releases the alias', async () => {
    const t = await runFlow('offline_access read/health', pairwiseClient);
    const grant = await grantOf(pairwiseClient);
    assert.equal((await refresh(t.refresh_token, pairwiseClient)).status, 200);
    await withInjectedConfig({ oauth: { refreshReuseGraceSeconds: 0 } }, async () => {
      const replay = await refresh(t.refresh_token, pairwiseClient);
      assert.equal(replay.status, 400, JSON.stringify(replay.body));
    });
    assert.equal(await grantOf(pairwiseClient), null);
    assert.equal((await aliases()).includes(grant.alias), false, 'the alias is released');
  });

  it('[OPSE9] two first consents at once: one grant, one alias, both sessions under it', async () => {
    const cid = await registry('Pwc', { subjectType: 'pairwise' });
    const before = await aliases();
    const flows = [await authorize('read/health', cid), await authorize('read/health', cid)];
    const offers = [await offer(flows[0]), await offer(flows[1])];
    const accepted = await Promise.all(flows.map((f, i) => accept(f, offers[i].offer.permissions)));
    for (const a of accepted) assert.equal(a.status, 200, JSON.stringify(a.body));
    const grant = await grantOf(cid);
    assert.match(grant.alias, /^r-[a-z0-9]{8}$/);
    const sessions = await sessionsOf(cid);
    assert.equal(sessions.length, 2);
    for (const s of sessions) assert.equal(s.alias, grant.alias);
    assert.deepEqual(await aliases(), [...before, grant.alias].sort(), 'the loser\'s alias was given back');
  });

  it('[OPSE10] an alias is set by the server only; an access a pseudonymous session creates carries its alias', async () => {
    const t = await runFlow('read/health', pairwiseClient);
    const grant = await grantOf(pairwiseClient);
    const chosen = await coreRequest.post('/' + who.username + '/accesses').set('Authorization', who.token)
      .send({ name: 'opse10 chosen', alias: grant.alias, permissions: [{ streamId: 'health', level: 'read' }] });
    assert.equal(chosen.status, 403, JSON.stringify(chosen.body));
    const update = await coreRequest.put('/' + who.username + '/accesses/' + encodeURIComponent(grant.id)).set('Authorization', who.token)
      .send({ alias: 'r-abcdefgh' });
    assert.ok(update.status >= 400, JSON.stringify(update.body));
    // A shared access the session creates: same alias, no username in the answer.
    const child = await coreRequest.post('/' + grant.alias + '/accesses').set('Authorization', t.access_token)
      .send({ name: 'opse10 child', type: 'shared', permissions: [{ streamId: 'health', level: 'read' }] });
    assert.equal(child.status, 201, JSON.stringify(child.body));
    assert.equal(child.body.access.alias, grant.alias);
    assertNoUsername('accesses.create', child.body);
    const listed = await coreRequest.get('/' + grant.alias + '/accesses').set('Authorization', t.access_token);
    assert.equal(listed.status, 200, JSON.stringify(listed.body));
    assertNoUsername('accesses.get', listed.body);
    const childInfo = await coreRequest.get('/' + grant.alias + '/access-info').set('Authorization', child.body.access.token);
    assert.equal(childInfo.status, 200, JSON.stringify(childInfo.body));
    const childAtName = '/' + who.username + '/access-info';
    await assertLikeUnknownToken(await coreRequest.get(childAtName).set('Authorization', child.body.access.token), childAtName);
    // The child holds the alias too; deleting the grant takes it and releases the alias.
    assert.equal((await ownerDelete(grant.id)).status, 200);
    assert.equal((await aliases()).includes(grant.alias), false);
  });

  it('[OPSE11] a client revoked, then registered again under the same id: the old grant is withdrawn at the next consent, a fresh alias', async () => {
    const cid = await registry('Pwr', { subjectType: 'pairwise' });
    const t = await runFlow('read/health', cid);
    const old = await grantOf(cid);
    const row = await storage.getClient(platformDB, cid);
    await storage.deleteClient(platformDB, cid);
    await new Promise((resolve) => setTimeout(resolve, 5));
    await oauth2.persistClient(platformDB, { ...row, updatedAt: Date.now() });
    const t2 = await runFlow('read/health ctx/user', cid);
    const fresh = await grantOf(cid);
    assert.notEqual(baseOf(fresh.id), baseOf(old.id));
    assert.notEqual(fresh.alias, old.alias);
    assert.equal(t2.user, fresh.alias);
    assert.equal((await aliases()).includes(old.alias), false, 'the old alias is released');
    const dead = await coreRequest.get('/' + old.alias + '/access-info').set('Authorization', t.access_token);
    assert.equal(dead.status, 404, JSON.stringify(dead.body));
  });

  it('[OPSE13] access-info at one client\'s alias with another client\'s token answers like an unknown token', async () => {
    const a = await runFlow('read/health', pairwiseClient);
    const b = await runFlow('read/health', otherPairwiseClient);
    const aliasA = (await grantOf(pairwiseClient)).alias;
    const path = '/' + aliasA + '/access-info';
    await assertLikeUnknownToken(await coreRequest.get(path).set('Authorization', b.access_token), path);
    assert.equal((await coreRequest.get(path).set('Authorization', a.access_token)).status, 200);
  });

  it('[OPSE14] account to pseudonym: the change is shown and acknowledged, then an aliased grant replaces the account one', async () => {
    const plain = await runFlow('read/health ctx/user', publicClient);
    assert.equal(plain.user, userId);
    const oldGrant = await grantOf(publicClient);
    assert.equal(oldGrant.alias ?? null, null);
    const flow = await authorize('read/health ctx/user ctx/pseudo', publicClient);
    const o = await offer(flow, true);
    assert.deepEqual(o.currentGrant, { subjectMode: 'account' });
    assert.deepEqual(o.subjectChange, { from: 'account', to: 'pseudonym' });
    const granted = o.offer.permissions.map(({ currentlyGranted: _c, currentLevel: _l, ...p }) => p);
    const refused = await accept(flow, granted, { shownDigest: o.shownDigest });
    assert.equal(refused.status, 400, JSON.stringify(refused.body));
    assert.equal(refused.body.reason, 'subject-change-unacknowledged');
    const t = await exchange(flow, await accept(flow, granted, { shownDigest: o.shownDigest, acknowledgeSubjectChange: true }));
    const now = await grantOf(publicClient);
    assert.notEqual(baseOf(now.id), baseOf(oldGrant.id));
    assert.match(now.alias, /^r-[a-z0-9]{8}$/);
    assert.equal(t.user, now.alias);
    assertNoUsername('token response', t);
    const oldSession = await coreRequest.get('/' + who.username + '/access-info').set('Authorization', plain.access_token);
    assert.equal(oldSession.status, 403, 'the account-mode session died with its grant');
    const info = await coreRequest.get('/' + now.alias + '/access-info').set('Authorization', t.access_token);
    assert.equal(info.status, 200, JSON.stringify(info.body));
  });

  it('[OPSE12] a change of username: the session keeps working at its alias; deleting the account releases it', async () => {
    const t = await runFlow('read/health', pairwiseClient);
    const alias = (await grantOf(pairwiseClient)).alias;
    const newName = 'opsn' + cuid().toLowerCase().slice(1, 12);
    const changed = await coreRequest.post('/' + who.username + '/account/change-username').set('Authorization', who.token)
      .send({ newUsername: newName });
    assert.equal(changed.status, 200, JSON.stringify(changed.body));
    const formerName = who.username;
    who.username = newName;
    const info = await coreRequest.get('/' + alias + '/access-info').set('Authorization', t.access_token);
    assert.equal(info.status, 200, JSON.stringify(info.body));
    assert.equal(info.body.user.username, alias);
    for (const n of [newName, formerName]) {
      const path = '/' + n + '/access-info';
      await assertLikeUnknownToken(await coreRequest.get(path).set('Authorization', t.access_token), path);
    }
    await usersRepository.deleteOne(userId, newName);
    assert.equal(await usersIndex.getUserId(alias), undefined, 'the alias no longer resolves');
    userId = null;
  });
});
