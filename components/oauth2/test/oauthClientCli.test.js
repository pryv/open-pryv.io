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
const cli = require('../../../bin/oauth-client.js');
const extension = require('../src/extension.ts');
const scopeGrammar = require('../src/scopeGrammar.ts');
const offerRoute = require('../src/routes/offer.ts');
const { getClient, persistClient } = require('../src/clientRegistry.ts');
const { setClient } = require('../src/storage.ts');
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
  const m = { 'service:api': 'https://core.example.com', 'auth:adminAccessKey': 'admin-key', 'oauth:consentUrl': CONSENT_URL, 'core:id': 'core-a' };
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
    if (fn === cli.runCreateRegistry) await fn(platform, args, persistClient, getClient);
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
  const res = { statusCode: 200, headers: {}, setHeader (k, v) { this.headers[k.toLowerCase()] = v; }, end () {} };
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
  return new URL(res.headers.location);
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
    assert.doesNotMatch(r.out, /WARN pseudonymous/);
    assert.match(r.out, /features forbidden on its grants: webhooks, secretSharing/);
  });

  it('[OCLI4] pairwise: stored, with the WARN; /authorize still refuses it', async () => {
    const platform = fakePlatform();
    const r = await run(cli.runCreateRegistry, platform, createArgs('Cli.four', ['--subject-type', 'pairwise', '--allow-feature', 'webhooks']));
    assert.equal(r.error, null, r.error?.message);
    const row = await getClient(platform, 'Cli.four');
    assert.equal(row.subjectType, 'pairwise');
    assert.deepEqual(row.allowFeatures, ['webhooks']);
    assert.match(r.out, /subject type: {2}pairwise \(always an alias\)/);
    assert.match(r.out, /WARN pseudonymous subjects are not available on this core yet: \/authorize refuses this client until a release that supports them/);
    assert.match(r.out, /features forbidden on its grants: secretSharing \(allowed: webhooks\)/);
    const loc = await authorizeAs(platform, 'Cli.four');
    assert.equal(loc.searchParams.get('error'), 'invalid_scope');
    assert.equal(loc.searchParams.get('error_description'), 'pseudonymous subjects are not available on this core');
    // An unknown feature is refused at registration.
    const bad = await run(cli.runCreateRegistry, platform, createArgs('Cli.four2', ['--subject-type', 'public', '--allow-feature', 'accessCreation']));
    assert.match(bad.error?.message ?? '', /allowFeatures may only list webhooks, secretSharing/);
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
    await run(cli.runCreateRegistry, platform, createArgs('Cli.auth', ['--subject-type', 'public']));
    // A key set goes with private_key_jwt only.
    const stray = await run(cli.runUpdate, platform, ['update', 'Cli.auth', '--jwks-json', jwks]);
    assert.equal(stray.error?.message, 'update: --jwks-file / --jwks-json go with --auth-method private_key_jwt (this client uses none)');
    const noKeys = await run(cli.runUpdate, platform, ['update', 'Cli.auth', '--auth-method', 'private_key_jwt']);
    assert.equal(noKeys.error?.message, 'update: --auth-method private_key_jwt needs --jwks-file or --jwks-json');
    const badMethod = await run(cli.runUpdate, platform, ['update', 'Cli.auth', '--auth-method', 'client_secret_post']);
    assert.equal(badMethod.error?.message, 'update: --auth-method must be none, client_secret_basic or private_key_jwt');
    // none -> client_secret_basic: a secret minted, printed once, its hash stored.
    const toSecret = await run(cli.runUpdate, platform, ['update', 'Cli.auth', '--auth-method', 'client_secret_basic']);
    assert.equal(toSecret.error, null, toSecret.error?.message);
    assert.match(toSecret.out, /auth method: {3}client_secret_basic \(was none\)/);
    assert.match(toSecret.out, /client_secret: \S+\n {5}\(shown once: store it now\)/);
    let row = await getClient(platform, 'Cli.auth');
    assert.equal(row.tokenEndpointAuthMethod, 'client_secret_basic');
    assert.equal(typeof row.clientSecretHash, 'string');
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
    assert.match(ok.out, /client_secret: \S+/);
    assert.notEqual((await getClient(platform, 'Cli.rs.sec')).clientSecretHash, first);
    // An app-account row (no auth method stored) works as before.
    await persistClient(platform, { clientId: 'appacct', redirectUris: [REDIRECT], grantTypes: ['authorization_code'], scope: [] });
    const app = await run(cli.runRotateSecret, platform, ['rotate-secret', 'appacct']);
    assert.equal(app.error, null, app.error?.message);
    assert.equal(typeof (await getClient(platform, 'appacct')).clientSecretHash, 'string');
  });
});
