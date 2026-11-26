/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);

/**
 * [OCVL] OAuth2: client registration modes, validation levels and their
 * policies (`oauth.clientRegistration`).
 *
 * The configuration check (curated stays the default, delegated accepted,
 * open refused), the level of each kind of client (the badge matrix), the
 * digest of an app review, the badge on the consent offer and the access
 * stamp, the policies at /oauth2/authorize and at the consent (refuse,
 * testers, scope template, maxGrants), the row rules and the operator CLI.
 * Route handlers run against an in-memory platform store and a toy grammar.
 */

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const extension = require('../src/extension.ts');
const scopeGrammar = require('../src/scopeGrammar.ts');
const offerRoute = require('../src/routes/offer.ts');
const cv = require('../src/clientValidation.ts');
const { handleAuthorize } = require('../src/routes/authorize.ts');
const { handleOffer } = require('../src/routes/offer.ts');
const { handleAccept } = require('../src/routes/accept.ts');
const { registerRoutes } = require('../src/routes.ts');
const { persistClient, getClient } = require('../src/clientRegistry.ts');
const { setClient } = require('../src/storage.ts');
const { clientStamp } = require('../src/clientMetadataId.ts');
const cli = require('../../../bin/oauth-client.js');

const STATE_KEY = 'state-key-for-tests-0123456789abcdef';
const ISSUER = 'https://core.example.com';
const CONSENT_URL = 'https://consent.example.com/authorize';
const REDIRECT = 'https://app.example.com/redirect';
const AUD = 'https://resource.example.com/base';
const OWNER = 'u-owner';
const OTHER = 'u-other';

const toy = {
  apiVersion: 1,
  name: 'toy-levels',
  scopeGrammar: {
    parse (s) {
      const tokens = s.split(/\s+/).filter((t) => t !== '');
      for (const t of tokens) if (!/^read\/[a-z]+$/.test(t)) return { ok: false, description: 'unknown token ' + t };
      return { ok: true, tokens, offer: { permissions: tokens.map((t) => ({ streamId: t.slice(5), level: 'read' })) } };
    },
    echo: ({ requestedTokens }) => requestedTokens,
  },
};

function fakeConfig (overrides = {}) {
  const m = {
    'service:api': ISSUER,
    'oauth:stateKey': STATE_KEY,
    'oauth:consentUrl': CONSENT_URL,
    'core:id': 'core-a',
    ...overrides,
  };
  return { get: (k) => m[k] };
}

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
    async setAccessStateIfAbsent (k, v, exp) { if (state.has(k)) return false; state.set(k, { value: v, expiresAt: exp }); return true; },
    async getAccessState (k) { return state.get(k) ?? null; },
    async deleteAccessState (k) { state.delete(k); },
    async consumeAccessState (k) { const e = state.get(k); state.delete(k); return e ?? null; },
    _kv: kv,
  };
}

function fakeRes () {
  return {
    statusCode: 200,
    headers: {},
    raw: '',
    setHeader (k, v) { this.headers[k.toLowerCase()] = v; },
    end (b) {
      this.raw = b ?? '';
      this.body = String(this.headers['content-type'] ?? '').includes('json') && b ? JSON.parse(b) : null;
    },
  };
}

const BASE = {
  kind: 'registry',
  redirectUris: [REDIRECT],
  scope: ['read/a', 'read/b'],
  grantTypes: ['authorization_code'],
  tokenEndpointAuthMethod: 'none',
  allowedAudiences: [AUD],
  subjectType: 'public',
  clientName: 'Level app',
};

function operatorClient (extra = {}) {
  return { ...BASE, clientId: 'op-app', ...extra };
}

function developerClient (extra = {}) {
  return { ...BASE, clientId: 'dev-app', origin: 'developer', owner: { userId: OWNER }, ...extra };
}

function reviewed (row) {
  return { ...row, validation: { app: { at: 1700000000000, by: 'operator', digest: cv.validationDigest(row) } } };
}

