/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */

/**
 * [OGS] The grant's state, end to end: the extension's
 * `scopeGrammar.grantState` is computed at every consent once the grant's
 * permissions are final, stored on the grant (server-owned
 * `clientData.oauth.extensionData`), replaced at each re-consent, left alone
 * by a refresh and by the owner's narrowing, and handed back to the echo and
 * to the response and introspection hooks. Over its bound or not
 * serialisable: the consent fails and the grant is unchanged.
 */

/* global initTests, initCore, coreRequest, getNewFixture, cuid */

import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import * as oauth2 from 'oauth2';
import * as storage from 'oauth2/src/storage.ts';
import { mintSecret } from 'oauth2/src/clientSecret.ts';
import * as storages from 'storages';
import { injectTestConfigSnapshot } from 'test-helpers';

const REDIRECT_URI = 'https://app.state.test/redirect';
const CONSENT_URL = 'https://auth.test/oauth2-authorize';
const AUD = 'https://resource.test/base';
const EXT_NAME = 'toy-state';

// Toy grammar: `read/<s>`, `write/<s>` give one stream a level. Its grant
// state names the streams the grant reaches and counts the consents; a test
// may replace it (`stateOverride`). Every context handed to the echo and to
// the hooks is recorded.
const LEVEL_OF = { read: 'read', write: 'contribute' };
let stateOverride = null;
let consents = 0;
let seen = [];
const toyExtension = {
  apiVersion: 1,
  name: EXT_NAME,
  scopeGrammar: {
    parse (scopeString) {
      const tokens = [...new Set(scopeString.split(/\s+/).filter((t) => t !== ''))];
      const permissions = [];
      for (const t of tokens) {
        if (t.startsWith('ctx/')) continue;
        const slash = t.indexOf('/');
        const level = LEVEL_OF[t.slice(0, slash)];
        if (slash <= 0 || level == null) return { ok: false, description: 'unknown token ' + t };
        permissions.push({ streamId: t.slice(slash + 1), level });
      }
      return { ok: true, tokens, offer: { permissions, allowUserChoice: tokens.includes('ctx/choice') } };
    },
    echo (ctx) {
      seen.push({ hook: 'echo', grantState: ctx.grantState });
      const { permissions, requestedTokens } = ctx;
      const has = (s, levels) => permissions.some((p) => p.streamId === s && levels.includes(p.level));
      return requestedTokens.filter((t) => {
        if (t.startsWith('ctx/')) return true;
        const [kind, s] = t.split('/');
        return kind === 'read' ? has(s, ['read', 'contribute']) : has(s, ['contribute']);
      });
    },
    grantState ({ permissions, requestedTokens, client }) {
      consents++;
      if (stateOverride != null) return stateOverride({ permissions, requestedTokens, client });
      return {
        streams: permissions.filter((p) => p.streamId != null).map((p) => p.streamId + ':' + p.level).sort(),
        requested: requestedTokens,
        consent: consents,
      };
    },
  },
  tokenResponse (ctx) {
    seen.push({ hook: 'tokenResponse', grantType: ctx.grantType, grantState: ctx.grantState });
    return {};
  },
  introspectionClaims (ctx) {
    seen.push({ hook: 'introspectionClaims', grantState: ctx.grantState });
    return {};
  },
};

const SCOPE = ['read/a', 'read/b', 'write/a', 'ctx/choice'];

function pkce () {
  const verifier = crypto.randomBytes(32).toString('base64url');
  return { verifier, challenge: crypto.createHash('sha256').update(verifier).digest('base64url') };
}

