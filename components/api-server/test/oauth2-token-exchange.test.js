/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */

/**
 * [OTXE] token exchange (RFC 8693) end to end: a resource server registered
 * for it exchanges the token a user's client sent it (issued for the
 * resource server's audience) for a derived session of the same user and
 * grant; the derived session follows every lifecycle path of its grant and
 * of its subject session; with `oauth:audienceBoundSessions` the data API
 * refuses the subject token itself.
 *
 * Every exchange here is the minimal request a resource server sends:
 * grant_type, subject_token and subject_token_type, HTTP Basic client
 * authentication, no resource, audience or scope.
 */

/* global initTests, initCore, coreRequest, getNewFixture, cuid, app */

import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import * as oauth2 from 'oauth2';
import * as storage from 'oauth2/src/storage.ts';
import { mintSecret } from 'oauth2/src/clientSecret.ts';
import { checkRegistryClients } from 'oauth2/src/registryBootCheck.ts';
import { ApiEndpoint } from 'utils';
import * as storages from 'storages';
import { injectTestConfigSnapshot, withInjectedConfig } from 'test-helpers';
import { getConfigUnsafe, getLogger } from '@pryv/boiler';
import auditModule from 'audit';
import { purgeClientGrants } from '../src/methods/helpers/oauthGrantPurge.ts';

const REDIRECT_URI = 'https://app.exchange.test/redirect';
const CONSENT_URL = 'https://auth.test/oauth2-authorize';
const STATE_KEY = 'test-oauth-state-key-' + 'a1B2c3D4e5'.repeat(2);
const RS_AUD = 'https://rs.example.test/rs';
const OTHER_AUD = 'https://other.example.test/api';
const TOKEN_EXCHANGE = 'urn:ietf:params:oauth:grant-type:token-exchange';
const ACCESS_TOKEN_TYPE = 'urn:ietf:params:oauth:token-type:access_token';
const OAUTH = { consentUrl: CONSENT_URL, stateKey: STATE_KEY };

// Toy grammar: `read/<s>`, `write/<s>` give one stream a level.
const LEVEL_OF = { read: 'read', write: 'contribute' };
const toyExtension = {
  apiVersion: 1,
  name: 'toy-exchange',
  scopeGrammar: {
    parse (scopeString) {
      const tokens = [...new Set(scopeString.split(/\s+/).filter((t) => t !== ''))];
      const permissions = [];
      for (const t of tokens) {
        const slash = t.indexOf('/');
        const level = LEVEL_OF[t.slice(0, slash)];
        if (slash <= 0 || level == null) return { ok: false, description: 'unknown token ' + t };
        permissions.push({ streamId: t.slice(slash + 1), level });
      }
      return { ok: true, tokens, offer: { permissions, allowUserChoice: true } };
    },
    echo ({ permissions, requestedTokens }) {
      const has = (s, levels) => permissions.some((p) => p.streamId === s && levels.includes(p.level));
      return requestedTokens.filter((t) => {
        const [kind, s] = t.split('/');
        return kind === 'read' ? has(s, ['read', 'contribute']) : has(s, ['contribute']);
      });
    },
  },
};

const SCOPE = ['read/a', 'read/b', 'write/a'];

function pkce () {
  const verifier = crypto.randomBytes(32).toString('base64url');
  return { verifier, challenge: crypto.createHash('sha256').update(verifier).digest('base64url') };
}

