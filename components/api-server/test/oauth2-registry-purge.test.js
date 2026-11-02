/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);

/**
 * [ORGP] OAuth registry clients, operator side, end to end: the purge of a
 * client's grants on this core (`bin/oauth-client.js purge-grants`), the
 * vetting status (a change of redirect URIs puts the client under review,
 * refused until approved), the entry ceiling, and the operator-registered
 * display fields served before sign-in.
 */

/* global initTests, initCore, coreRequest, getNewFixture, cuid */

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const oauth2 = require('oauth2');
const storage = require('oauth2/src/storage.ts');
const cli = require('../../../bin/oauth-client.js');
const { getClient, persistClient } = require('oauth2/src/clientRegistry.ts');

const REDIRECT_URI = 'https://app.purge.test/redirect';
const CONSENT_URL = 'https://auth.test/oauth2-authorize';
const AUD = 'https://resource.test/base';
const STATE_KEY = 'purge-state-key-'.repeat(3);

// `read/<s>` reads one stream; `ctx/user` is a context token.
const toyExtension = {
  apiVersion: 1,
  name: 'toy-purge',
  scopeGrammar: {
    parse (scopeString) {
      const tokens = [...new Set(scopeString.split(/\s+/).filter((t) => t !== ''))];
      const permissions = [];
      for (const t of tokens) {
        if (t === 'ctx/user') continue;
        if (!t.startsWith('read/')) return { ok: false, description: 'unknown token ' + t };
        permissions.push({ streamId: t.slice(5), level: 'read' });
      }
      return { ok: true, tokens, offer: { permissions } };
    },
    echo ({ permissions, requestedTokens }) {
      return requestedTokens.filter((t) => t === 'ctx/user' || permissions.some((p) => 'read/' + p.streamId === t));
    },
  },
};

function pkce () {
  const verifier = crypto.randomBytes(32).toString('base64url');
  return { verifier, challenge: crypto.createHash('sha256').update(verifier).digest('base64url') };
}

/** Run a CLI command function with console.log captured. */
async function runCli (fn, argv, ...deps) {
  const lines = [];
  const log = console.log;
  console.log = (...a) => { lines.push(a.join(' ')); };
  try {
    await fn(require('storages').platformDB, cli.parseArgs(argv), ...deps);
    return { out: lines.join('\n'), error: null };
  } catch (error) {
    return { out: lines.join('\n'), error };
  } finally {
    console.log = log;
  }
}