describe('[OGS] OAuth registry clients: the grant state', function () {
  this.timeout(60000);

  let fixtures, restoreConfig, platformDB, appId, rsId, rsSecret;

  before(async function () {
    await initTests();
    await initCore();
    fixtures = getNewFixture();
    restoreConfig = injectTestConfigSnapshot({ oauth: { consentUrl: CONSENT_URL } });
    oauth2.extension.setExtension(toyExtension);
    platformDB = storages.platformDB;
    const row = {
      kind: 'registry',
      redirectUris: [REDIRECT_URI],
      grantTypes: ['authorization_code', 'refresh_token'],
      tokenEndpointAuthMethod: 'none',
      allowedAudiences: [AUD],
      subjectType: 'public',
      scope: SCOPE,
    };
    appId = 'Gst.' + cuid().slice(-10);
    await oauth2.persistClient(platformDB, { ...row, clientId: appId });
    rsSecret = await mintSecret();
    rsId = 'GsRs.' + cuid().slice(-10);
    await oauth2.persistClient(platformDB, {
      ...row, clientId: rsId, tokenEndpointAuthMethod: 'client_secret_basic', clientSecretHash: rsSecret.hash, canIntrospect: true,
    });
  });

  after(async function () {
    oauth2.extension._resetForTests();
    if (restoreConfig != null) restoreConfig();
    for (const id of [appId, rsId]) {
      try { await storage.deleteClient(platformDB, id); } catch (_) { /* best-effort */ }
    }
    if (fixtures != null) await fixtures.clean();
  });

  beforeEach(() => { seen = []; });
  afterEach(() => { stateOverride = null; });

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
    return { username, token };
  }

  /** Authorize, signed-in offer, accept (all shown entries, or `keep`) with shownDigest. */
  async function consent (who, scope, { keep = null } = {}) {
    const { verifier, challenge } = pkce();
    const res = await coreRequest.get('/oauth2/authorize').query({
      client_id: appId,
      redirect_uri: REDIRECT_URI,
      response_type: 'code',
      state: 'csrf-' + cuid(),
      code_challenge: challenge,
      code_challenge_method: 'S256',
      scope,
      aud: AUD,
    });
    assert.equal(res.status, 302, res.text);
    const state = new URL(res.headers.location).searchParams.get('state');
    const o = await coreRequest.post('/oauth2/authorize/offer').send({ state, username: who.username, userToken: who.token });
    assert.equal(o.status, 200, JSON.stringify(o.body));
    const shown = o.body.offer.permissions;
    const granted = (keep == null ? shown : shown.filter(keep)).map(({ currentlyGranted: _c, currentLevel: _l, ...p }) => p);
    const a = await coreRequest.post('/oauth2/authorize/accept')
      .send({ state, username: who.username, userToken: who.token, grantedPermissions: granted, shownDigest: o.body.shownDigest });
    return { verifier, accept: a };
  }

  async function consentAndToken (who, scope, opts) {
    const c = await consent(who, scope, opts);
    assert.equal(c.accept.status, 200, JSON.stringify(c.accept.body));
    const code = new URL(c.accept.body.redirectTo).searchParams.get('code');
    const t = await coreRequest.post('/oauth2/token').type('form').send({
      grant_type: 'authorization_code', code, code_verifier: c.verifier, client_id: appId, redirect_uri: REDIRECT_URI,
    });
    assert.equal(t.status, 200, JSON.stringify(t.body));
    return t.body;
  }

  function refresh (refreshToken) {
    return coreRequest.post('/oauth2/token').type('form').send({ grant_type: 'refresh_token', refresh_token: refreshToken, client_id: appId });
  }

  function introspect (token) {
    return coreRequest.post('/oauth2/introspect').type('form')
      .set('Authorization', 'Basic ' + Buffer.from(rsId + ':' + rsSecret.plaintext).toString('base64'))
      .send({ token });
  }

  async function accesses (who) {
    const res = await coreRequest.get('/' + who.username + '/accesses').set('Authorization', who.token);
    assert.equal(res.status, 200, JSON.stringify(res.body));
    return res.body.accesses;
  }

  async function grantOf (who) {
    return (await accesses(who)).find((a) => a.name === 'oauth-grant:' + appId) ?? null;
  }

  function stateOf (grant) {
    return grant?.clientData?.oauth?.extensionData?.[EXT_NAME];
  }

  function ownerUpdate (who, grant, update) {
    return coreRequest.put('/' + who.username + '/accesses/' + encodeURIComponent(grant.id)).set('Authorization', who.token).send(update);
  }

  function statesOf (hook) {
    return seen.filter((s) => s.hook === hook).map((s) => s.grantState);
  }

  it('[OGS10] stored on the grant only, handed to the echo and the hooks at the exchange, the refresh and introspection', async () => {
    const who = await newUser();
    const t = await consentAndToken(who, 'offline_access read/a read/b');
    const grant = await grantOf(who);
    const state = stateOf(grant);
    assert.deepEqual(state.streams, ['a:read', 'b:read']);
    assert.deepEqual(state.requested, ['read/a', 'read/b']);
    // Never on a session.
    for (const s of (await accesses(who)).filter((a) => a.name === 'oauth:' + appId)) {
      assert.equal(s.clientData?.oauth?.extensionData, undefined);
    }
    // At the consent (the granted scope recorded) and at the exchange.
    assert.ok(statesOf('echo').length >= 2);
    for (const s of statesOf('echo')) assert.deepEqual(s, state);
    assert.deepEqual(statesOf('tokenResponse'), [state]);

    seen = [];
    const r = await refresh(t.refresh_token);
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.deepEqual(statesOf('tokenResponse'), [state]);
    assert.deepEqual(statesOf('echo'), [state]);
    // A refresh does not compute it again.
    assert.deepEqual(stateOf(await grantOf(who)), state);

    seen = [];
    const i = await introspect(r.body.access_token);
    assert.equal(i.status, 200, JSON.stringify(i.body));
    assert.equal(i.body.active, true);
    assert.deepEqual(statesOf('introspectionClaims'), [state]);
    assert.deepEqual(statesOf('echo'), [state]);
  });

  it('[OGS11] replaced at a re-consent, untouched by the owner narrowing the grant, removed when the hook answers none', async () => {
    const who = await newUser();
    const t = await consentAndToken(who, 'offline_access read/a read/b');
    const first = stateOf(await grantOf(who));

    await consentAndToken(who, 'write/a');
    const second = stateOf(await grantOf(who));
    assert.notEqual(second.consent, first.consent);
    assert.deepEqual(second.streams, ['a:contribute', 'b:read']);
    assert.deepEqual(second.requested, ['write/a']);

    // The owner narrows the grant: the state stays as the consent left it
    // (advisory), while the sessions follow the permissions.
    const grant = await grantOf(who);
    const narrowed = grant.permissions.filter((p) => p.streamId !== 'b');
    const upd = await ownerUpdate(who, grant, { permissions: narrowed });
    assert.equal(upd.status, 200, JSON.stringify(upd.body));
    assert.deepEqual(stateOf(await grantOf(who)), second);
    seen = [];
    const r = await refresh(t.refresh_token);
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.deepEqual(statesOf('tokenResponse'), [second]);
    // The echo still follows the permissions: `b` is no longer named.
    assert.deepEqual(r.body.scope.split(' ').sort(), ['offline_access', 'read/a']);

    stateOverride = () => undefined;
    await consentAndToken(who, 'read/a');
    const g = await grantOf(who);
    assert.equal(stateOf(g), undefined);
    assert.equal(g.clientData.oauth.extensionData, undefined);
    assert.equal(typeof g.clientData.oauth.grantOf, 'string');
  });

  it('[OGS12] 16 KiB of JSON is accepted, one byte more fails the consent and leaves the grant unchanged', async () => {
    const who = await newUser();
    // `"` + n characters + `"`: 2 + n bytes (two per `é`).
    stateOverride = () => 'é'.repeat(8191);
    await consentAndToken(who, 'read/a');
    const grant = await grantOf(who);
    assert.equal(Buffer.byteLength(JSON.stringify(stateOf(grant))), 16384);

    stateOverride = () => 'é'.repeat(8191) + 'x';
    const over = await consent(who, 'read/a read/b');
    assert.equal(over.accept.status, 500, JSON.stringify(over.accept.body));
    assert.equal(over.accept.body.error, 'server_error');
    const after = await grantOf(who);
    assert.deepEqual(after.permissions, grant.permissions);
    assert.deepEqual(stateOf(after), stateOf(grant));
    assert.equal(after.id, grant.id);
  });

  it('[OGS13] a state that is not JSON-serialisable, or a throwing hook, fails the consent: no grant, no session', async () => {
    const who = await newUser();
    for (const make of [() => ({ n: 10n }), () => { const o = {}; o.self = o; return o; }, () => () => 1, () => { throw new Error('boom'); }]) {
      stateOverride = make;
      const c = await consent(who, 'read/a');
      assert.equal(c.accept.status, 500, JSON.stringify(c.accept.body));
      assert.equal(c.accept.body.error, 'server_error');
    }
    const list = await accesses(who);
    assert.equal(list.some((a) => a.name === 'oauth-grant:' + appId || a.name === 'oauth:' + appId), false);
  });

  it('[OGS14] the owner cannot write the state: accesses.update touching clientData.oauth is refused', async () => {
    const who = await newUser();
    await consentAndToken(who, 'read/a');
    const grant = await grantOf(who);
    const forged = { ...grant.clientData, oauth: { ...grant.clientData.oauth, extensionData: { [EXT_NAME]: { streams: ['b:read'] } } } };
    const res = await ownerUpdate(who, grant, { clientData: forged });
    assert.equal(res.status, 403, JSON.stringify(res.body));
    const dropped = await ownerUpdate(who, grant, { clientData: { ...grant.clientData, oauth: { grantOf: grant.clientData.oauth.grantOf } } });
    assert.equal(dropped.status, 403, JSON.stringify(dropped.body));
    assert.deepEqual(stateOf(await grantOf(who)), stateOf(grant));
  });
});