describe('[OTXE] OAuth token exchange end to end', function () {
  this.timeout(90000);

  let fixtures, restoreConfig, platformDB, connId, pairId, freeId, rsId, rsSecret, otherRsId, introId;
  const clientIds = [];

  async function register (prefix, extra) {
    const clientId = prefix + '.' + cuid().slice(-10);
    await oauth2.persistClient(platformDB, {
      clientId,
      kind: 'registry',
      redirectUris: [REDIRECT_URI],
      grantTypes: ['authorization_code', 'refresh_token'],
      tokenEndpointAuthMethod: 'none',
      allowedAudiences: [RS_AUD],
      subjectType: 'public',
      scope: SCOPE,
      ...extra,
    });
    clientIds.push(clientId);
    return clientId;
  }

  before(async function () {
    await initTests();
    await initCore();
    fixtures = getNewFixture();
    restoreConfig = injectTestConfigSnapshot({ oauth: OAUTH });
    oauth2.extension.setExtension(toyExtension);
    platformDB = storages.platformDB;
    rsSecret = await mintSecret();
    const confidential = { tokenEndpointAuthMethod: 'client_secret_basic', clientSecretHash: rsSecret.hash };
    connId = await register('Conn');
    pairId = await register('Pair', { subjectType: 'pairwise' });
    // Registered for no particular audience: its authorizations may name none.
    freeId = await register('Free', { allowedAudiences: [], anyAudience: true });
    rsId = await register('Rs', { ...confidential, canExchange: true, canIntrospect: true });
    otherRsId = await register('Other', { ...confidential, canExchange: true, allowedAudiences: [OTHER_AUD] });
    introId = await register('Intro', { ...confidential, canIntrospect: true });
  });

  after(async function () {
    oauth2.extension._resetForTests();
    if (restoreConfig != null) restoreConfig();
    for (const id of clientIds) {
      try { await storage.deleteClient(platformDB, id); } catch (_) { /* best-effort */ }
    }
    if (fixtures != null) await fixtures.clean();
  });

  async function newUser () {
    const username = cuid();
    const token = cuid();
    const user = await fixtures.user(username);
    await user.access({ token, type: 'personal' });
    await user.session(token);
    for (const id of ['a', 'b']) {
      const s = await coreRequest.post('/' + username + '/streams').set('Authorization', token).send({ id, name: id });
      assert.equal(s.status, 201, JSON.stringify(s.body));
    }
    return { username, token, userId: user.attrs.id };
  }

  /** Consent (every offered entry) with `aud`, then the code exchange naming the resource. */
  async function connectorToken (who, scope = 'offline_access write/a read/b', { cid = connId, aud = RS_AUD } = {}) {
    const { verifier, challenge } = pkce();
    const res = await coreRequest.get('/oauth2/authorize').query({
      client_id: cid,
      redirect_uri: REDIRECT_URI,
      response_type: 'code',
      state: 'csrf-' + cuid(),
      code_challenge: challenge,
      code_challenge_method: 'S256',
      scope,
      ...(aud != null ? { aud } : {}),
    });
    assert.equal(res.status, 302, res.text);
    const state = new URL(res.headers.location).searchParams.get('state');
    const o = await coreRequest.post('/oauth2/authorize/offer').send({ state, username: who.username, userToken: who.token });
    assert.equal(o.status, 200, JSON.stringify(o.body));
    const granted = o.body.offer.permissions.map(({ currentlyGranted: _c, currentLevel: _l, ...p }) => p);
    const a = await coreRequest.post('/oauth2/authorize/accept')
      .send({ state, username: who.username, userToken: who.token, grantedPermissions: granted, shownDigest: o.body.shownDigest });
    assert.equal(a.status, 200, JSON.stringify(a.body));
    const code = new URL(a.body.redirectTo).searchParams.get('code');
    const t = await coreRequest.post('/oauth2/token').type('form').send({
      grant_type: 'authorization_code',
      code,
      code_verifier: verifier,
      client_id: cid,
      redirect_uri: REDIRECT_URI,
      ...(aud != null ? { resource: aud } : {}),
    });
    assert.equal(t.status, 200, JSON.stringify(t.body));
    return t.body;
  }

  /** The request a resource server sends, nothing more. */
  function exchange (subjectToken, auth = [rsId, rsSecret.plaintext]) {
    return coreRequest.post('/oauth2/token').type('form')
      .set('Authorization', 'Basic ' + Buffer.from(auth[0] + ':' + auth[1]).toString('base64'))
      .send({ grant_type: TOKEN_EXCHANGE, subject_token: subjectToken, subject_token_type: ACCESS_TOKEN_TYPE });
  }

  async function exchanged (subjectToken) {
    const res = await exchange(subjectToken);
    assert.equal(res.status, 200, JSON.stringify(res.body));
    return res.body;
  }

  function introspect (token, auth = [introId, rsSecret.plaintext]) {
    return coreRequest.post('/oauth2/introspect').type('form')
      .set('Authorization', 'Basic ' + Buffer.from(auth[0] + ':' + auth[1]).toString('base64'))
      .send({ token });
  }

  function refresh (refreshToken, cid = connId) {
    return coreRequest.post('/oauth2/token').type('form').send({ grant_type: 'refresh_token', refresh_token: refreshToken, client_id: cid });
  }

  async function accesses (who, query = {}) {
    const res = await coreRequest.get('/' + who.username + '/accesses').query(query).set('Authorization', who.token);
    assert.equal(res.status, 200, JSON.stringify(res.body));
    return res.body.accesses;
  }

  async function rowOf (who, token, query = {}) {
    return (await accesses(who, query)).find((a) => a.token === token) ?? null;
  }

  function readStream (who, token, streamId, name = who.username) {
    return coreRequest.get('/' + name + '/events').query({ streams: JSON.stringify([streamId]) }).set('Authorization', token);
  }

  function writeEvent (who, token, streamId) {
    return coreRequest.post('/' + who.username + '/events').set('Authorization', token)
      .send({ streamIds: [streamId], type: 'note/txt', content: 'from the resource server' });
  }

  async function setStatus (clientId, status) {
    const row = await storage.getClient(platformDB, clientId);
    await storage.setClient(platformDB, { ...row, status, updatedAt: Date.now() });
  }

  /** Poll `probe` until it answers `status` (the client checks are cached per core for a short period). */
  async function eventually (probe, status, ms = 6000) {
    const deadline = Date.now() + ms;
    let last;
    while (Date.now() < deadline) {
      last = (await probe()).status;
      if (last === status) return last;
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
    return last;
  }

  async function auditRows (body) {
    const original = auditModule.eventForUser;
    const rows = [];
    auditModule.eventForUser = async function (userId, row, event) {
      if (String(event).startsWith('oauth.')) rows.push({ event, record: row.content.record });
      return await original.apply(this, arguments);
    };
    try {
      await body();
    } finally {
      auditModule.eventForUser = original;
    }
    return rows;
  }

  it('[OTXE01] consent and code exchange naming the resource server, then the exchange: the derived token reaches the grant\'s streams, writes as itself, and is listed with its origin', async () => {
    const who = await newUser();
    const t = await connectorToken(who);
    let x;
    const rows = await auditRows(async () => { x = await exchanged(t.access_token); });
    assert.equal(x.issued_token_type, ACCESS_TOKEN_TYPE);
    assert.equal(x.token_type, 'Bearer');
    assert.ok(Number.isInteger(x.expires_in) && x.expires_in > 0 && x.expires_in <= 3600, String(x.expires_in));
    assert.equal(x.refresh_token, undefined);
    assert.equal(x.apiEndpoint, undefined);
    assert.equal(x.api_base, ApiEndpoint.build(who.username, undefined));
    assert.ok(!x.api_base.includes(x.access_token) && !x.api_base.includes(t.access_token));
    assert.deepEqual(x.scope.split(' ').sort(), ['read/b', 'write/a']);
    assert.notEqual(x.access_token, t.access_token);
    const audited = rows.filter((r) => r.event === 'oauth.token.exchanged');
    assert.equal(audited.length, 1);
    assert.equal(audited[0].record.clientId, rsId);
    assert.equal(audited[0].record.subjectClientId, connId);
    assert.equal(audited[0].record.reused, false);
    assert.ok(!JSON.stringify(rows).includes(x.access_token) && !JSON.stringify(rows).includes(t.access_token), 'no token in the audit rows');

    // Reach: the grant's streams, nothing else; writes are its own.
    assert.equal((await readStream(who, x.access_token, 'a')).status, 200);
    assert.equal((await readStream(who, x.access_token, 'b')).status, 200);
    const created = await writeEvent(who, x.access_token, 'a');
    assert.equal(created.status, 201, JSON.stringify(created.body));
    assert.equal((await writeEvent(who, x.access_token, 'b')).status, 403);
    const other = await coreRequest.post('/' + who.username + '/streams').set('Authorization', who.token).send({ id: 'c', name: 'c' });
    assert.equal(other.status, 201);
    assert.equal((await readStream(who, x.access_token, 'c')).status, 403);

    // The rows: the subject records its resource server, the derived one its origin.
    const subject = await rowOf(who, t.access_token);
    const derived = await rowOf(who, x.access_token);
    assert.equal(created.body.event.createdBy, derived.id);
    assert.equal(subject.clientData.oauth.audience, RS_AUD);
    assert.equal(derived.name, 'oauth:' + rsId);
    assert.equal(derived.type, 'app');
    assert.deepEqual(derived.clientData.oauth.exchange, { subjectClientId: connId, subjectAccessId: subject.id, subjectCreated: subject.created });
    assert.equal(derived.clientData.oauth.dataGrantId, subject.clientData.oauth.dataGrantId);
    assert.equal(derived.clientData.oauth.audience, undefined);
    assert.ok(derived.expires <= subject.expires, derived.expires + ' > ' + subject.expires);
    const grant = (await accesses(who)).find((a) => a.name === 'oauth-grant:' + connId);
    assert.equal(grant.id.split(':')[0], derived.clientData.oauth.dataGrantId.split(':')[0]);

    // X1: a repeated exchange answers the same derived token; one row.
    const again = await exchanged(t.access_token);
    assert.equal(again.access_token, x.access_token);
    assert.equal((await accesses(who)).filter((a) => a.name === 'oauth:' + rsId).length, 1);

    // The derived token is never a subject; another resource server is no deputy.
    const chained = await exchange(x.access_token);
    assert.deepEqual([chained.status, chained.body.error], [400, 'invalid_grant']);
    const foreign = await exchange(t.access_token, [otherRsId, rsSecret.plaintext]);
    assert.deepEqual([foreign.status, foreign.body.error], [400, 'invalid_target']);
    // The client itself, or the introspection-only resource server, may not exchange.
    assert.equal((await exchange(t.access_token, [connId, 'x'])).status, 401);
    assert.equal((await exchange(t.access_token, [introId, rsSecret.plaintext])).body.error, 'unauthorized_client');
  });

  it('[OTXE02] with audienceBoundSessions true the subject token is refused at the data API (request, batch, socket.io), the derived one is not; false keeps both, and the boot warns', async () => {
    const who = await newUser();
    const t = await connectorToken(who);
    const x = await exchanged(t.access_token);
    // false (the default): both work.
    assert.equal((await readStream(who, t.access_token, 'a')).status, 200);
    assert.equal((await readStream(who, x.access_token, 'a')).status, 200);
    // The boot warns while a client may exchange and the core does not bind.
    const loggerProto = Object.getPrototypeOf(getLogger('oauth2'));
    const warn = loggerProto.warn;
    const warned = [];
    loggerProto.warn = function (message, ...rest) { warned.push(String(message)); return warn.call(this, message, ...rest); };
    try {
      await checkRegistryClients(platformDB, getConfigUnsafe(true));
    } finally {
      loggerProto.warn = warn;
    }
    assert.ok(warned.some((m) => m.includes('may exchange tokens') && m.includes(rsId)), JSON.stringify(warned));

    await withInjectedConfig({ oauth: { ...OAUTH, audienceBoundSessions: true } }, async () => {
      const refused = await readStream(who, t.access_token, 'a');
      assert.equal(refused.status, 403, JSON.stringify(refused.body));
      assert.equal(refused.body.error.id, 'invalid-access-token');
      assert.match(String(refused.headers['www-authenticate']), /Bearer error="invalid_token"/);
      assert.equal((await readStream(who, x.access_token, 'a')).status, 200);
      const batch = await coreRequest.post('/' + who.username).set('Authorization', t.access_token)
        .send([{ method: 'events.get', params: { streams: ['a'] } }]);
      assert.equal(batch.status, 403, JSON.stringify(batch.body));
      const okBatch = await coreRequest.post('/' + who.username).set('Authorization', x.access_token)
        .send([{ method: 'events.get', params: { streams: ['a'] } }]);
      assert.equal(okBatch.status, 200, JSON.stringify(okBatch.body));
      // The exchange itself is not the data API: still answered.
      assert.equal((await exchange(t.access_token)).status, 200);
      // Introspection still says what the token is.
      assert.equal((await introspect(t.access_token)).body.active, true);

      // socket.io
      const http = await import('node:http');
      const { createRequire } = await import('node:module');
      const require = createRequire(import.meta.url);
      const ioClient = require('socket.io-client');
      const setupSocketIO = require('../src/socket-io/index.ts').default;
      const s = http.createServer(app.expressApp);
      const setup = await setupSocketIO(s, app.api, app.getCustomAuthFunction('test'));
      await new Promise((resolve) => s.listen(0, '127.0.0.1', resolve));
      const clients = [];
      const outcome = (token) => new Promise((resolve) => {
        const c = ioClient.connect(`http://127.0.0.1:${s.address().port}/${who.username}?auth=${token}`, { forceNew: true, transports: ['websocket'], reconnection: false });
        clients.push(c);
        const timer = setTimeout(() => resolve({ timeout: true }), 10000);
        c.once('connect', () => { clearTimeout(timer); resolve({ connected: true }); });
        c.once('connect_error', (err) => { clearTimeout(timer); resolve({ error: err?.message }); });
        c.once('error', (err) => { clearTimeout(timer); resolve({ error: typeof err === 'string' ? err : err?.message }); });
      });
      try {
        assert.deepEqual(await outcome(x.access_token), { connected: true });
        const bound = await outcome(t.access_token);
        assert.ok(bound.error != null, JSON.stringify(bound));
      } finally {
        for (const c of clients) c.disconnect();
        s.closeAllConnections();
        if (setup?.io != null) await new Promise((resolve) => setup.io.close(() => resolve()));
        else await new Promise((resolve) => s.close(resolve));
      }
    });
    // Back to false: the subject token works again (nothing was ended).
    assert.equal((await readStream(who, t.access_token, 'a')).status, 200);
    // A session issued for no resource server is never refused.
    const plain = await connectorToken(who, 'offline_access read/a', { cid: freeId, aud: null });
    await withInjectedConfig({ oauth: { ...OAUTH, audienceBoundSessions: true } }, async () => {
      assert.equal((await readStream(who, plain.access_token, 'a')).status, 200);
      // Not exchangeable either.
      const ex = await exchange(plain.access_token);
      assert.deepEqual([ex.status, ex.body.error], [400, 'invalid_grant']);
    });
  });

  it('[OTXE03] a session minted before the field keeps working under true; the next session of its chain records it and is refused', async () => {
    const who = await newUser();
    const t = await connectorToken(who);
    const subject = await rowOf(who, t.access_token);
    // As written before the field existed.
    const { audience: _a, ...oauth } = subject.clientData.oauth;
    const repo = storages.storageLayer.accesses;
    await new Promise((resolve, reject) => repo.updateOne({ id: who.userId, username: who.username }, { id: subject.id },
      { clientData: { ...subject.clientData, oauth }, modified: Date.now() / 1000 }, (err) => (err != null ? reject(err) : resolve())));
    (await import('cache')).default.unsetUserData(who.userId);
    await withInjectedConfig({ oauth: { ...OAUTH, audienceBoundSessions: true } }, async () => {
      assert.equal((await readStream(who, t.access_token, 'a')).status, 200);
      const r = await refresh(t.refresh_token);
      assert.equal(r.status, 200, JSON.stringify(r.body));
      assert.equal((await rowOf(who, r.body.access_token)).clientData.oauth.audience, RS_AUD);
      assert.equal((await readStream(who, r.body.access_token, 'a')).status, 403);
      // Its resource server exchanges it.
      const x = await exchanged(r.body.access_token);
      assert.equal((await readStream(who, x.access_token, 'a')).status, 200);
    });
  });

  it('[OTXE04] the owner deletes the subject session: the derived session goes with it at once; introspection says inactive', async () => {
    const who = await newUser();
    const t = await connectorToken(who);
    const x = await exchanged(t.access_token);
    assert.equal((await introspect(x.access_token)).body.active, true);
    const subject = await rowOf(who, t.access_token);
    const del = await coreRequest.delete('/' + who.username + '/accesses/' + encodeURIComponent(subject.id)).set('Authorization', who.token);
    assert.equal(del.status, 200, JSON.stringify(del.body));
    assert.equal((await readStream(who, x.access_token, 'a')).status, 403);
    assert.deepEqual((await introspect(x.access_token)).body, { active: false });
    assert.equal((await accesses(who)).filter((a) => a.name === 'oauth:' + rsId).length, 0);
    assert.ok((await accesses(who)).some((a) => a.name === 'oauth-grant:' + connId), 'the grant stays');
    // The derived index row went with it.
    assert.equal(await storage.getSessionIndex(platformDB, x.access_token), null);
  });

  it('[OTXE05] the client revokes its refresh token (RFC 7009): the subject session and the derived one end', async () => {
    const who = await newUser();
    const t = await connectorToken(who);
    const x = await exchanged(t.access_token);
    const res = await coreRequest.post('/oauth2/revoke').type('form')
      .send({ token: t.refresh_token, token_type_hint: 'refresh_token', client_id: connId });
    assert.equal(res.status, 200, res.text);
    assert.equal((await readStream(who, t.access_token, 'a')).status, 403);
    assert.equal((await readStream(who, x.access_token, 'a')).status, 403);
    // A revoked subject token cannot be exchanged again.
    assert.equal((await exchange(t.access_token)).body.error, 'invalid_grant');
  });

  it('[OTXE06] the grant narrowed: the derived session is re-cut with its subject; the grant withdrawn: both go', async () => {
    const who = await newUser();
    const t = await connectorToken(who);
    const x = await exchanged(t.access_token);
    assert.equal((await writeEvent(who, x.access_token, 'a')).status, 201);
    const grant = (await accesses(who)).find((a) => a.name === 'oauth-grant:' + connId);
    const upd = await coreRequest.put('/' + who.username + '/accesses/' + encodeURIComponent(grant.id)).set('Authorization', who.token)
      .send({ permissions: [{ streamId: 'a', level: 'read' }, { streamId: 'b', level: 'read' }] });
    assert.equal(upd.status, 200, JSON.stringify(upd.body));
    assert.equal((await writeEvent(who, x.access_token, 'a')).status, 403);
    assert.equal((await readStream(who, x.access_token, 'a')).status, 200);
    // A repeated exchange answers the narrowed reach (the toy echo names the
    // requested tokens still held: `write/a` is not any more), same token.
    const again = await exchanged(t.access_token);
    assert.equal(again.access_token, x.access_token);
    assert.equal(again.scope, 'read/b');
    assert.equal((await introspect(t.access_token)).body.scope.split(' ').filter((s) => s !== 'offline_access').join(' '), again.scope);
    // The update bumped the grant's serial: its current id.
    const current = (await accesses(who)).find((a) => a.name === 'oauth-grant:' + connId);
    const del = await coreRequest.delete('/' + who.username + '/accesses/' + encodeURIComponent(current.id)).set('Authorization', who.token);
    assert.equal(del.status, 200, JSON.stringify(del.body));
    assert.equal((await readStream(who, x.access_token, 'a')).status, 403);
    assert.equal((await accesses(who)).filter((a) => a.name === 'oauth:' + rsId).length, 0);
    assert.equal((await exchange(t.access_token)).body.error, 'invalid_grant');
  });

  it('[OTXE07] a pairwise client\'s token: the derived session carries the alias, is used at the alias only, and no answer names the username', async () => {
    const who = await newUser();
    const t = await connectorToken(who, 'read/a', { cid: pairId });
    const res = await exchange(t.access_token);
    assert.equal(res.status, 200, JSON.stringify(res.body));
    const grant = (await accesses(who)).find((a) => a.name === 'oauth-grant:' + pairId);
    assert.match(grant.alias, /^r-/);
    assert.ok(res.body.api_base.includes(grant.alias), res.body.api_base);
    assert.ok(!JSON.stringify(res.body).includes(who.username), JSON.stringify(res.body));
    const derived = await rowOf(who, res.body.access_token);
    assert.equal(derived.alias, grant.alias);
    assert.equal((await readStream(who, res.body.access_token, 'a', grant.alias)).status, 200);
    assert.equal((await readStream(who, res.body.access_token, 'a')).status, 403);
    const info = await introspect(res.body.access_token);
    assert.equal(info.body.sub, grant.alias);
    assert.ok(!JSON.stringify(info.body).includes(who.username), JSON.stringify(info.body));
  });

  it('[OTXE08] the resource server suspended: its derived token is refused and it may not exchange; the client suspended: the derived token is refused and the exchange is invalid_grant', async () => {
    const who = await newUser();
    const t = await connectorToken(who);
    const x = await exchanged(t.access_token);
    await withInjectedConfig({ oauth: { ...OAUTH, clientRevokeCheckSeconds: 1 } }, async () => {
      for (const [clientId, exchangeError] of [[rsId, 'unauthorized_client'], [connId, 'invalid_grant']]) {
        await setStatus(clientId, 'suspended');
        try {
          assert.equal(await eventually(() => readStream(who, x.access_token, 'a'), 403), 403, clientId);
          assert.equal((await exchange(t.access_token)).body.error, exchangeError, clientId);
          assert.deepEqual((await introspect(x.access_token)).body, { active: false }, clientId);
        } finally {
          await setStatus(clientId, 'active');
        }
        assert.equal(await eventually(() => readStream(who, x.access_token, 'a'), 200), 200, clientId + ' resumed');
      }
    });
  });

  it('[OTXE09] purge-grants of the resource server removes its derived sessions only; of the client, its grant with the derived sessions', async () => {
    const who = await newUser();
    const t = await connectorToken(who);
    const x = await exchanged(t.access_token);
    await purgeClientGrants(rsId);
    assert.equal((await readStream(who, x.access_token, 'a')).status, 403);
    assert.equal((await readStream(who, t.access_token, 'a')).status, 200, 'the client\'s session stays');
    assert.ok((await accesses(who)).some((a) => a.name === 'oauth-grant:' + connId), 'the client\'s grant stays');
    const y = await exchanged(t.access_token);
    assert.notEqual(y.access_token, x.access_token);
    await purgeClientGrants(connId);
    assert.equal((await readStream(who, y.access_token, 'a')).status, 403);
    assert.equal((await readStream(who, t.access_token, 'a')).status, 403);
    assert.equal((await accesses(who)).filter((a) => a.name === 'oauth:' + rsId || a.name === 'oauth-grant:' + connId).length, 0);
  });

  it('[OTXE10] introspection of the derived token: the client as client_id, the resource server as act, no aud, its permissions', async () => {
    const who = await newUser();
    const t = await connectorToken(who);
    const x = await exchanged(t.access_token);
    let res;
    const rows = await auditRows(async () => { res = await introspect(x.access_token); });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    const b = res.body;
    assert.equal(b.active, true);
    assert.equal(b.client_id, connId);
    assert.deepEqual(b.act, { client_id: rsId });
    assert.equal(b.aud, undefined);
    assert.equal(b.token_type, 'Bearer');
    assert.equal(b.scope, x.scope);
    assert.equal(b.sub, who.userId);
    assert.deepEqual(b.permissions, [{ streamId: 'a', level: 'contribute' }, { streamId: 'b', level: 'read' }]);
    const row = rows.find((r) => r.event === 'oauth.token.introspected');
    assert.equal(row.record.tokenClientId, connId);
    assert.equal(row.record.actorClientId, rsId);
    // The subject token answers as before: its client, its audience, no act.
    const s = (await introspect(t.access_token)).body;
    assert.deepEqual([s.client_id, s.aud, s.act], [connId, RS_AUD, undefined]);
  });

  it('[OTXE12] the client refreshes: the previous derived token lives out its own expiry (within the subject\'s issued one); the new subject token gets a new derived session', async () => {
    const who = await newUser();
    const t = await connectorToken(who);
    const x = await exchanged(t.access_token);
    const issuedSubjectExpiry = (await rowOf(who, t.access_token)).expires;
    let r;
    await withInjectedConfig({ oauth: { ...OAUTH, refreshRetireGraceSeconds: 0 } }, async () => {
      r = await refresh(t.refresh_token);
      assert.equal(r.status, 200, JSON.stringify(r.body));
      assert.equal((await readStream(who, t.access_token, 'a')).status, 403, 'the subject is retired');
      assert.equal((await readStream(who, x.access_token, 'a')).status, 200, 'the derived session is not');
    });
    const old = await rowOf(who, x.access_token);
    assert.ok(old.expires <= issuedSubjectExpiry, old.expires + ' > ' + issuedSubjectExpiry);
    // The retired subject token is no subject any more.
    assert.equal((await exchange(t.access_token)).body.error, 'invalid_grant');
    const y = await exchanged(r.body.access_token);
    assert.notEqual(y.access_token, x.access_token);
    assert.equal((await rowOf(who, y.access_token)).clientData.oauth.exchange.subjectAccessId, (await rowOf(who, r.body.access_token)).id);
  });

  it('[OTXE13] two first exchanges at once: one derived session, both answers carry its token', async () => {
    const who = await newUser();
    const t = await connectorToken(who);
    const [a, b] = await Promise.all([exchange(t.access_token), exchange(t.access_token)]);
    assert.equal(a.status, 200, JSON.stringify(a.body));
    assert.equal(b.status, 200, JSON.stringify(b.body));
    assert.equal(a.body.access_token, b.body.access_token);
    assert.equal((await accesses(who)).filter((x) => x.name === 'oauth:' + rsId).length, 1);
  });

  /** Write `update` on an access storage-direct (as a row from another time, or a drift), then drop the cached copy. */
  async function rewrite (who, id, update) {
    const repo = storages.storageLayer.accesses;
    await new Promise((resolve, reject) => repo.updateOne({ id: who.userId, username: who.username }, { id },
      { ...update, modified: Date.now() / 1000 }, (err) => (err != null ? reject(err) : resolve())));
    (await import('cache')).default.unsetUserData(who.userId);
  }

  /** The operator revoke epoch of a client (what a revoke writes), its row kept. */
  async function setRevokedAt (clientId, at) {
    await platformDB.setPlatformKv('oauth-client-revoked/' + clientId, JSON.stringify({ revokedAt: at }));
  }

  /** Run `body` with `before(row)` run (once) ahead of the insert of the next derived session. */
  async function beforeDerivedInsert (before, body) {
    const repo = storages.storageLayer.accesses;
    const insertOne = repo.insertOne;
    let pending = true;
    repo.insertOne = function (user, row, cb) {
      if (pending && typeof row?.deviceName === 'string' && row.deviceName.startsWith('oauth-exchange:')) {
        pending = false;
        before(row).then(() => insertOne.call(this, user, row, cb), cb);
        return;
      }
      return insertOne.apply(this, arguments);
    };
    try {
      return await body();
    } finally {
      repo.insertOne = insertOne;
    }
  }

  it('[OTXE14] a derived session past its own expiry while its subject lives is replaced, never revived: a new token, the old one stays refused and its index row is gone', async () => {
    const who = await newUser();
    const t = await connectorToken(who);
    const x = await exchanged(t.access_token);
    const derived = await rowOf(who, x.access_token);
    await rewrite(who, derived.id, { expires: Date.now() / 1000 - 5 });
    assert.equal((await readStream(who, x.access_token, 'a')).status, 403);
    const again = await exchanged(t.access_token);
    assert.notEqual(again.access_token, x.access_token);
    assert.equal((await readStream(who, x.access_token, 'a')).status, 403);
    assert.equal((await readStream(who, again.access_token, 'a')).status, 200);
    assert.equal(await storage.getSessionIndex(platformDB, x.access_token), null);
    const rows = (await accesses(who, { includeExpired: true })).filter((a) => a.name === 'oauth:' + rsId);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].token, again.access_token);
  });

  it('[OTXE15] a derived session made before the resource server\'s revoke epoch is replaced: the next exchange answers a new token that reads', async () => {
    const epochRs = await register('RsEpoch', { tokenEndpointAuthMethod: 'client_secret_basic', clientSecretHash: rsSecret.hash, canExchange: true });
    const who = await newUser();
    const t = await connectorToken(who);
    const x = (await exchange(t.access_token, [epochRs, rsSecret.plaintext])).body;
    assert.ok(x.access_token != null, JSON.stringify(x));
    // A revoke of the resource server's id (its row registered again keeps the tombstone).
    await setRevokedAt(epochRs, Date.now());
    // The next exchange follows within the epoch's clock margin: tested without it.
    storage._setRevokeClockMarginForTests(0);
    try {
      await withInjectedConfig({ oauth: { ...OAUTH, clientRevokeCheckSeconds: 1 } }, async () => {
        assert.equal(await eventually(() => readStream(who, x.access_token, 'a'), 403), 403);
        const y = await exchange(t.access_token, [epochRs, rsSecret.plaintext]);
        assert.equal(y.status, 200, JSON.stringify(y.body));
        assert.notEqual(y.body.access_token, x.access_token);
        assert.equal((await readStream(who, y.body.access_token, 'a')).status, 200);
        assert.equal((await readStream(who, x.access_token, 'a')).status, 403);
        assert.equal(await storage.getSessionIndex(platformDB, x.access_token), null);
        assert.equal((await accesses(who, { includeExpired: true })).filter((a) => a.name === 'oauth:' + epochRs).length, 1);
      });
    } finally {
      storage._setRevokeClockMarginForTests(null);
    }
  });

  it('[OTXE16] a reused derived session whose permissions drifted from its subject\'s is brought back to the subject\'s', async () => {
    const who = await newUser();
    const t = await connectorToken(who);
    const x = await exchanged(t.access_token);
    const derived = await rowOf(who, x.access_token);
    // Wider than its subject (as a re-cut racing an exchange could leave it).
    const wider = derived.permissions.map((p) => (p.streamId === 'b' ? { ...p, level: 'contribute' } : p));
    await rewrite(who, derived.id, { permissions: wider });
    assert.equal((await writeEvent(who, x.access_token, 'b')).status, 201);
    const again = await exchanged(t.access_token);
    assert.equal(again.access_token, x.access_token);
    assert.equal((await writeEvent(who, x.access_token, 'b')).status, 403);
    assert.equal((await readStream(who, x.access_token, 'b')).status, 200);
  });

  it('[OTXE17] two chains of one grant with different reach: each derived session holds its own subject\'s reach', async () => {
    const who = await newUser();
    const narrow = await connectorToken(who, 'offline_access read/a');
    const wide = await connectorToken(who, 'offline_access read/a read/b');
    const xa = await exchanged(narrow.access_token);
    const xb = await exchanged(wide.access_token);
    assert.notEqual(xa.access_token, xb.access_token);
    assert.equal((await readStream(who, xa.access_token, 'a')).status, 200);
    assert.equal((await readStream(who, xa.access_token, 'b')).status, 403);
    assert.equal((await readStream(who, xb.access_token, 'b')).status, 200);
    assert.equal((await accesses(who)).filter((a) => a.name === 'oauth:' + rsId).length, 2);
  });

  it('[OTXE18] the client revoked: the derived token is refused at the data API; a revoke landing between the exchange\'s check and its mint is caught too (the subject\'s creation is compared)', async () => {
    const revokedConn = await register('ConnRev');
    const who = await newUser();
    await withInjectedConfig({ oauth: { ...OAUTH, clientRevokeCheckSeconds: 1 } }, async () => {
      // Revoked after the exchange.
      const t = await connectorToken(who, 'offline_access write/a read/b', { cid: revokedConn });
      const x = await exchanged(t.access_token);
      assert.equal((await readStream(who, x.access_token, 'a')).status, 200);
      const t2 = await connectorToken(who, 'offline_access write/a read/b', { cid: revokedConn });
      await setRevokedAt(revokedConn, Date.now());
      assert.equal(await eventually(() => readStream(who, x.access_token, 'a'), 403), 403);
      assert.deepEqual((await introspect(x.access_token)).body, { active: false });
      // Revoked while an exchange (of a session made before the revoke) is
      // between its check and its mint: the revoke epoch falls after the
      // subject's creation and before the derived session's.
      await platformDB.deletePlatformKv('oauth-client-revoked/' + revokedConn);
      await new Promise((resolve) => setTimeout(resolve, 1100));
      let epoch;
      const res = await beforeDerivedInsert(async (row) => {
        epoch = Math.floor(row.created * 1000) - 1;
        await setRevokedAt(revokedConn, epoch);
      }, () => exchange(t2.access_token));
      assert.equal(res.status, 200, JSON.stringify(res.body));
      const derived = await rowOf(who, res.body.access_token);
      assert.ok(derived.created * 1000 > epoch && derived.clientData.oauth.exchange.subjectCreated * 1000 <= epoch);
      assert.equal(await eventually(() => readStream(who, res.body.access_token, 'a'), 403), 403);
      assert.deepEqual((await introspect(res.body.access_token)).body, { active: false });
    });
  });

  it('[OTXE19] a subject inside its retire grace may still be exchanged; the derived session ends with the grace', async () => {
    const who = await newUser();
    const t = await connectorToken(who);
    const r = await refresh(t.refresh_token);
    assert.equal(r.status, 200, JSON.stringify(r.body));
    const retired = await rowOf(who, t.access_token);
    assert.ok(retired.expires <= Date.now() / 1000 + 61, String(retired.expires));
    const x = await exchanged(t.access_token);
    assert.ok(x.expires_in <= 61, String(x.expires_in));
    assert.ok((await rowOf(who, x.access_token)).expires <= retired.expires);
    assert.equal((await readStream(who, x.access_token, 'a')).status, 200);
  });

  it('[OTXE20] the subject deleted, or its grant narrowed, between the exchange\'s check and its mint: the new derived session is deleted again (invalid_grant), or follows the subject', async () => {
    const who = await newUser();
    const t = await connectorToken(who);
    const subject = await rowOf(who, t.access_token);
    const gone = await beforeDerivedInsert(async () => {
      const del = await coreRequest.delete('/' + who.username + '/accesses/' + encodeURIComponent(subject.id)).set('Authorization', who.token);
      assert.equal(del.status, 200, JSON.stringify(del.body));
    }, () => exchange(t.access_token));
    assert.deepEqual([gone.status, gone.body.error], [400, 'invalid_grant']);
    assert.equal((await accesses(who, { includeExpired: true })).filter((a) => a.name === 'oauth:' + rsId).length, 0);

    const t2 = await connectorToken(who);
    const narrowed = await beforeDerivedInsert(async () => {
      const grant = (await accesses(who)).find((a) => a.name === 'oauth-grant:' + connId);
      const upd = await coreRequest.put('/' + who.username + '/accesses/' + encodeURIComponent(grant.id)).set('Authorization', who.token)
        .send({ permissions: [{ streamId: 'a', level: 'read' }, { streamId: 'b', level: 'read' }] });
      assert.equal(upd.status, 200, JSON.stringify(upd.body));
    }, () => exchange(t2.access_token));
    assert.equal(narrowed.status, 200, JSON.stringify(narrowed.body));
    assert.equal((await writeEvent(who, narrowed.body.access_token, 'a')).status, 403);
    assert.equal((await readStream(who, narrowed.body.access_token, 'a')).status, 200);
  });
});
