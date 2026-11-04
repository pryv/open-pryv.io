/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);

/**
 * [OCLI] Operator CLI (`bin/oauth-client.js`), registry commands: the subject
 * type is an explicit choice at registration, changing it needs --yes, `list`
 * shows kind, status and subject type, legacy rows without one keep working.
 * The command functions run against an in-memory platform store.
 */

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const cli = require('../../../bin/oauth-client.js');
const extension = require('../src/extension.ts');
const scopeGrammar = require('../src/scopeGrammar.ts');
const offerRoute = require('../src/routes/offer.ts');
const { getClient, persistClient } = require('../src/clientRegistry.ts');
const { setClient } = require('../src/storage.ts');
const { verifySecret } = require('../src/clientSecret.ts');
const { checkRegistryClients } = require('../src/registryBootCheck.ts');
const { handleAuthorize } = require('../src/routes/authorize.ts');

const CONSENT_URL = 'https://consent.example.com/authorize';
const REDIRECT = 'https://app.example.com/redirect';
const AUD = 'https://resource.example.com/base';

function fakePlatform () {
  const kv = new Map();
  const state = new Map();
  return {
    async setPlatformKv (k, v) { kv.set(k, v); },
    async getPlatformKv (k) { return kv.has(k) ? kv.get(k) : null; },
    async deletePlatformKv (k) { kv.delete(k); },
    async listPlatformKvKeys (p) { return [...kv.keys()].filter((k) => k.startsWith(p)); },
    async listPlatformKvEntries (p) { return [...kv.entries()].filter(([k]) => k.startsWith(p)).map(([key, value]) => ({ key, value })); },
    async setAccessState (k, v, exp) { state.set(k, { value: v, expiresAt: exp }); },
    async getAccessState (k) { return state.get(k) ?? null; },
    async deleteAccessState (k) { state.delete(k); },
  };
}

function fakeConfig () {
  const m = { 'service:api': 'https://core.example.com', 'auth:adminAccessKey': 'admin-key', 'oauth:consentUrl': CONSENT_URL, 'oauth:stateKey': 'cli-test-state-key-0123456789abcdef', 'core:id': 'core-a' };
  return { get: (k) => m[k] };
}

const toy = {
  apiVersion: 1,
  name: 'toy-cli',
  scopeGrammar: {
    parse (s) {
      const tokens = s.split(/\s+/).filter((t) => t !== '');
      return { ok: true, tokens, offer: { permissions: tokens.map((t) => ({ streamId: t.replace('read/', ''), level: 'read' })) } };
    },
    echo: ({ requestedTokens }) => requestedTokens,
  },
};

/** Run a command function; returns { out, error } (the CLI exits 1 on error). */
async function run (fn, platform, argv) {
  const args = cli.parseArgs(argv);
  const lines = [];
  const log = console.log;
  console.log = (...a) => { lines.push(a.join(' ')); };
  let error = null;
  try {
    if (fn === cli.runCreateRegistry || fn === cli.runCreate) await fn(platform, args, persistClient, getClient);
    else await fn(platform, args, getClient, persistClient);
  } catch (err) {
    error = err;
  } finally {
    console.log = log;
  }
  return { out: lines.join('\n'), error };
}

function createArgs (id, extra = []) {
  return ['create-registry', id, '--redirect-uri', REDIRECT, '--scope', 'read/a', '--audience', AUD, ...extra];
}

async function authorizeAs (platform, clientId) {
  return new URL((await authorizeRes(platform, clientId)).headers.location);
}

/** The raw /authorize answer (status, headers, body). */
async function authorizeRes (platform, clientId) {
  const res = { statusCode: 200, headers: {}, body: '', setHeader (k, v) { this.headers[k.toLowerCase()] = v; }, end (b) { this.body = b ?? ''; } };
  await handleAuthorize({ config: fakeConfig(), platform })({
    method: 'GET',
    query: {
      client_id: clientId,
      redirect_uri: REDIRECT,
      response_type: 'code',
      code_challenge: 'x'.repeat(43),
      code_challenge_method: 'S256',
      state: 's',
      scope: 'read/a',
      aud: AUD,
    },
  }, res);
  return res;
}

