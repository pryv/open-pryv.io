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
    assert.doesNotMatch(r.out, /WARN/);
    assert.match(r.out, /features forbidden on its grants: webhooks, secretSharing/);
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
    assert.match(r.out, /features forbidden on its grants: secretSharing \(allowed: webhooks\)/);
    const loc = await authorizeAs(platform, 'Cli.four');
    assert.equal(loc.origin + loc.pathname, CONSENT_URL, loc.href);
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
});