describe('[ORGP] OAuth registry clients: purge, vetting, ceilings, display', function () {
  this.timeout(60000);

  let fixtures, restoreConfig, platformDB, clientId, pairwiseId, otherId, savedEnv;
  const people = [];

  async function registry (id, extra) {
    await persistClient(platformDB, {
      clientId: id,
      kind: 'registry',
      redirectUris: [REDIRECT_URI],
      grantTypes: ['authorization_code', 'refresh_token'],
      tokenEndpointAuthMethod: 'none',
      allowedAudiences: [AUD],
      subjectType: 'public',
      scope: ['read/health', 'read/diary', 'ctx/user'],
      status: 'active',
      ...extra,
    });
  }

  before(async function () {
    await initTests();
    await initCore();
    fixtures = getNewFixture();
    restoreConfig = require('test-helpers').injectTestConfigSnapshot({
      oauth: { consentUrl: CONSENT_URL, stateKey: STATE_KEY, logoHosts: ['logos.purge.test'] },
    });
    oauth2.extension.setExtension(toyExtension);
    platformDB = require('storages').platformDB;
    savedEnv = { ...cli.cliEnv };
    cli.cliEnv.localUserId = async () => null;
    cli.cliEnv.hostingCoreOf = async () => null;
    for (let i = 0; i < 2; i++) {
      const username = cuid();
      const token = cuid();
      const user = await fixtures.user(username);
      await user.access({ token, type: 'personal' });
      await user.session(token);
      for (const id of ['health', 'diary']) {
        const res = await coreRequest.post('/' + username + '/streams').set('Authorization', token).send({ id, name: id });
        assert.equal(res.status, 201, JSON.stringify(res.body));
      }
      people.push({ username, token, userId: user.attrs.id });
    }
    clientId = 'Prg.' + cuid().slice(-10);
    await registry(clientId, { allowFeatures: ['accessCreation'] });
    pairwiseId = 'PrgPw.' + cuid().slice(-10);
    await registry(pairwiseId, { subjectType: 'pairwise' });
    otherId = 'PrgOt.' + cuid().slice(-10);
    await registry(otherId);
  });

  after(async function () {
    Object.assign(cli.cliEnv, savedEnv);
    oauth2.extension._resetForTests();
    if (restoreConfig != null) restoreConfig();
    for (const id of [clientId, pairwiseId, otherId]) {
      if (id != null) { try { await storage.deleteClient(platformDB, id); } catch (_) { /* best-effort */ } }
    }
    if (fixtures != null) await fixtures.clean();
  });

  function authorize (scope, cid, challenge = 'x'.repeat(43)) {
    return coreRequest.get('/oauth2/authorize').query({
      client_id: cid,
      redirect_uri: REDIRECT_URI,
      response_type: 'code',
      state: 'csrf-' + cuid(),
      code_challenge: challenge,
      code_challenge_method: 'S256',
      scope,
      aud: AUD,
    });
  }

  /** The error of an /authorize answered by a redirect to the app. */
  function redirectedError (res) {
    assert.equal(res.status, 302, res.text);
    const loc = new URL(res.headers.location);
    assert.equal(loc.origin + loc.pathname, REDIRECT_URI, res.headers.location);
    return { error: loc.searchParams.get('error'), description: loc.searchParams.get('error_description') };
  }

  async function runFlow (scope, cid, who) {
    const { verifier, challenge } = pkce();
    const authRes = await authorize(scope, cid, challenge);
    assert.equal(authRes.status, 302, authRes.text);
    assert.ok(authRes.headers.location.startsWith(CONSENT_URL + '?state='), authRes.headers.location);
    const signedState = new URL(authRes.headers.location).searchParams.get('state');
    const offerRes = await coreRequest.post('/oauth2/authorize/offer').send({ state: signedState });
    assert.equal(offerRes.status, 200, JSON.stringify(offerRes.body));
    const acceptRes = await coreRequest.post('/oauth2/authorize/accept').send({
      state: signedState, username: who.username, userToken: who.token, grantedPermissions: offerRes.body.offer.permissions,
    });
    assert.equal(acceptRes.status, 200, JSON.stringify(acceptRes.body));
    const code = new URL(acceptRes.body.redirectTo).searchParams.get('code');
    const tokenRes = await coreRequest.post('/oauth2/token').type('form').send({
      grant_type: 'authorization_code', code, code_verifier: verifier, client_id: cid, redirect_uri: REDIRECT_URI,
    });
    assert.equal(tokenRes.status, 200, JSON.stringify(tokenRes.body));
    return { offer: offerRes.body, token: tokenRes.body };
  }

  function refresh (refreshToken, cid) {
    return coreRequest.post('/oauth2/token').type('form').send({ grant_type: 'refresh_token', refresh_token: refreshToken, client_id: cid });
  }

  async function accessesOf (who) {
    const res = await coreRequest.get('/' + who.username + '/accesses').set('Authorization', who.token);
    assert.equal(res.status, 200, JSON.stringify(res.body));
    return res.body.accesses;
  }

  it('[ORGP1] purge-grants deletes the client\'s grants, sessions, what they created, aliases and refresh chains on this core; other clients keep theirs', async () => {
    const [alice, bob] = people;
    const a1 = await runFlow('offline_access read/health ctx/user', clientId, alice);
    const a2 = await runFlow('offline_access read/diary', clientId, alice);
    const b1 = await runFlow('offline_access read/health', clientId, bob);
    const pw = await runFlow('offline_access read/health', pairwiseId, alice);
    const other = await runFlow('offline_access read/health', otherId, bob);
    // A session that created an access (the client may).
    const shared = await coreRequest.post('/' + alice.username + '/accesses').set('Authorization', a1.token.access_token)
      .send({ type: 'shared', name: 'from-the-app-' + cuid(), permissions: [{ streamId: 'health', level: 'read' }] });
    assert.equal(shared.status, 201, JSON.stringify(shared.body));
    const pwGrant = (await accessesOf(alice)).find((a) => a.name === 'oauth-grant:' + pairwiseId);
    assert.match(pwGrant.alias, /^r-/);
    const usersIndex = await require('storage').getUsersLocalIndex();
    assert.equal(await usersIndex.getUserIdForAlias(pwGrant.alias), alice.userId);
    // A chain no session points to any more (its session's index row is gone,
    // as when the session expired): ended by the keyspace sweep.
    await storage.deleteSessionIndex(platformDB, b1.token.access_token);

    let r = await runCli(cli.runPurgeGrants, ['purge-grants', clientId]);
    assert.match(r.error?.message ?? '', /refuses to run without --yes/);
    r = await runCli(cli.runPurgeGrants, ['purge-grants', clientId, '--yes'], cli.cliEnv.purgeClientGrants);
    assert.equal(r.error, null, r.error?.stack);
    assert.match(r.out, /grants deleted: {8}2\n/);
    assert.match(r.out, /sessions deleted: {6}3\n/);
    assert.match(r.out, /accesses deleted: {6}6 /);
    assert.match(r.out, /accounts concerned: {4}2\n/);
    // The sessions' chains end with them; the sweep ends the one left.
    assert.match(r.out, /other refresh tokens ended: {2}1/);

    for (const who of [alice, bob]) {
      const left = (await accessesOf(who)).filter((a) => a.name === 'oauth-grant:' + clientId || a.name === 'oauth:' + clientId);
      assert.deepEqual(left, [], who.username);
    }
    assert.equal((await accessesOf(alice)).some((a) => a.id === shared.body.access.id), false, 'created access deleted');
    for (const [t, who] of [[a1, alice], [a2, alice], [b1, bob]]) {
      const read = await coreRequest.get('/' + who.username + '/events').set('Authorization', t.token.access_token);
      assert.equal(read.status, 403, JSON.stringify(read.body));
      const res = await refresh(t.token.refresh_token, clientId);
      assert.equal(res.status, 400, JSON.stringify(res.body));
      assert.equal(res.body.error, 'invalid_grant');
    }
    // The other clients are untouched.
    assert.equal((await refresh(other.token.refresh_token, otherId)).status, 200);
    assert.equal((await refresh(pw.token.refresh_token, pairwiseId)).status, 200);

    // Purging the pairwise client releases its alias.
    r = await runCli(cli.runPurgeGrants, ['purge-grants', pairwiseId, '--yes'], cli.cliEnv.purgeClientGrants);
    assert.equal(r.error, null, r.error?.stack);
    assert.match(r.out, /grants deleted: {8}1\n/);
    assert.equal(await usersIndex.getUserIdForAlias(pwGrant.alias), undefined);

    // A next authorization is a fresh consent: a new grant.
    await runFlow('read/health', clientId, alice);
    const fresh = (await accessesOf(alice)).filter((a) => a.name === 'oauth-grant:' + clientId);
    assert.equal(fresh.length, 1);
    // Nothing left to purge for a client without grants: zero counts.
    r = await runCli(cli.runPurgeGrants, ['purge-grants', 'Nobody.' + cuid().slice(-6), '--yes'], cli.cliEnv.purgeClientGrants);
    assert.match(r.out, /grants deleted: {8}0\n/);
  });

  it('[ORGP2] update --redirect-uri puts the client under review: /authorize refuses it, its refresh is refused (not used up); --approve restores it', async () => {
    const [alice] = people;
    const t = await runFlow('offline_access read/health', otherId, alice);
    let r = await runCli(cli.runUpdate, ['update', otherId, '--redirect-uri', REDIRECT_URI, '--redirect-uri', REDIRECT_URI + '/2'], getClient, persistClient);
    assert.equal(r.error, null, r.error?.stack);
    assert.equal((await getClient(platformDB, otherId)).status, 'review');
    // No redirect to the (unvetted) redirect URIs: an HTML 400.
    const refused = await authorize('read/health', otherId);
    assert.equal(refused.status, 400, refused.text);
    assert.equal(refused.headers.location, undefined);
    assert.match(refused.text, /this client is under review/);
    let res = await refresh(t.token.refresh_token, otherId);
    assert.equal(res.status, 400, JSON.stringify(res.body));
    assert.equal(res.body.error, 'unauthorized_client');
    r = await runCli(cli.runUpdate, ['update', otherId, '--approve'], getClient, persistClient);
    assert.equal(r.error, null, r.error?.stack);
    assert.equal((await authorize('read/health', otherId)).headers.location.startsWith(CONSENT_URL), true);
    res = await refresh(t.token.refresh_token, otherId);
    assert.equal(res.status, 200, JSON.stringify(res.body));
  });

  it('[ORGP3] the entry ceiling is enforced at /authorize; the signed-out offer serves the localized name, description and an allowed logo', async () => {
    await registry(otherId, {
      maxEntries: 1,
      name: { en: 'Purge app', fr: 'App purge' },
      description: { en: 'Reads one stream.' },
      logoUri: 'https://logos.purge.test/app.png',
    });
    assert.deepEqual(redirectedError(await authorize('read/health read/diary', otherId)),
      { error: 'invalid_scope', description: 'the requested scope expands to more than 1 permissions' });
    const authRes = await authorize('read/health', otherId);
    const signedState = new URL(authRes.headers.location).searchParams.get('state');
    const offerRes = await coreRequest.post('/oauth2/authorize/offer').send({ state: signedState });
    assert.equal(offerRes.status, 200, JSON.stringify(offerRes.body));
    assert.deepEqual(offerRes.body.client.name, { en: 'Purge app', fr: 'App purge' });
    assert.deepEqual(offerRes.body.client.description, { en: 'Reads one stream.' });
    assert.equal(offerRes.body.client.logoUri, 'https://logos.purge.test/app.png');
    // The CLI refuses a logo on another host.
    const r = await runCli(cli.runUpdate, ['update', otherId, '--logo-uri', 'https://elsewhere.test/a.png'], getClient, persistClient);
    assert.match(r.error?.message ?? '', /host "elsewhere.test" is not in oauth.logoHosts \(logos.purge.test\)/);
  });
});