const CHALLENGE = crypto.createHash('sha256').update('v'.repeat(50)).digest('base64url');

async function authorize (deps, clientId, scope = 'read/a') {
  const res = fakeRes();
  await handleAuthorize(deps)({
    method: 'GET',
    query: {
      client_id: clientId,
      redirect_uri: REDIRECT,
      response_type: 'code',
      code_challenge: CHALLENGE,
      code_challenge_method: 'S256',
      state: 'client-state',
      scope,
      aud: AUD,
    },
  }, res);
  const location = res.headers.location ?? '';
  const signed = location.startsWith(CONSENT_URL) ? new URL(location).searchParams.get('state') : null;
  const err = signed == null && location !== '' ? new URL(location).searchParams : null;
  return { res, signed, error: err?.get('error') ?? null, description: err?.get('error_description') ?? null };
}

async function offer (deps, signed) {
  const res = fakeRes();
  await handleOffer(deps)({ body: { state: signed } }, res);
  return res;
}

async function accept (deps, signed, userId) {
  const res = fakeRes();
  let n = 0;
  await handleAccept({
    ...deps,
    resolveUser: async () => ({ userId, username: 'name-' + userId }),
    createAccess: async (p) => {
      n++;
      return { accessId: 'acc-' + n, accessToken: 'tok-' + n, apiEndpoint: 'https://x.example.com/', dataGrantAccessId: 'grant-1', permissions: p.grantedPermissions };
    },
  })({ body: { state: signed, username: 'name-' + userId, userToken: 'personal', grantedPermissions: [{ streamId: 'a', level: 'read' }] } }, res);
  return res;
}

function levels (lv) {
  return { 'oauth:clientRegistration': { mode: 'delegated', levels: lv } };
}