describe('[OCLI] operator CLI: registry clients', () => {
  let savedEnv;
  before(() => {
    savedEnv = { ...cli.cliEnv };
    cli.cliEnv.localUserId = async () => null;
    cli.cliEnv.hostingCoreOf = async () => null;
  });
  after(() => { Object.assign(cli.cliEnv, savedEnv); });
  beforeEach(() => {
    extension.setExtension(toy);
    scopeGrammar._resetForTests();
    offerRoute._resetForTests();
  });
  afterEach(() => extension._resetForTests());

  it('[OCLI1] create-registry without --subject-type: refused, both values named, no row', async () => {
    const platform = fakePlatform();
    const r = await run(cli.runCreateRegistry, platform, createArgs('Cli.one'));
    assert.match(r.error?.message ?? '', /--subject-type public\|pairwise is required \(no default\)/);
    assert.match(r.error.message, /public: the subject is the user's stable id/);
    assert.match(r.error.message, /pairwise: always an alias/);
    assert.equal(await getClient(platform, 'Cli.one'), null);
  });

  it('[OCLI2] an invalid value: the same message with the value quoted, no row', async () => {
    const platform = fakePlatform();
    const r = await run(cli.runCreateRegistry, platform, createArgs('Cli.two', ['--subject-type', 'per-user']));
    assert.match(r.error?.message ?? '', /is required \(no default\), got "per-user"/);
    assert.equal(await getClient(platform, 'Cli.two'), null);
  });

  it('[OCLI3] public: stored and echoed', async () => {
    const platform = fakePlatform();
    const r = await run(cli.runCreateRegistry, platform, createArgs('Cli.three', ['--subject-type', 'public']));
    assert.equal(r.error, null, r.error?.message);
    assert.equal((await getClient(platform, 'Cli.three')).subjectType, 'public');
    assert.match(r.out, /subject type: {2}public \(stable user id\)/);
    assert.doesNotMatch(r.out, /WARN/);
    assert.match(r.out, /features forbidden on its grants: webhooks, secretSharing, accessCreation/);
  });

  it('[OCLI4] pairwise: stored with no warning; /authorize serves it', async () => {
    const platform = fakePlatform();
    const r = await run(cli.runCreateRegistry, platform, createArgs('Cli.four', ['--subject-type', 'pairwise', '--allow-feature', 'webhooks']));
    assert.equal(r.error, null, r.error?.message);
    const row = await getClient(platform, 'Cli.four');
    assert.equal(row.subjectType, 'pairwise');
    assert.deepEqual(row.allowFeatures, ['webhooks']);
    assert.match(r.out, /subject type: {2}pairwise \(always an alias\)/);
    assert.doesNotMatch(r.out, /WARN/);
    assert.match(r.out, /features forbidden on its grants: secretSharing, accessCreation \(allowed: webhooks\)/);
    const loc = await authorizeAs(platform, 'Cli.four');
    assert.equal(loc.origin + loc.pathname, CONSENT_URL, loc.href);
    // An unknown feature is refused at registration.
    const bad = await run(cli.runCreateRegistry, platform, createArgs('Cli.four2', ['--subject-type', 'public', '--allow-feature', 'selfAudit']));
    assert.match(bad.error?.message ?? '', /allowFeatures may only list webhooks, secretSharing, accessCreation/);
  });

  it('[OCLI5] update --subject-type: same value a no-op, a change needs --yes, app-account refused', async () => {
    const platform = fakePlatform();
    await run(cli.runCreateRegistry, platform, createArgs('Cli.five', ['--subject-type', 'public']));
    const before = await getClient(platform, 'Cli.five');
    const same = await run(cli.runUpdate, platform, ['update', 'Cli.five', '--subject-type', 'public']);
    assert.equal(same.error, null, same.error?.message);
    assert.equal((await getClient(platform, 'Cli.five')).subjectType, 'public');
    assert.doesNotMatch(same.out, /NOTE/);
    // Nothing changed: no write, the row's version (and the consents in flight) kept.
    assert.equal((await getClient(platform, 'Cli.five')).updatedAt, before.updatedAt);
    assert.match(same.out, /client unchanged/);
    const refused = await run(cli.runUpdate, platform, ['update', 'Cli.five', '--subject-type', 'pairwise']);
    assert.equal(refused.error?.message, 'update: changing the subject type of "Cli.five" from public to pairwise affects every future consent; re-run with --yes');
    assert.equal((await getClient(platform, 'Cli.five')).subjectType, 'public');
    const applied = await run(cli.runUpdate, platform, ['update', 'Cli.five', '--subject-type', 'pairwise', '--yes']);
    assert.equal(applied.error, null, applied.error?.message);
    assert.equal((await getClient(platform, 'Cli.five')).subjectType, 'pairwise');
    assert.match(applied.out, /NOTE: existing grants keep their current subject/);
    assert.match(applied.out, /acknowledge it, at their next consent \(public to pairwise\)/);
    assert.ok((await getClient(platform, 'Cli.five')).updatedAt >= before.updatedAt);
    // App-account rows have no subject type.
    await persistClient(platform, { clientId: 'appacct', redirectUris: [REDIRECT], grantTypes: ['authorization_code'], scope: [] });
    const app = await run(cli.runUpdate, platform, ['update', 'appacct', '--subject-type', 'public']);
    assert.equal(app.error?.message, 'update: --subject-type applies to registry clients only');
  });

  it('[OCLI6] a legacy row without subject type: show trailer, boot WARN, read as public, update refused without the flag, suspend works', async () => {
    const platform = fakePlatform();
    await setClient(platform, {
      clientId: 'Cli.legacy',
      kind: 'registry',
      redirectUris: [REDIRECT],
      grantTypes: ['authorization_code'],
      tokenEndpointAuthMethod: 'none',
      scope: ['read/a'],
      allowedAudiences: [AUD],
      updatedAt: 1,
    });
    const shown = await run((p, a) => cli.runShow(p, a, getClient, () => ''), platform, ['show', 'Cli.legacy']);
    assert.match(shown.out, /subjectType: unset, reads as public \(set it with update --subject-type\)/);
    assert.equal(await checkRegistryClients(platform), 1);
    const loc = await authorizeAs(platform, 'Cli.legacy');
    assert.equal(loc.origin + loc.pathname, CONSENT_URL, loc.href);
    const upd = await run(cli.runUpdate, platform, ['update', 'Cli.legacy', '--name', 'Legacy']);
    assert.equal(upd.error?.message, 'update: this client has no subject type; pass --subject-type public|pairwise');
    const sus = await run(cli.runSetStatus, platform, ['suspend', 'Cli.legacy']);
    assert.equal(sus.error, null, sus.error?.message);
    assert.equal((await getClient(platform, 'Cli.legacy')).status, 'suspended');
    // Repaired on first touch: public is no change of mode, no --yes needed.
    await run(cli.runSetStatus, platform, ['resume', 'Cli.legacy']);
    const repaired = await run(cli.runUpdate, platform, ['update', 'Cli.legacy', '--subject-type', 'public']);
    assert.equal(repaired.error, null, repaired.error?.message);
    assert.equal((await getClient(platform, 'Cli.legacy')).subjectType, 'public');
  });

  it('[OCLI7] list: kind, status and subject type per client, "-" where none', async () => {
    const platform = fakePlatform();
    await run(cli.runCreateRegistry, platform, createArgs('Cli.pub', ['--subject-type', 'public']));
    await run(cli.runCreateRegistry, platform, createArgs('Cli.pw', ['--subject-type', 'pairwise']));
    await persistClient(platform, { clientId: 'appacct', redirectUris: [REDIRECT], grantTypes: ['authorization_code'], scope: [] });
    await run(cli.runSetStatus, platform, ['suspend', 'Cli.pw']);
    const r = await run((p) => cli.runList(p, getClient), platform, ['list']);
    const lines = r.out.split('\n').sort();
    assert.deepEqual(lines, [
      'Cli.pub  registry  active  public',
      'Cli.pw  registry  suspended  pairwise',
      'appacct  app-account  active  -',
    ]);
  });

  it('[OCLI8] update applies the descriptive registry flags as create-registry parses them; "none" clears them', async () => {
    const platform = fakePlatform();
    await run(cli.runCreateRegistry, platform, createArgs('Cli.eight', ['--subject-type', 'public', '--contact', 'a@example.com', '--extra', 'k=1']));
    const r = await run(cli.runUpdate, platform, ['update', 'Cli.eight',
      '--policy-uri', 'https://app.example.com/policy', '--tos-uri', 'https://app.example.com/tos',
      '--contact', 'b@example.com', '--contact', 'c@example.com',
      '--extra', 'flag=true', '--extra', 'n=42', '--extra', 's=text',
      '--launch-type', 'standalone']);
    assert.equal(r.error, null, r.error?.message);
    assert.match(r.out, /client updated/);
    let row = await getClient(platform, 'Cli.eight');
    assert.equal(row.policyUri, 'https://app.example.com/policy');
    assert.equal(row.tosUri, 'https://app.example.com/tos');
    assert.deepEqual(row.contacts, ['b@example.com', 'c@example.com']);
    assert.deepEqual(row.tokenResponseExtras, { flag: true, n: 42, s: 'text' });
    assert.deepEqual(row.launchTypes, ['standalone']);
    // The same values again: nothing written.
    const again = await run(cli.runUpdate, platform, ['update', 'Cli.eight', '--tos-uri', 'https://app.example.com/tos', '--launch-type', 'standalone']);
    assert.match(again.out, /client unchanged/);
    // A malformed --extra is refused with the create-registry message, row kept.
    const bad = await run(cli.runUpdate, platform, ['update', 'Cli.eight', '--extra', 'novalue']);
    assert.equal(bad.error?.message, 'update: --extra expects key=value, got "novalue"');
    assert.deepEqual((await getClient(platform, 'Cli.eight')).tokenResponseExtras, { flag: true, n: 42, s: 'text' });
    const cleared = await run(cli.runUpdate, platform, ['update', 'Cli.eight',
      '--policy-uri', 'none', '--tos-uri', 'none', '--contact', 'none', '--extra', 'none', '--launch-type', 'none']);
    assert.equal(cleared.error, null, cleared.error?.message);
    row = await getClient(platform, 'Cli.eight');
    assert.equal(row.policyUri, undefined);
    assert.equal(row.tosUri, undefined);
    assert.deepEqual(row.contacts, []);
    assert.deepEqual(row.tokenResponseExtras, {});
    assert.deepEqual(row.launchTypes, []);
  });

  it('[OCLI9] --scope splits space-separated tokens on update, as on create-registry', async () => {
    const platform = fakePlatform();
    await run(cli.runCreateRegistry, platform, createArgs('Cli.nine', ['--subject-type', 'public', '--scope', 'read/b  read/c']));
    assert.deepEqual((await getClient(platform, 'Cli.nine')).scope, ['read/a', 'read/b', 'read/c']);
    const r = await run(cli.runUpdate, platform, ['update', 'Cli.nine', '--scope', 'read/x read/y', '--scope', 'read/z']);
    assert.equal(r.error, null, r.error?.message);
    assert.deepEqual((await getClient(platform, 'Cli.nine')).scope, ['read/x', 'read/y', 'read/z']);
    await persistClient(platform, { clientId: 'appacct', redirectUris: [REDIRECT], grantTypes: ['authorization_code'], scope: [] });
    await run(cli.runUpdate, platform, ['update', 'appacct', '--scope', 'openid offline_access']);
    assert.deepEqual((await getClient(platform, 'appacct')).scope, ['openid', 'offline_access']);
  });

  it('[OCLI10] an unknown flag, a value flag given bare, or a registry flag on an app-account client: refused, nothing written', async () => {
    const platform = fakePlatform();
    await run(cli.runCreateRegistry, platform, createArgs('Cli.ten', ['--subject-type', 'public']));
    const before = await getClient(platform, 'Cli.ten');
    const typo = await run(cli.runUpdate, platform, ['update', 'Cli.ten', '--polcy-uri', 'https://app.example.com/p']);
    assert.equal(typo.error?.message, 'update: unknown flag --polcy-uri');
    const bare = await run(cli.runUpdate, platform, ['update', 'Cli.ten', '--policy-uri']);
    assert.equal(bare.error?.message, 'update: --policy-uri requires a value');
    const bareName = await run(cli.runUpdate, platform, ['update', 'Cli.ten', '--name']);
    assert.equal(bareName.error?.message, 'update: --name requires a value');
    assert.deepEqual(await getClient(platform, 'Cli.ten'), before);
    const created = await run(cli.runCreateRegistry, platform, createArgs('Cli.ten2', ['--subject-type', 'public', '--launch', 'x']));
    assert.equal(created.error?.message, 'create-registry: unknown flag --launch');
    assert.equal(await getClient(platform, 'Cli.ten2'), null);
    await persistClient(platform, { clientId: 'appacct', redirectUris: [REDIRECT], grantTypes: ['authorization_code'], scope: [] });
    for (const flag of ['--policy-uri', '--tos-uri', '--contact', '--extra', '--launch-type', '--auth-method']) {
      const r = await run(cli.runUpdate, platform, ['update', 'appacct', flag, 'k=v']);
      assert.equal(r.error?.message, 'update: ' + flag + ' applies to registry clients only');
    }
  });

  it('[OCLI11] update --auth-method: the credentials follow the method, a new secret is shown once, none needs --yes', async () => {
    const { generateKeyPairSync } = require('node:crypto');
    const { kty, crv, x, y } = generateKeyPairSync('ec', { namedCurve: 'P-256' }).publicKey.export({ format: 'jwk' });
    const jwks = JSON.stringify({ keys: [{ kty, crv, x, y }] });
    const platform = fakePlatform();
    // create-registry: a key set goes with private_key_jwt only, nothing written otherwise.
    for (const method of ['none', 'client_secret_basic']) {
      const c = await run(cli.runCreateRegistry, platform, createArgs('Cli.auth.k', ['--subject-type', 'public', '--auth-method', method, '--jwks-json', jwks]));
      assert.equal(c.error?.message, 'create-registry: --jwks-file / --jwks-json / --jwks-uri go with --auth-method private_key_jwt (this client uses ' + method + ')');
      assert.doesNotMatch(c.out, /client_secret:/);
      assert.equal(await getClient(platform, 'Cli.auth.k'), null);
    }
    await run(cli.runCreateRegistry, platform, createArgs('Cli.auth', ['--subject-type', 'public']));
    // A key set goes with private_key_jwt only.
    const stray = await run(cli.runUpdate, platform, ['update', 'Cli.auth', '--jwks-json', jwks]);
    assert.equal(stray.error?.message, 'update: --jwks-file / --jwks-json / --jwks-uri go with --auth-method private_key_jwt (this client uses none)');
    const noKeys = await run(cli.runUpdate, platform, ['update', 'Cli.auth', '--auth-method', 'private_key_jwt']);
    assert.equal(noKeys.error?.message, 'update: --auth-method private_key_jwt needs --jwks-file, --jwks-json or --jwks-uri');
    const badMethod = await run(cli.runUpdate, platform, ['update', 'Cli.auth', '--auth-method', 'client_secret_post']);
    assert.equal(badMethod.error?.message, 'update: --auth-method must be none, client_secret_basic or private_key_jwt');
    // none -> client_secret_basic: a secret minted, printed once, its hash stored.
    const toSecret = await run(cli.runUpdate, platform, ['update', 'Cli.auth', '--auth-method', 'client_secret_basic']);
    assert.equal(toSecret.error, null, toSecret.error?.message);
    assert.match(toSecret.out, /auth method: {3}client_secret_basic \(was none\)/);
    assert.match(toSecret.out, /client_secret: \S+\n {5}\(shown once: store it now\)/);
    let row = await getClient(platform, 'Cli.auth');
    assert.equal(row.tokenEndpointAuthMethod, 'client_secret_basic');
    // The secret printed is the one stored.
    const printed = toSecret.out.match(/client_secret: (\S+)/)[1];
    assert.equal(await verifySecret(printed, row.clientSecretHash), true);
    // The same method again rotates nothing.
    const same = await run(cli.runUpdate, platform, ['update', 'Cli.auth', '--auth-method', 'client_secret_basic']);
    assert.match(same.out, /client unchanged/);
    assert.equal((await getClient(platform, 'Cli.auth')).clientSecretHash, row.clientSecretHash);
    // -> private_key_jwt: the secret is dropped.
    const toJwt = await run(cli.runUpdate, platform, ['update', 'Cli.auth', '--auth-method', 'private_key_jwt', '--jwks-json', jwks]);
    assert.equal(toJwt.error, null, toJwt.error?.message);
    row = await getClient(platform, 'Cli.auth');
    assert.equal(row.tokenEndpointAuthMethod, 'private_key_jwt');
    assert.equal(row.clientSecretHash, undefined);
    assert.equal(row.jwks.keys.length, 1);
    // -> none: refused without --yes (row unchanged), applied with it, every credential dropped.
    const refused = await run(cli.runUpdate, platform, ['update', 'Cli.auth', '--auth-method', 'none']);
    assert.equal(refused.error?.message, 'update: changing the client authentication of "Cli.auth" from private_key_jwt to none ' +
      'makes it a public client (its refresh tokens are then redeemed without client authentication); re-run with --yes');
    assert.equal((await getClient(platform, 'Cli.auth')).tokenEndpointAuthMethod, 'private_key_jwt');
    const toNone = await run(cli.runUpdate, platform, ['update', 'Cli.auth', '--auth-method', 'none', '--yes']);
    assert.equal(toNone.error, null, toNone.error?.message);
    row = await getClient(platform, 'Cli.auth');
    assert.equal(row.tokenEndpointAuthMethod, 'none');
    assert.equal(row.clientSecretHash, undefined);
    assert.equal(row.jwks, undefined);
  });

  it('[OCLI12] rotate-secret: refused on a client whose auth method uses no secret, nothing written; works on a secret client', async () => {
    const { generateKeyPairSync } = require('node:crypto');
    const { kty, crv, x, y } = generateKeyPairSync('ec', { namedCurve: 'P-256' }).publicKey.export({ format: 'jwk' });
    const platform = fakePlatform();
    await run(cli.runCreateRegistry, platform, createArgs('Cli.rs.none', ['--subject-type', 'public']));
    await run(cli.runCreateRegistry, platform, createArgs('Cli.rs.jwt', ['--subject-type', 'public', '--auth-method', 'private_key_jwt',
      '--jwks-json', JSON.stringify({ keys: [{ kty, crv, x, y }] })]));
    for (const [id, method] of [['Cli.rs.none', 'none'], ['Cli.rs.jwt', 'private_key_jwt']]) {
      const before = await getClient(platform, id);
      const r = await run(cli.runRotateSecret, platform, ['rotate-secret', id]);
      assert.equal(r.error?.message, 'rotate-secret: client "' + id + '" authenticates with ' + method + ', which uses no secret; ' +
        'to switch it to a secret, run update ' + id + ' --auth-method client_secret_basic');
      assert.doesNotMatch(r.out, /client_secret:/);
      assert.deepEqual(await getClient(platform, id), before);
    }
    await run(cli.runCreateRegistry, platform, createArgs('Cli.rs.sec', ['--subject-type', 'public', '--auth-method', 'client_secret_basic']));
    const first = (await getClient(platform, 'Cli.rs.sec')).clientSecretHash;
    const ok = await run(cli.runRotateSecret, platform, ['rotate-secret', 'Cli.rs.sec']);
    assert.equal(ok.error, null, ok.error?.message);
    const rotated = (await getClient(platform, 'Cli.rs.sec')).clientSecretHash;
    assert.notEqual(rotated, first);
    // The secret printed is the one stored.
    assert.equal(await verifySecret(ok.out.match(/client_secret: (\S+)/)[1], rotated), true);
    // An app-account row (no auth method stored) works as before.
    await persistClient(platform, { clientId: 'appacct', redirectUris: [REDIRECT], grantTypes: ['authorization_code'], scope: [] });
    const app = await run(cli.runRotateSecret, platform, ['rotate-secret', 'appacct']);
    assert.equal(app.error, null, app.error?.message);
    assert.equal(typeof (await getClient(platform, 'appacct')).clientSecretHash, 'string');
  });

  it('[OCLI13] update echoes the audience, insecure-redirect and feature flags it applies', async () => {
    const platform = fakePlatform();
    await run(cli.runCreateRegistry, platform, createArgs('Cli.echo', ['--subject-type', 'public']));
    const any = await run(cli.runUpdate, platform, ['update', 'Cli.echo', '--any-audience']);
    assert.equal(any.error, null, any.error?.message);
    assert.match(any.out, /audiences: {5}\(any audience\)/);
    const insecure = await run(cli.runUpdate, platform, ['update', 'Cli.echo', '--allow-insecure-redirect']);
    assert.match(insecure.out, /WARN plain-http redirect URIs allowed on non-loopback hosts/);
    const withdrawn = await run(cli.runUpdate, platform, ['update', 'Cli.echo', '--allow-insecure-redirect', 'false']);
    assert.match(withdrawn.out, /plain-http redirect URIs refused on non-loopback hosts/);
    const feature = await run(cli.runUpdate, platform, ['update', 'Cli.echo', '--allow-feature', 'webhooks']);
    assert.match(feature.out, /features forbidden on its grants: secretSharing, accessCreation \(allowed: webhooks\)/);
    const back = await run(cli.runUpdate, platform, ['update', 'Cli.echo', '--audience', AUD]);
    assert.match(back.out, new RegExp('audiences: {5}' + AUD.replace(/[.]/g, '\\.')));
    // Flags not given are not echoed.
    const name = await run(cli.runUpdate, platform, ['update', 'Cli.echo', '--name', 'Echo']);
    assert.doesNotMatch(name.out, /audiences:|plain-http|features forbidden/);
  });

  it('[OCLI14] show never prints the secret hash, only that a secret is set', async () => {
    const platform = fakePlatform();
    await run(cli.runCreateRegistry, platform, createArgs('Cli.show', ['--subject-type', 'public', '--auth-method', 'client_secret_basic']));
    const hash = (await getClient(platform, 'Cli.show')).clientSecretHash;
    const shown = await run((p, a) => cli.runShow(p, a, getClient, () => ''), platform, ['show', 'Cli.show']);
    assert.match(shown.out, /"clientSecretHash": "\(set\)"/);
    assert.doesNotMatch(shown.out, /\$2[aby]\$/);
    assert.equal(shown.out.includes(hash.slice(7, 20)), false);
    // A client without a secret shows no such field.
    await run(cli.runCreateRegistry, platform, createArgs('Cli.show2', ['--subject-type', 'public']));
    const plain = await run((p, a) => cli.runShow(p, a, getClient, () => ''), platform, ['show', 'Cli.show2']);
    assert.doesNotMatch(plain.out, /clientSecretHash/);
  });

  it('[OCLI15] create (app-account) refuses an unknown flag and a value flag given bare, before any lookup', async () => {
    const platform = fakePlatform();
    const typo = await run(cli.runCreate, platform, ['create', 'someone', '--redirect-uri', REDIRECT, '--scopes', 'x']);
    assert.equal(typo.error?.message, 'create: unknown flag --scopes');
    const registryOnly = await run(cli.runCreate, platform, ['create', 'someone', '--redirect-uri', REDIRECT, '--auth-method', 'client_secret_basic']);
    assert.equal(registryOnly.error?.message, 'create: unknown flag --auth-method');
    const bare = await run(cli.runCreate, platform, ['create', 'someone', '--redirect-uri']);
    assert.equal(bare.error?.message, 'create: --redirect-uri requires a value');
    assert.deepEqual(await platform.listPlatformKvKeys(''), []);
  });

  it('[OCLI16] --can-introspect: confidential clients only, on create-registry and update; "false" withdraws it', async () => {
    const platform = fakePlatform();
    const pub = await run(cli.runCreateRegistry, platform, createArgs('Cli.rs.pub', ['--subject-type', 'public', '--can-introspect']));
    assert.match(pub.error?.message ?? '', /--can-introspect needs a confidential client/);
    assert.equal(await getClient(platform, 'Cli.rs.pub'), null);
    const rs = await run(cli.runCreateRegistry, platform, createArgs('Cli.rs', ['--subject-type', 'public', '--auth-method', 'client_secret_basic', '--can-introspect']));
    assert.equal(rs.error, null, rs.error?.message);
    assert.match(rs.out, /introspection: allowed/);
    assert.equal((await getClient(platform, 'Cli.rs')).canIntrospect, true);
    const off = await run(cli.runUpdate, platform, ['update', 'Cli.rs', '--can-introspect', 'false']);
    assert.equal(off.error, null, off.error?.message);
    assert.equal((await getClient(platform, 'Cli.rs')).canIntrospect, undefined);
    const on = await run(cli.runUpdate, platform, ['update', 'Cli.rs', '--can-introspect']);
    assert.equal(on.error, null, on.error?.message);
    assert.equal((await getClient(platform, 'Cli.rs')).canIntrospect, true);
    await run(cli.runCreateRegistry, platform, createArgs('Cli.rs.none', ['--subject-type', 'public']));
    const refused = await run(cli.runUpdate, platform, ['update', 'Cli.rs.none', '--can-introspect']);
    assert.match(refused.error?.message ?? '', /--can-introspect needs a confidential client/);
    assert.equal((await getClient(platform, 'Cli.rs.none')).canIntrospect, undefined);
    const bad = await run(cli.runUpdate, platform, ['update', 'Cli.rs', '--can-introspect', 'maybe']);
    assert.match(bad.error?.message ?? '', /--can-introspect takes no value, or true \/ false/);
    // Made public with the role still set: kept (refused at run time), and said so.
    const toNone = await run(cli.runUpdate, platform, ['update', 'Cli.rs', '--auth-method', 'none', '--yes']);
    assert.equal(toNone.error, null, toNone.error?.message);
    assert.match(toNone.out, /WARN introspection role kept on a public client/);
    const silent = await run(cli.runUpdate, platform, ['update', 'Cli.rs', '--can-introspect', 'false']);
    assert.doesNotMatch(silent.out, /WARN introspection/);
  });

  it('[OCLI17] private_key_jwt: a two-key file (RS384 + ES384) with both algorithms pinned, lifetimes, offline access; show and update', async () => {
    const fs = require('node:fs');
    const os = require('node:os');
    const path = require('node:path');
    const { generateKeyPairSync } = require('node:crypto');
    const rsa = generateKeyPairSync('rsa', { modulusLength: 2048 }).publicKey.export({ format: 'jwk' });
    const ec = generateKeyPairSync('ec', { namedCurve: 'P-384' }).publicKey.export({ format: 'jwk' });
    const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'ocli17-')), 'jwks.json');
    fs.writeFileSync(file, JSON.stringify({ keys: [{ ...rsa, kid: 'rsa-1', alg: 'RS384', use: 'sig' }, { ...ec, kid: 'ec-1', alg: 'ES384' }] }));
    const platform = fakePlatform();
    const c = await run(cli.runCreateRegistry, platform, createArgs('Cli.pkj', [
      '--subject-type', 'public', '--auth-method', 'private_key_jwt', '--jwks-file', file,
      '--signing-alg', 'RS384', '--signing-alg', 'ES384', '--access-token-ttl', '300', '--refresh-token-ttl', '3600', '--offline-access', 'true',
    ]));
    assert.equal(c.error, null, c.error?.message);
    assert.match(c.out, /keys: {10}inline, 2 key\(s\); algorithms: RS384, ES384/);
    assert.match(c.out, /lifetimes: {5}access token ttl 300 s, refresh token ttl 3600 s/);
    let row = await getClient(platform, 'Cli.pkj');
    assert.deepEqual(row.tokenEndpointAuthSigningAlgs, ['RS384', 'ES384']);
    assert.deepEqual(row.jwks.keys.map((k) => [k.kid, k.kty, k.alg]), [['rsa-1', 'RSA', 'RS384'], ['ec-1', 'EC', 'ES384']]);
    assert.equal(row.accessTokenTTL, 300);
    assert.equal(row.offlineAccessAllowed, undefined, 'true is the default: not stored');
    const shown = await run((p, a) => cli.runShow(p, a, getClient, () => 'TP'), platform, ['show', 'Cli.pkj']);
    assert.match(shown.out, /"kid": "rsa-1",\n\s+"kty": "RSA",\n\s+"alg": "RS384",\n\s+"thumbprint": "TP"/);
    assert.match(shown.out, /"tokenEndpointAuthSigningAlgs"/);
    assert.match(shown.out, /assertion algorithms: RS384, ES384 \(pinned\)/);
    assert.doesNotMatch(shown.out, new RegExp(rsa.n.slice(0, 40)));
    // Refused: a pinned alg with no key, an unknown alg, a key set by reference over plain http, two key sources.
    const noKey = await run(cli.runUpdate, platform, ['update', 'Cli.pkj', '--signing-alg', 'ES256']);
    assert.match(noKey.error?.message ?? '', /no key of the jwks fits ES256/);
    const unknown = await run(cli.runUpdate, platform, ['update', 'Cli.pkj', '--signing-alg', 'RS256']);
    assert.match(unknown.error?.message ?? '', /--signing-alg must be one of ES256, ES384, RS384/);
    const http = await run(cli.runUpdate, platform, ['update', 'Cli.pkj', '--jwks-uri', 'http://keys.example.com/jwks']);
    assert.match(http.error?.message ?? '', /https/);
    const both = await run(cli.runUpdate, platform, ['update', 'Cli.pkj', '--jwks-uri', 'https://keys.example.com/jwks', '--jwks-file', file]);
    assert.match(both.error?.message ?? '', /--jwks-uri excludes/);
    // By reference: the inline set goes; then the pin, a lifetime, and offline access change.
    const byRef = await run(cli.runUpdate, platform, ['update', 'Cli.pkj', '--jwks-uri', 'https://keys.example.com/jwks', '--signing-alg', 'none',
      '--access-token-ttl', 'none', '--offline-access', 'false']);
    assert.equal(byRef.error, null, byRef.error?.message);
    assert.match(byRef.out, /offline access: withheld/);
    row = await getClient(platform, 'Cli.pkj');
    assert.equal(row.jwksUri, 'https://keys.example.com/jwks');
    assert.equal(row.jwks, undefined);
    assert.equal(row.tokenEndpointAuthSigningAlgs, undefined);
    assert.equal(row.accessTokenTTL, undefined);
    assert.equal(row.refreshTokenTTL, 3600);
    assert.equal(row.offlineAccessAllowed, false);
    // Moving to a secret drops the key reference.
    const toSecret = await run(cli.runUpdate, platform, ['update', 'Cli.pkj', '--auth-method', 'client_secret_basic']);
    assert.equal(toSecret.error, null, toSecret.error?.message);
    row = await getClient(platform, 'Cli.pkj');
    assert.equal(row.jwksUri, undefined);
    // Lifetimes: refused unless positive integers.
    const bad = await run(cli.runUpdate, platform, ['update', 'Cli.pkj', '--access-token-ttl', '-5']);
    assert.match(bad.error?.message ?? '', /--access-token-ttl takes a positive number of seconds/);
    // A key set given to a non-private_key_jwt registration is refused.
    const stray = await run(cli.runCreateRegistry, platform, createArgs('Cli.pkj2', ['--subject-type', 'public', '--signing-alg', 'ES384']));
    assert.match(stray.error?.message ?? '', /--signing-alg goes with --auth-method private_key_jwt/);
  });

  it('[OCLI18] rotate-secret --previous-valid-for: the replaced secret stays valid for the window, at most 30 days; without it, refused at once', async () => {
    const platform = fakePlatform();
    await run(cli.runCreateRegistry, platform, createArgs('Cli.rot', ['--subject-type', 'public', '--auth-method', 'client_secret_basic']));
    const first = (await getClient(platform, 'Cli.rot')).clientSecretHash;
    const tooLong = await run(cli.runRotateSecret, platform, ['rotate-secret', 'Cli.rot', '--previous-valid-for', String(31 * 24 * 3600)]);
    assert.match(tooLong.error?.message ?? '', /30 days/);
    const bad = await run(cli.runRotateSecret, platform, ['rotate-secret', 'Cli.rot', '--previous-valid-for', '1h']);
    assert.match(bad.error?.message ?? '', /number of seconds/);
    const typo = await run(cli.runRotateSecret, platform, ['rotate-secret', 'Cli.rot', '--grace', '60']);
    assert.match(typo.error?.message ?? '', /unknown flag --grace/);
    assert.equal((await getClient(platform, 'Cli.rot')).clientSecretHash, first, 'nothing written');
    const before = Date.now();
    const kept = await run(cli.runRotateSecret, platform, ['rotate-secret', 'Cli.rot', '--previous-valid-for', '86400']);
    assert.equal(kept.error, null, kept.error?.message);
    assert.match(kept.out, /previous secret is still accepted until/);
    let row = await getClient(platform, 'Cli.rot');
    assert.equal(row.previousSecretHash, first);
    assert.ok(row.previousSecretExpiresAt >= before + 86400 * 1000 && row.previousSecretExpiresAt <= Date.now() + 86400 * 1000);
    const shown = await run((p, a) => cli.runShow(p, a, getClient, () => ''), platform, ['show', 'Cli.rot']);
    assert.match(shown.out, /"previousSecretHash": "\(set\)"/);
    assert.match(shown.out, /previous secret: accepted until/);
    assert.doesNotMatch(shown.out, /\$2[aby]\$/);
    // Without the flag: no window, the replaced secret (and the older one) refused at once.
    const now = await run(cli.runRotateSecret, platform, ['rotate-secret', 'Cli.rot']);
    assert.equal(now.error, null, now.error?.message);
    assert.match(now.out, /previous secret is refused from now on/);
    row = await getClient(platform, 'Cli.rot');
    assert.equal(row.previousSecretHash, undefined);
    assert.equal(row.previousSecretExpiresAt, undefined);
  });

  describe('[OCLIV] vetting status, registry profile, purge', () => {
    let saved;
    before(() => {
      saved = { ...cli.cliEnv };
      cli.cliEnv.logoHosts = async () => ['logos.example.com'];
      cli.cliEnv.platformRegions = async () => ['eu', 'us'];
    });
    after(() => { Object.assign(cli.cliEnv, saved); });

    const statusOf = async (platform, id) => (await getClient(platform, id)).status;

    it('[OCLI19] a change of redirect URIs, keys or scope moves an active registry client to review; --approve approves; the trail records each step', async () => {
      const platform = fakePlatform();
      await run(cli.runCreateRegistry, platform, createArgs('Cli.vet', ['--subject-type', 'public']));
      // A change the client was not vetted on: no review.
      let r = await run(cli.runUpdate, platform, ['update', 'Cli.vet', '--name', 'Renamed']);
      assert.equal(r.error, null, r.error?.message);
      assert.equal(await statusOf(platform, 'Cli.vet'), 'active');
      assert.equal((await getClient(platform, 'Cli.vet')).statusLog, undefined);
      // A new redirect URI: review, refused at /authorize.
      r = await run(cli.runUpdate, platform, ['update', 'Cli.vet', '--redirect-uri', REDIRECT, '--redirect-uri', REDIRECT + '2']);
      assert.equal(r.error, null, r.error?.message);
      assert.match(r.out, /status: {8}review \(redirectUris changed\)/);
      assert.match(r.out, /update Cli\.vet --approve/);
      let row = await getClient(platform, 'Cli.vet');
      assert.equal(row.status, 'review');
      assert.deepEqual(row.statusLog.map((e) => [e.from, e.to, e.reason, e.fields]), [['active', 'review', 'review', ['redirectUris']]]);
      assert.equal(typeof row.statusLog[0].by, 'string');
      // Never redirected: the registered redirect URIs are the unvetted change.
      const refused = await authorizeRes(platform, 'Cli.vet');
      assert.equal(refused.statusCode, 400);
      assert.equal(refused.headers.location, undefined);
      assert.match(refused.body, /this client is under review/);
      const shown = await run((p, a) => cli.runShow(p, a, getClient, () => ''), platform, ['show', 'Cli.vet']);
      assert.match(shown.out, /status: review since .* \(redirectUris changed\): refused at \/authorize/);
      // resume does not approve.
      r = await run(cli.runSetStatus, platform, ['resume', 'Cli.vet']);
      assert.match(r.error?.message ?? '', /under review .* update Cli\.vet --approve/);
      // A further change while under review is recorded, the status stays.
      r = await run(cli.runUpdate, platform, ['update', 'Cli.vet', '--scope', 'read/a read/b']);
      assert.equal(await statusOf(platform, 'Cli.vet'), 'review');
      // Approved.
      r = await run(cli.runUpdate, platform, ['update', 'Cli.vet', '--approve']);
      assert.equal(r.error, null, r.error?.message);
      assert.match(r.out, /status: {8}active \(approved; no change\)/);
      assert.equal(await statusOf(platform, 'Cli.vet'), 'active');
      const ok = await authorizeAs(platform, 'Cli.vet');
      assert.equal(ok.origin + ok.pathname, CONSENT_URL, ok.href);
      // A change approved in the same command: stays active, recorded.
      r = await run(cli.runUpdate, platform, ['update', 'Cli.vet', '--scope', 'read/a', '--approve']);
      assert.equal(r.error, null, r.error?.message);
      row = await getClient(platform, 'Cli.vet');
      assert.equal(row.status, 'active');
      assert.deepEqual(row.statusLog.map((e) => [e.from, e.to, e.reason, e.fields ?? null]), [
        ['active', 'review', 'review', ['redirectUris']],
        ['review', 'review', 'review', ['scope']],
        ['review', 'active', 'approve', null],
        ['active', 'active', 'approve', ['scope']],
      ]);
      // --approve with nothing to approve: no write.
      r = await run(cli.runUpdate, platform, ['update', 'Cli.vet', '--approve']);
      assert.match(r.out, /client unchanged/);
      // A key set change (auth method switch) counts too.
      const jwk = JSON.stringify({ keys: [crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' }).publicKey.export({ format: 'jwk' })] });
      r = await run(cli.runUpdate, platform, ['update', 'Cli.vet', '--auth-method', 'private_key_jwt', '--jwks-json', jwk]);
      assert.equal(r.error, null, r.error?.message);
      assert.deepEqual((await getClient(platform, 'Cli.vet')).statusLog.at(-1).fields, ['jwks', 'tokenEndpointAuthMethod']);
      assert.equal(await statusOf(platform, 'Cli.vet'), 'review');
      // Other vetted fields: lifetimes, features, introspection, audiences.
      for (const flags of [['--access-token-ttl', '600'], ['--allow-feature', 'webhooks'], ['--audience', AUD + '/2'], ['--offline-access', 'false']]) {
        r = await run(cli.runUpdate, platform, ['update', 'Cli.vet', ...flags, '--approve']);
        assert.equal(r.error, null, flags.join(' ') + ': ' + r.error?.message);
        assert.equal((await getClient(platform, 'Cli.vet')).statusLog.at(-1).reason, 'approve', flags.join(' '));
      }
      r = await run(cli.runUpdate, platform, ['update', 'Cli.vet', '--access-token-ttl', '300']);
      assert.deepEqual((await getClient(platform, 'Cli.vet')).statusLog.at(-1).fields, ['accessTokenTTL']);
      // Not vetted: the entry ceiling and the display texts.
      r = await run(cli.runUpdate, platform, ['update', 'Cli.vet', '--approve']);
      assert.equal(await statusOf(platform, 'Cli.vet'), 'active');
      r = await run(cli.runUpdate, platform, ['update', 'Cli.vet', '--max-entries', '5', '--description', 'x']);
      assert.equal(await statusOf(platform, 'Cli.vet'), 'active');
      // Suspended: a change is recorded, the status kept; resume refuses it
      // until approved; the approval keeps the client suspended.
      r = await run(cli.runSetStatus, platform, ['suspend', 'Cli.vet']);
      assert.match(r.out, /purge-grants Cli\.vet --yes/);
      r = await run(cli.runUpdate, platform, ['update', 'Cli.vet', '--redirect-uri', REDIRECT]);
      assert.equal(r.error, null, r.error?.message);
      assert.match(r.out, /approve it with update Cli\.vet --approve before resume/);
      assert.equal(await statusOf(platform, 'Cli.vet'), 'suspended');
      r = await run(cli.runSetStatus, platform, ['resume', 'Cli.vet']);
      assert.match(r.error?.message ?? '', /changes to redirectUris of "Cli\.vet" were not approved/);
      assert.equal(await statusOf(platform, 'Cli.vet'), 'suspended');
      r = await run(cli.runUpdate, platform, ['update', 'Cli.vet', '--approve']);
      assert.equal(r.error, null, r.error?.message);
      assert.match(r.out, /status: {8}suspended \(approved; no change\): resume it/);
      assert.equal(await statusOf(platform, 'Cli.vet'), 'suspended');
      r = await run(cli.runSetStatus, platform, ['resume', 'Cli.vet']);
      assert.equal(r.error, null, r.error?.message);
      assert.equal(await statusOf(platform, 'Cli.vet'), 'active');
      assert.deepEqual((await getClient(platform, 'Cli.vet')).statusLog.slice(-4).map((e) => [e.from, e.to, e.reason]), [
        ['active', 'suspended', 'suspend'], ['suspended', 'suspended', 'review'],
        ['suspended', 'suspended', 'approve'], ['suspended', 'active', 'resume'],
      ]);
      // A client suspended while under review stays unapproved after resume is asked.
      await run(cli.runUpdate, platform, ['update', 'Cli.vet', '--scope', 'read/b']);
      await run(cli.runSetStatus, platform, ['suspend', 'Cli.vet']);
      r = await run(cli.runSetStatus, platform, ['resume', 'Cli.vet']);
      assert.match(r.error?.message ?? '', /changes to scope .* were not approved/);
      // App-account clients have no vetting status: --approve is refused.
      await persistClient(platform, { clientId: 'appacct', redirectUris: [REDIRECT], grantTypes: ['authorization_code'], scope: [] });
      r = await run(cli.runUpdate, platform, ['update', 'appacct', '--approve']);
      assert.equal(r.error?.message, 'update: --approve applies to registry clients only');
      r = await run(cli.runUpdate, platform, ['update', 'appacct', '--redirect-uri', REDIRECT + '3']);
      assert.equal(await statusOf(platform, 'appacct'), undefined);
    });

    it('[OCLI23] a change of launch types moves an active registry client to review; a narrowing prints that live grants keep what they hold, with purge-grants', async () => {
      const platform = fakePlatform();
      await run(cli.runCreateRegistry, platform, createArgs('Cli.lt', ['--subject-type', 'public', '--scope', 'read/a read/b']));
      let r = await run(cli.runUpdate, platform, ['update', 'Cli.lt', '--launch-type', 'mcp']);
      assert.equal(r.error, null, r.error?.message);
      assert.match(r.out, /status: {8}review \(launchTypes changed\)/);
      assert.doesNotMatch(r.out, /live grants/);
      let row = await getClient(platform, 'Cli.lt');
      assert.equal(row.status, 'review');
      assert.deepEqual(row.statusLog.at(-1).fields, ['launchTypes']);
      r = await run(cli.runUpdate, platform, ['update', 'Cli.lt', '--approve']);
      assert.equal(await statusOf(platform, 'Cli.lt'), 'active');
      // Removing it: review again, and live grants are not cut.
      r = await run(cli.runUpdate, platform, ['update', 'Cli.lt', '--launch-type', 'none', '--scope', 'read/a']);
      assert.equal(r.error, null, r.error?.message);
      assert.match(r.out, /status: {8}review \(scope, launchTypes changed\)/);
      assert.match(r.out, /live grants: {3}keep what they were given \(scope, launchTypes narrowed\)/);
      assert.match(r.out, /purge-grants Cli\.lt --yes/);
      row = await getClient(platform, 'Cli.lt');
      assert.deepEqual(row.launchTypes, []);
      // A widening alone prints no purge hint.
      r = await run(cli.runUpdate, platform, ['update', 'Cli.lt', '--scope', 'read/a read/c', '--approve']);
      assert.doesNotMatch(r.out, /live grants/);
    });

    it('[OCLI20] the registry profile: localized name, description, software id, entry ceiling, regions, logo on an allowed host; show; none clears', async () => {
      const platform = fakePlatform();
      let r = await run(cli.runCreateRegistry, platform, createArgs('Cli.prof', [
        '--subject-type', 'public', '--localized-name', 'en=Health app', '--localized-name', 'fr=App santé',
        '--description', 'Reads your measurements.', '--software-id', 'health-app', '--max-entries', '50',
        '--region', 'eu', '--logo-uri', 'https://logos.example.com/app.png',
      ]));
      assert.equal(r.error, null, r.error?.message);
      assert.match(r.out, /max entries: {3}50 per authorization/);
      assert.match(r.out, /regions: {7}eu/);
      let row = await getClient(platform, 'Cli.prof');
      assert.deepEqual(row.name, { en: 'Health app', fr: 'App santé' });
      assert.equal(row.description, 'Reads your measurements.');
      assert.equal(row.softwareId, 'health-app');
      assert.equal(row.maxEntries, 50);
      assert.deepEqual(row.regions, ['eu']);
      assert.equal(row.logoUri, 'https://logos.example.com/app.png');
      assert.equal(row.status, 'active');
      const shown = await run((p, a) => cli.runShow(p, a, getClient, () => ''), platform, ['show', 'Cli.prof']);
      assert.match(shown.out, /regions: eu \(refused on the cores of any other region\)/);
      assert.match(shown.out, /max entries: {3}50 per authorization/);
      assert.doesNotMatch(shown.out, /logoUri: not served/);
      // Update: a localized description replaces the text; none clears.
      r = await run(cli.runUpdate, platform, ['update', 'Cli.prof', '--localized-description', 'en=Reads.', '--localized-description', 'de=Liest.',
        '--max-entries', 'none', '--region', 'none', '--software-id', 'none', '--logo-uri', 'none', '--localized-name', 'none']);
      assert.equal(r.error, null, r.error?.message);
      assert.match(r.out, /max entries: {3}1000 per authorization \(platform bound\)/);
      row = await getClient(platform, 'Cli.prof');
      assert.deepEqual(row.description, { en: 'Reads.', de: 'Liest.' });
      for (const k of ['maxEntries', 'regions', 'softwareId', 'logoUri', 'name']) assert.equal(row[k], undefined, k);
      // None of these is vetted: still active.
      assert.equal(row.status, 'active');
      // A logo the allow-list no longer names: show says it is not served.
      await setClient(platform, { ...row, logoUri: 'https://old.example.com/a.png' });
      assert.match((await run((p, a) => cli.runShow(p, a, getClient, () => ''), platform, ['show', 'Cli.prof'])).out, /logoUri: not served/);
      // Refusals, nothing written.
      const refused = [
        [['--logo-uri', 'https://evil.example.com/a.png'], /--logo-uri: host "evil.example.com" is not in oauth.logoHosts \(logos.example.com\)/],
        [['--logo-uri', 'http://logos.example.com/a.png'], /--logo-uri: .* must be an https URL/],
        [['--region', 'mars'], /--region mars: not a region of this platform \(eu, us\)/],
        [['--description', 'x', '--localized-description', 'en=x'], /exclude each other/],
        [['--max-entries', '0'], /--max-entries takes a positive number/],
        [['--max-entries', '5000'], /maxEntries must be an integer from 1 to 1000/],
        [['--localized-name', 'en=a', '--localized-name', 'en=b'], /gives "en" twice/],
        [['--localized-name', 'english'], /expects <language>=<text>/],
        [['--localized-name', 'english=x'], /"english" is not a language code/],
        [['--region'], /--region requires a value/],
      ];
      const before = JSON.stringify(await getClient(platform, 'Cli.prof'));
      for (const [flags, re] of refused) {
        r = await run(cli.runUpdate, platform, ['update', 'Cli.prof', ...flags]);
        assert.match(r.error?.message ?? '(no error)', re, flags.join(' '));
      }
      assert.equal(JSON.stringify(await getClient(platform, 'Cli.prof')), before, 'nothing written');
      // App-account clients: regions and an allowed logo, no registry profile.
      await persistClient(platform, { clientId: 'appacct2', redirectUris: [REDIRECT], grantTypes: ['authorization_code'], scope: [] });
      r = await run(cli.runUpdate, platform, ['update', 'appacct2', '--region', 'us', '--logo-uri', 'https://logos.example.com/b.png']);
      assert.equal(r.error, null, r.error?.message);
      assert.deepEqual((await getClient(platform, 'appacct2')).regions, ['us']);
      r = await run(cli.runUpdate, platform, ['update', 'appacct2', '--software-id', 'x']);
      assert.equal(r.error?.message, 'update: --software-id applies to registry clients only');
    });

    it('[OCLI22] a registry row stored with an http logo stays writable: update and rotate-secret drop the logo and say so', async () => {
      const platform = fakePlatform();
      await run(cli.runCreateRegistry, platform, createArgs('Cli.oldlogo', ['--subject-type', 'public', '--auth-method', 'client_secret_basic']));
      const row = await getClient(platform, 'Cli.oldlogo');
      await setClient(platform, { ...row, logoUri: 'http://logos.example.com/old.png' });
      let r = await run(cli.runUpdate, platform, ['update', 'Cli.oldlogo', '--name', 'Renamed']);
      assert.equal(r.error, null, r.error?.message);
      assert.match(r.out, /logoUri cleared: http:\/\/logos\.example\.com\/old\.png \(not https: never served\)/);
      assert.equal((await getClient(platform, 'Cli.oldlogo')).logoUri, undefined);
      await setClient(platform, { ...(await getClient(platform, 'Cli.oldlogo')), logoUri: 'http://logos.example.com/old.png' });
      r = await run(cli.runRotateSecret, platform, ['rotate-secret', 'Cli.oldlogo']);
      assert.equal(r.error, null, r.error?.message);
      assert.match(r.out, /logoUri cleared/);
      assert.equal((await getClient(platform, 'Cli.oldlogo')).logoUri, undefined);
    });

    it('[OCLI21] purge-grants needs --yes, runs this core\'s purge and prints the counts; revoke points to it', async () => {
      const platform = fakePlatform();
      const asked = [];
      const purge = async (id) => { asked.push(id); return { accounts: 2, grants: 2, sessions: 3, accesses: 6, refreshTokens: 1 }; };
      const exec = async (argv) => {
        const args = cli.parseArgs(argv);
        const lines = [];
        const log = console.log;
        console.log = (...a) => { lines.push(a.join(' ')); };
        try { await cli.runPurgeGrants(platform, args, purge); return { out: lines.join('\n'), error: null }; } catch (error) { return { out: lines.join('\n'), error }; } finally { console.log = log; }
      };
      let r = await exec(['purge-grants', 'Cli.gone']);
      assert.match(r.error?.message ?? '', /refuses to run without --yes/);
      r = await exec(['purge-grants', 'Cli.gone', '--yes', '--all']);
      assert.match(r.error?.message ?? '', /unknown flag --all/);
      r = await exec(['purge-grants', '--yes']);
      assert.match(r.error?.message ?? '', /<clientId> required/);
      assert.deepEqual(asked, []);
      r = await exec(['purge-grants', 'Cli.gone', '--yes']);
      assert.equal(r.error, null, r.error?.message);
      assert.deepEqual(asked, ['Cli.gone']);
      assert.match(r.out, /grants deleted: {8}2/);
      assert.match(r.out, /sessions deleted: {6}3/);
      assert.match(r.out, /refresh tokens ended: {2}1/);
      assert.match(r.out, /run it on every core/);
      await run(cli.runCreateRegistry, platform, createArgs('Cli.rev', ['--subject-type', 'public']));
      const lines = [];
      const log = console.log;
      console.log = (...a) => { lines.push(a.join(' ')); };
      try { await cli.runRevoke(platform, cli.parseArgs(['revoke', 'Cli.rev', '--yes']), async () => {}); } finally { console.log = log; }
      assert.match(lines.join('\n'), /purge-grants Cli\.rev --yes/);
    });
  });
});