describe('[OCVL] OAuth2 client registration modes and validation levels', () => {
  beforeEach(() => {
    extension.setExtension(toy);
    scopeGrammar._resetForTests();
    offerRoute._resetForTests();
    cv._resetForTests();
  });
  afterEach(() => extension._resetForTests());

  describe('[OCVL-CFG] configuration', () => {
    it('[OCVL1] absent, curated and delegated are accepted; curated is the default', () => {
      assert.deepEqual(cv.describeClientRegistrationConfig(undefined), { problems: [], warnings: [] });
      assert.deepEqual(cv.describeClientRegistrationConfig({ mode: 'curated' }), { problems: [], warnings: [] });
      assert.deepEqual(cv.describeClientRegistrationConfig({ mode: 'delegated' }, { extensionInstalled: true }).problems, []);
      assert.equal(cv.clientRegistrationSettings(fakeConfig()).mode, 'curated');
      assert.equal(cv.clientRegistrationSettings(fakeConfig({ 'oauth:clientRegistration': { mode: 'delegated' } })).mode, 'delegated');
      for (const level of cv.VALIDATION_LEVELS) {
        assert.deepEqual(cv.levelPolicy(fakeConfig(), level), { consent: 'allow', scopeTemplate: null, maxGrants: null });
      }
    });

    it('[OCVL2] open, an unknown mode, unknown keys and bad level policies are problems', () => {
      assert.match(cv.describeClientRegistrationConfig({ mode: 'open' }).problems.join(), /mode is "open": anonymous dynamic client registration \(RFC 7591\) is not offered/);
      assert.match(cv.describeClientRegistrationConfig({ mode: 'free' }).problems.join(), /curated or delegated is expected/);
      assert.match(cv.describeClientRegistrationConfig({ mode: 'curated', extra: 1 }).problems.join(), /oauth.clientRegistration.extra is not a setting/);
      const bad = cv.describeClientRegistrationConfig({
        mode: 'delegated',
        whoMayRegister: 'everyone',
        levels: { nonValidated: { consent: 'maybe', maxGrants: 0, scopeTemplate: '' }, superValidated: {} },
      }).problems.join('\n');
      assert.match(bad, /whoMayRegister is "everyone"/);
      assert.match(bad, /levels.nonValidated.consent is "maybe"/);
      assert.match(bad, /levels.nonValidated.maxGrants must be an integer/);
      assert.match(bad, /levels.nonValidated.scopeTemplate must be a non-empty scope string/);
      assert.match(bad, /levels.superValidated is not a level/);
      // A block with problems reads as the defaults.
      assert.equal(cv.clientRegistrationSettings(fakeConfig({ 'oauth:clientRegistration': { mode: 'open' } })).mode, 'curated');
    });

    it('[OCVL3] delegated needs an OAuth extension; anyAccount warns; whoMayRegister under curated warns', () => {
      assert.match(cv.describeClientRegistrationConfig({ mode: 'delegated' }, { extensionInstalled: false }).problems.join(), /need an OAuth extension/);
      assert.match(cv.describeClientRegistrationConfig({ mode: 'delegated', whoMayRegister: 'anyAccount' }, { extensionInstalled: true }).warnings.join(),
        /any account of the platform may register an application/);
      assert.match(cv.describeClientRegistrationConfig({ mode: 'curated', whoMayRegister: 'anyAccount' }).warnings.join(), /set but not used/);
    });

    it('[OCVL4] the boot refuses mode open (and delegated without an extension), and mounts with curated', () => {
      const app = { get () {}, post () {}, use () {} };
      assert.throws(() => registerRoutes(app, { config: fakeConfig({ 'oauth:clientRegistration': { mode: 'open' } }), extension: toy }),
        /oauth.clientRegistration: oauth.clientRegistration.mode is "open"/);
      assert.throws(() => registerRoutes(app, { config: fakeConfig({ 'oauth:clientRegistration': { mode: 'delegated' } }), extension: null }),
        /need an OAuth extension/);
      registerRoutes(app, { config: fakeConfig({ 'oauth:clientRegistration': { mode: 'curated' } }), extension: toy });
      registerRoutes(app, { config: fakeConfig(), extension: null });
    });
  });

  describe('[OCVL-LVL] levels', () => {
    it('[OCVL5] the badge matrix: one row per kind of client', () => {
      const allowList = fakeConfig({ 'oauth:clientMetadataDocuments': { mode: 'allowList', allowedHosts: ['client.example'], client: { scope: 'read/a', allowedAudiences: [AUD] } } });
      const any = fakeConfig({ 'oauth:clientMetadataDocuments': { mode: 'any', client: { scope: 'read/a', allowedAudiences: [AUD] } } });
      const metadata = { ...BASE, clientId: 'url~' + 'a'.repeat(40), origin: 'metadata-document', metadataUrl: 'https://client.example/c.json' };
      const validated = { status: 'validated', displayName: 'Acme' };
      const rows = [
        ['operator, no origin (rows before the field)', operatorClient(), null, fakeConfig(), 'appValidated'],
        ['operator, origin operator', operatorClient({ origin: 'operator' }), null, fakeConfig(), 'appValidated'],
        ['operator, app-account', { clientId: 'acct', redirectUris: [REDIRECT], grantTypes: ['authorization_code'], scope: [] }, null, fakeConfig(), 'appValidated'],
        ['developer, review passed', reviewed(developerClient()), null, fakeConfig(), 'appValidated'],
        ['developer, review passed, publisher validated', reviewed(developerClient()), validated, fakeConfig(), 'appValidated'],
        ['developer, publisher validated', developerClient(), validated, fakeConfig(), 'publisherValidated'],
        ['developer, publisher pending', developerClient(), { status: 'pending' }, fakeConfig(), 'nonValidated'],
        ['developer, publisher suspended', developerClient(), { status: 'suspended' }, fakeConfig(), 'nonValidated'],
        ['developer, no publisher row', developerClient(), null, fakeConfig(), 'nonValidated'],
        ['metadata-document, allowList', metadata, null, allowList, 'publisherValidated'],
        ['metadata-document, any', metadata, null, any, 'nonValidated'],
      ];
      for (const [what, client, publisher, config, level] of rows) {
        assert.equal(cv.clientValidationLevel(client, publisher, config).level, level, what);
      }
      assert.deepEqual(cv.clientValidationLevel(developerClient(), validated, null),
        { level: 'publisherValidated', publisher: { name: 'Acme', validated: true } });
      assert.deepEqual(cv.clientValidationLevel(reviewed(developerClient()), null, null), { level: 'appValidated', validatedAt: 1700000000000 });
    });

    it('[OCVL6] a reviewed app loses App Validated when a vetted or display field changes, not for a field outside the review', () => {
      const row = reviewed(developerClient());
      assert.equal(cv.clientValidationLevel(row, null, null).level, 'appValidated');
      for (const change of [{ redirectUris: [REDIRECT, 'https://app.example.com/other'] }, { scope: ['read/a'] }, { clientName: 'Other name' },
        { logoUri: 'https://logos.example.com/x.png' }, { allowedAudiences: [AUD, 'https://other.example.com/'] }]) {
        assert.equal(cv.clientValidationLevel({ ...row, ...change }, null, null).level, 'nonValidated', JSON.stringify(change));
      }
      assert.equal(cv.clientValidationLevel({ ...row, regions: ['eu'], maxEntries: 5, updatedAt: 99 }, null, null).level, 'appValidated');
      // An empty list is the same as none (a row written before a list field existed).
      assert.equal(cv.validationDigest({ ...developerClient(), launchTypes: [] }), cv.validationDigest(developerClient()));
      // The digest covers the vetted fields and the display identity.
      for (const f of ['redirectUris', 'scope', 'jwks', 'clientName', 'name', 'logoUri', 'policyUri', 'tosUri']) {
        assert.ok(cv.VALIDATION_DIGEST_FIELDS.includes(f), f);
      }
    });

    it('[OCVL7] the publisher row is read from the platform store; absent or unreadable reads as not validated', async () => {
      const platform = fakePlatform();
      assert.deepEqual(await cv.resolveClientValidation(platform, null, developerClient()), { level: 'nonValidated' });
      await cv.setPublisher(platform, OWNER, { status: 'validated', displayName: 'Acme' });
      assert.deepEqual(await cv.resolveClientValidation(platform, null, developerClient()),
        { level: 'publisherValidated', publisher: { name: 'Acme', validated: true } });
      await platform.setPlatformKv('dev-publisher/' + OWNER, '{not json');
      assert.equal((await cv.resolveClientValidation(platform, null, developerClient())).level, 'nonValidated');
      await assert.rejects(cv.setPublisher(platform, OWNER, { status: 'great' }), /status must be one of/);
    });
  });

  describe('[OCVL-ROW] client rows', () => {
    it('[OCVL8] origin developer needs an owner; owner and validation only on a developer\'s client; old rows persist as before', async () => {
      const platform = fakePlatform();
      await persistClient(platform, operatorClient());
      assert.equal((await getClient(platform, 'op-app')).origin, undefined);
      await persistClient(platform, operatorClient({ clientId: 'op-app2', origin: 'operator' }));
      await persistClient(platform, reviewed(developerClient()));
      await assert.rejects(persistClient(platform, developerClient({ owner: undefined })), /owner: a developer's client names its owning account/);
      await assert.rejects(persistClient(platform, developerClient({ owner: { userId: 'a/b' } })), /owner/);
      await assert.rejects(persistClient(platform, operatorClient({ owner: { userId: OWNER } })), /owner: only on a developer's client/);
      await assert.rejects(persistClient(platform, reviewed(operatorClient({ origin: 'operator' }))), /validation: only on a developer's client/);
      await assert.rejects(persistClient(platform, developerClient({ validation: { app: { at: 1, by: 'x', digest: 'short' } } })), /validation.app must be/);
      await assert.rejects(persistClient(platform, { clientId: 'acct', origin: 'developer', owner: { userId: OWNER }, redirectUris: [REDIRECT], grantTypes: ['authorization_code'], scope: [] }),
        /only on a registry client/);
      await assert.rejects(persistClient(platform, operatorClient({ origin: 'someone' })), /origin must be one of/);
    });

    it('[OCVL9] the access stamp: origin developer for a developer\'s client, and the level at that moment', async () => {
      const platform = fakePlatform();
      assert.deepEqual(clientStamp(developerClient()), { name: 'Level app', origin: 'developer' });
      assert.deepEqual(clientStamp(operatorClient()), { name: 'Level app', origin: 'operator' });
      assert.deepEqual(await cv.validatedClientStamp(platform, null, operatorClient()),
        { name: 'Level app', origin: 'operator', validation: { level: 'appValidated' } });
      assert.deepEqual(await cv.validatedClientStamp(platform, null, developerClient()),
        { name: 'Level app', origin: 'developer', validation: { level: 'nonValidated' } });
      // An app-account client gets no stamp (its consent is a CMC grant).
      assert.equal(await cv.validatedClientStamp(platform, null, { clientId: 'acct', redirectUris: [REDIRECT], grantTypes: ['authorization_code'], scope: [] }), null);
    });
  });

  describe('[OCVL-FLOW] offer, authorize and consent', () => {
    it('[OCVL10] curated, no level settings: an operator client and a non-validated one both go through as before; the offer says the level', async () => {
      const platform = fakePlatform();
      const deps = { config: fakeConfig(), platform };
      await persistClient(platform, operatorClient());
      await persistClient(platform, developerClient());
      for (const [id, level] of [['op-app', 'appValidated'], ['dev-app', 'nonValidated']]) {
        const a = await authorize(deps, id);
        assert.ok(a.signed, id + ': ' + a.res.headers.location);
        const o = await offer(deps, a.signed);
        assert.equal(o.statusCode, 200, o.raw);
        assert.deepEqual(o.body.client.validation, { level });
        const acc = await accept(deps, a.signed, OTHER);
        assert.equal(acc.statusCode, 200, acc.raw);
      }
      // Nothing is counted when no cap applies.
      assert.deepEqual([...platform._kv.keys()].filter((k) => k.startsWith('oauth-level-grant/')), []);
    });

    it('[OCVL11] the offer names a developer client\'s publisher and review', async () => {
      const platform = fakePlatform();
      const deps = { config: fakeConfig(), platform };
      await persistClient(platform, reviewed(developerClient()));
      await cv.setPublisher(platform, OWNER, { status: 'validated', displayName: 'Acme' });
      const a = await authorize(deps, 'dev-app');
      const o = await offer(deps, a.signed);
      assert.equal(o.body.client.origin, 'developer');
      assert.deepEqual(o.body.client.validation, { level: 'appValidated', publisher: { name: 'Acme', validated: true }, validatedAt: 1700000000000 });
    });

    it('[OCVL12] nonValidated.consent refuse: a non-validated app is refused at /authorize and at the consent, the others are not', async () => {
      const platform = fakePlatform();
      const config = fakeConfig(levels({ nonValidated: { consent: 'refuse' } }));
      const deps = { config, platform };
      await persistClient(platform, operatorClient());
      await persistClient(platform, developerClient());
      await persistClient(platform, developerClient({ clientId: 'dev-pub' }));
      await cv.setPublisher(platform, OWNER, { status: 'pending' });
      const refused = await authorize(deps, 'dev-app');
      assert.equal(refused.signed, null);
      assert.equal(refused.error, 'unauthorized_client');
      assert.equal(refused.description, 'this application is not validated on this platform');
      assert.ok((await authorize(deps, 'op-app')).signed);
      // The level changes between /authorize and the consent: refused there too.
      await cv.setPublisher(platform, OWNER, { status: 'validated' });
      const a = await authorize(deps, 'dev-pub');
      assert.ok(a.signed);
      await cv.setPublisher(platform, OWNER, { status: 'suspended' });
      const acc = await accept(deps, a.signed, OWNER);
      assert.equal(acc.statusCode, 403, acc.raw);
      assert.equal(acc.body.reason, 'client-not-validated');
    });

    it('[OCVL13] testers: the owner may consent, any other account is refused', async () => {
      const platform = fakePlatform();
      const deps = { config: fakeConfig(levels({ nonValidated: { consent: 'testers' } })), platform };
      await persistClient(platform, developerClient());
      const a = await authorize(deps, 'dev-app');
      assert.ok(a.signed, 'testers does not refuse at /authorize');
      const other = await accept(deps, a.signed, OTHER);
      assert.equal(other.statusCode, 403, other.raw);
      assert.equal(other.body.reason, 'client-testers-only');
      assert.equal(other.body.error, 'access_denied');
      const owner = await accept(deps, a.signed, OWNER);
      assert.equal(owner.statusCode, 200, owner.raw);
      // An operator client under a testers policy has no owner: nobody passes.
      const deps2 = { config: fakeConfig(levels({ appValidated: { consent: 'testers' } })), platform };
      await persistClient(platform, operatorClient());
      const b = await authorize(deps2, 'op-app');
      assert.equal((await accept(deps2, b.signed, OWNER)).statusCode, 403);
    });

    it('[OCVL14] scopeTemplate: a request outside the template of the client\'s level is refused', async () => {
      const platform = fakePlatform();
      const deps = { config: fakeConfig(levels({ nonValidated: { scopeTemplate: 'read/a' } })), platform };
      await persistClient(platform, developerClient());
      await persistClient(platform, operatorClient());
      assert.ok((await authorize(deps, 'dev-app', 'read/a')).signed);
      const wide = await authorize(deps, 'dev-app', 'read/a read/b');
      assert.equal(wide.error, 'invalid_scope');
      assert.match(wide.description, /not validated on this platform: it may not request this scope yet/);
      // Another level: its own maximum set only.
      assert.ok((await authorize(deps, 'op-app', 'read/a read/b')).signed);
    });

    it('[OCVL15] maxGrants: counted once per account; the cap refuses a new account; purge and revoke give the units back', async () => {
      const platform = fakePlatform();
      const deps = { config: fakeConfig(levels({ nonValidated: { maxGrants: 1 } })), platform };
      await persistClient(platform, developerClient());
      const a = await authorize(deps, 'dev-app');
      assert.equal((await accept(deps, a.signed, OWNER)).statusCode, 200);
      assert.equal(await cv.countLevelGrants(platform, 'dev-app'), 1);
      const again = await authorize(deps, 'dev-app');
      assert.equal((await accept(deps, again.signed, OWNER)).statusCode, 200, 'the same account consents again');
      assert.equal(await cv.countLevelGrants(platform, 'dev-app'), 1);
      const b = await authorize(deps, 'dev-app');
      const capped = await accept(deps, b.signed, OTHER);
      assert.equal(capped.statusCode, 403, capped.raw);
      assert.equal(capped.body.reason, 'client-grant-limit');
      assert.equal(await cv.releaseLevelGrants(platform, 'dev-app'), 1);
      const c = await authorize(deps, 'dev-app');
      assert.equal((await accept(deps, c.signed, OTHER)).statusCode, 200);
      // An App Validated client is not capped by the non-validated policy.
      await persistClient(platform, operatorClient());
      for (const who of ['x1', 'x2']) {
        const s = await authorize(deps, 'op-app');
        assert.equal((await accept(deps, s.signed, who)).statusCode, 200);
      }
    });
  });

  describe('[OCVL-CLI] operator CLI', () => {
    async function run (fn, platform, argv) {
      const args = cli.parseArgs(argv);
      const lines = [];
      const log = console.log;
      console.log = (...x) => { lines.push(x.join(' ')); };
      let error = null;
      try {
        await fn(platform, args, getClient, persistClient);
      } catch (err) {
        error = err;
      } finally {
        console.log = log;
      }
      return { out: lines.join('\n'), error };
    }

    it('[OCVL16] validate / unvalidate a developer\'s client; refused for the others; show and list print origin, owner and level', async () => {
      const platform = fakePlatform();
      await persistClient(platform, developerClient());
      await persistClient(platform, operatorClient());
      const v = await run(cli.runValidate, platform, ['validate', 'dev-app']);
      assert.equal(v.error, null, v.error?.message);
      assert.match(v.out, /OK {3}client dev-app validated: level appValidated/);
      const row = await getClient(platform, 'dev-app');
      assert.equal(row.validation.app.by, 'operator');
      assert.equal(row.validation.app.digest, cv.validationDigest(row));
      assert.equal(row.statusLog.at(-1).reason, 'validate');
      const shown = await run((p, a) => cli.runShow(p, a, getClient, () => ''), platform, ['show', 'dev-app']);
      assert.match(shown.out, /origin: developer \(owner u-owner\)/);
      assert.match(shown.out, /validation level: appValidated \(app review passed /);
      const listed = await run((p) => cli.runList(p, getClient), platform, ['list']);
      assert.deepEqual(listed.out.split('\n').sort(), [
        'dev-app  registry  active  public  developer owner:u-owner  appValidated',
        'op-app  registry  active  public  operator  appValidated',
      ]);
      // An operator edit of a reviewed field drops the level until validated again.
      await setClient(platform, { ...row, redirectUris: [REDIRECT, 'https://app.example.com/new'] });
      const after = await run((p, a) => cli.runShow(p, a, getClient, () => ''), platform, ['show', 'dev-app']);
      assert.match(after.out, /validation level: nonValidated \(app review no longer matches its fields: validate it again\)/);
      const u = await run(cli.runValidate, platform, ['unvalidate', 'dev-app']);
      assert.equal(u.error, null, u.error?.message);
      assert.equal((await getClient(platform, 'dev-app')).validation, undefined);
      assert.match((await run(cli.runValidate, platform, ['unvalidate', 'dev-app'])).out, /has no app review \(unchanged\)/);
      const op = await run(cli.runValidate, platform, ['validate', 'op-app']);
      assert.match(op.error?.message ?? '', /was registered by the operator: it is appValidated by rule/);
      const none = await run(cli.runValidate, platform, ['validate', 'nope']);
      assert.match(none.error?.message ?? '', /no client "nope"/);
    });

    it('[OCVL17] revoke and purge-grants give back the units counted against maxGrants', async () => {
      const platform = fakePlatform();
      await persistClient(platform, developerClient());
      await cv.recordLevelGrant(platform, 'dev-app', OWNER);
      await cv.recordLevelGrant(platform, 'dev-app', OTHER);
      const purge = cli.parseArgs(['purge-grants', 'dev-app', '--yes']);
      const lines = [];
      const log = console.log;
      console.log = (...x) => { lines.push(x.join(' ')); };
      try {
        await cli.runPurgeGrants(platform, purge, async () => ({ grants: 0, sessions: 0, accesses: 0, accounts: 0, refreshTokens: 0 }));
      } finally {
        console.log = log;
      }
      assert.match(lines.join('\n'), /accounts released from maxGrants \(platform-wide\): 2/);
      assert.equal(await cv.countLevelGrants(platform, 'dev-app'), 0);
      await cv.recordLevelGrant(platform, 'dev-app', OWNER);
      console.log = () => {};
      try {
        await cli.runRevoke(platform, cli.parseArgs(['revoke', 'dev-app', '--yes']), async () => {});
      } finally {
        console.log = log;
      }
      assert.equal(await cv.countLevelGrants(platform, 'dev-app'), 0);
    });
  });
});
