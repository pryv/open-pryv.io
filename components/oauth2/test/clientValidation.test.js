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
const { handleToken } = require('../src/routes/token.ts');
const { metadataClientKey } = require('../src/clientMetadataId.ts');
const { persistDeveloperClient } = require('../src/clientRegistry.ts');
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
  return { ...row, validation: { app: { v: 1, at: 1700000000000, by: 'operator', digest: cv.validationDigest(row) } } };
}

const DELEGATED = { 'oauth:clientRegistration': { mode: 'delegated' } };

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

async function accept (deps, signed, userId, grantedPermissions = [{ streamId: 'a', level: 'read' }], createAccess = null) {
  const res = fakeRes();
  let n = 0;
  await handleAccept({
    ...deps,
    resolveUser: async () => ({ userId, username: 'name-' + userId }),
    createAccess: createAccess ?? (async (p) => {
      n++;
      return { accessId: 'acc-' + n, accessToken: 'tok-' + n, apiEndpoint: 'https://x.example.com/', dataGrantAccessId: 'grant-1', permissions: p.grantedPermissions };
    }),
  })({ body: { state: signed, username: 'name-' + userId, userToken: 'personal', grantedPermissions } }, res);
  return res;
}

/** /oauth2/token refresh_token for a client (the token itself unknown: the client checks come first). */
async function refresh (deps, clientId) {
  const res = fakeRes();
  await handleToken({
    ...deps,
    mintRefreshedAccess: async () => { throw new Error('not reached'); },
    resolveUsername: async () => null,
  })({ headers: {}, body: { grant_type: 'refresh_token', refresh_token: 'unknown-token', client_id: clientId } }, res);
  return res;
}

/** Audit rows emitted while running `fn` (the debug channel of audit.ts). */
async function auditRows (fn) {
  const rows = [];
  const saved = console.debug;
  const env = process.env.OAUTH_AUDIT_DEBUG;
  process.env.OAUTH_AUDIT_DEBUG = '1';
  console.debug = (tag, event, payload) => { if (tag === '[oauth.audit]') rows.push({ event, ...payload }); };
  try { await fn(); } finally {
    console.debug = saved;
    if (env == null) delete process.env.OAUTH_AUDIT_DEBUG; else process.env.OAUTH_AUDIT_DEBUG = env;
  }
  return rows;
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
      // A block with problems fails closed: curated, every level refused (the boot refuses it anyway).
      const closed = cv.clientRegistrationSettings(fakeConfig({ 'oauth:clientRegistration': { mode: 'delegated', levels: { appValidated: { consent: 'nope' } } } }));
      assert.equal(closed.mode, 'curated');
      for (const level of cv.VALIDATION_LEVELS) assert.equal(closed.levels[level].consent, 'refuse', level);
      assert.match(cv.describeClientRegistrationConfig({ levels: { nonValidated: { maxGrants: 100001 } } }).problems.join(), /from 1 to 100000/);
    });

    it('[OCVL3] delegated needs an OAuth extension; anyAccount warns; whoMayRegister under curated warns', () => {
      assert.match(cv.describeClientRegistrationConfig({ mode: 'delegated' }, { extensionInstalled: false }).problems.join(), /need an OAuth extension/);
      assert.match(cv.describeClientRegistrationConfig({ mode: 'delegated', whoMayRegister: 'anyAccount' }, { extensionInstalled: true }).warnings.join(),
        /any account of the platform may register an application/);
      assert.match(cv.describeClientRegistrationConfig({ mode: 'curated', whoMayRegister: 'anyAccount' }).warnings.join(), /set but not used/);
      // Refusing App Validated clients locks the operator's own clients out: said.
      assert.match(cv.describeClientRegistrationConfig({ levels: { appValidated: { consent: 'testers' } } }).warnings.join(),
        /applies to the clients the operator registered too/);
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
      const allowList = fakeConfig({ 'oauth:clientMetadataDocuments': { mode: 'allowList', allowedHosts: ['client.example', 'other.example'], client: { scope: 'read/a', allowedAudiences: [AUD] } } });
      const unlisted = fakeConfig({ 'oauth:clientMetadataDocuments': { mode: 'allowList', allowedHosts: ['other.example'], client: { scope: 'read/a', allowedAudiences: [AUD] } } });
      const denied = fakeConfig({ 'oauth:clientMetadataDocuments': { mode: 'allowList', allowedHosts: ['client.example'], deniedHosts: ['client.example'], client: { scope: 'read/a', allowedAudiences: [AUD] } } });
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
        ['metadata-document, allowList, host listed', metadata, null, allowList, 'publisherValidated'],
        ['metadata-document, allowList, host no longer listed', metadata, null, unlisted, 'nonValidated'],
        ['metadata-document, allowList, host denied', metadata, null, denied, 'nonValidated'],
        ['metadata-document, any', metadata, null, any, 'nonValidated'],
        ['metadata-document, no config (CLI without it)', metadata, null, null, 'nonValidated'],
      ];
      for (const [what, client, publisher, config, level] of rows) {
        assert.equal(cv.clientValidationLevel(client, publisher, config).level, level, what);
      }
      assert.deepEqual(cv.clientValidationLevel(developerClient(), validated, null),
        { level: 'publisherValidated', publisher: { name: 'Acme', validated: true } });
      // A publisher not validated: never named.
      assert.deepEqual(cv.clientValidationLevel(developerClient(), { status: 'pending', displayName: 'Acme' }, null),
        { level: 'nonValidated', publisher: { validated: false } });
      assert.deepEqual(cv.clientValidationLevel(reviewed(developerClient()), null, null), { level: 'appValidated', validatedAt: 1700000000000 });
    });

    it('[OCVL6] a reviewed app loses App Validated when a field that changes what it does or who owns it changes, not for a field outside the review', () => {
      const row = reviewed(developerClient());
      assert.equal(cv.clientValidationLevel(row, null, null).level, 'appValidated');
      for (const change of [{ redirectUris: [REDIRECT, 'https://app.example.com/other'] }, { scope: ['read/a'] }, { clientName: 'Other name' },
        { logoUri: 'https://logos.example.com/x.png' }, { allowedAudiences: [AUD, 'https://other.example.com/'] },
        { maxEntries: 5 }, { subjectType: 'pairwise' }, { allowInsecureRedirect: true }, { dpopBoundAccessTokens: true },
        { tokenResponseExtras: { x: 1 } }, { applicationType: 'native' }, { owner: { userId: OTHER } }]) {
        assert.equal(cv.clientValidationLevel({ ...row, ...change }, null, null).level, 'nonValidated', JSON.stringify(change));
      }
      // Outside the review: where it is served, its version, its trail.
      assert.equal(cv.clientValidationLevel({ ...row, regions: ['eu'], updatedAt: 99, statusLog: [], contacts: ['a@b.example'] }, null, null).level, 'appValidated');
      // An empty list is the same as none (a row written before a list field existed).
      assert.equal(cv.validationDigest({ ...developerClient(), launchTypes: [] }), cv.validationDigest(developerClient()));
      for (const f of ['redirectUris', 'scope', 'jwks', 'clientName', 'name', 'logoUri', 'policyUri', 'tosUri', 'maxEntries', 'subjectType', 'owner']) {
        assert.ok(cv.VALIDATION_DIGEST_FIELDS.includes(f), f);
      }
      // Versioned: a review without a version is version 1; an unknown version never stands.
      const { v: _v, ...unversioned } = row.validation.app;
      assert.equal(cv.reviewStands({ ...row, validation: { app: unversioned } }), true);
      assert.equal(cv.reviewStands({ ...row, validation: { app: { ...row.validation.app, v: 99 } } }), false);
      assert.equal(cv.validationDigest(row, 99), null);
      assert.equal(cv.VALIDATION_DIGEST_VERSION, 1);
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
      // The display name follows the client-name rule (128 characters, no control or bidi character).
      await assert.rejects(cv.setPublisher(platform, OWNER, { status: 'validated', displayName: 'x'.repeat(129) }), /displayName/);
      await assert.rejects(cv.setPublisher(platform, OWNER, { status: 'validated', displayName: 'Acme‮' }), /displayName/);
      await platform.setPlatformKv('dev-publisher/' + OWNER, JSON.stringify({ status: 'validated', displayName: 'Bad\u0007' }));
      assert.deepEqual(await cv.resolveClientValidation(platform, null, developerClient()),
        { level: 'publisherValidated', publisher: { validated: true } });
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
      await assert.rejects(persistClient(platform, developerClient({ validation: [] })), /validation: only \{ app \} is stored/);
      await assert.rejects(persistClient(platform, developerClient({ validation: { app: { ...reviewed(developerClient()).validation.app, v: 0 } } })),
        /validation.app must be/);
    });

    it('[OCVL18] persistDeveloperClient: origin and owner set by itself, the review only from the stored row, another origin or owner refused', async () => {
      const platform = fakePlatform();
      const forged = { ...BASE, clientId: 'dev-new', origin: 'operator', owner: { userId: OTHER }, validation: { app: { v: 1, at: 1, by: 'me', digest: 'a'.repeat(43) } } };
      await persistDeveloperClient(platform, OWNER, forged);
      const row = await getClient(platform, 'dev-new');
      assert.equal(row.origin, 'developer');
      assert.deepEqual(row.owner, { userId: OWNER });
      assert.equal(row.validation, undefined);
      assert.equal(cv.clientValidationLevel(row, null, null).level, 'nonValidated');
      // A stored review is carried over (and stands while nothing reviewed changed).
      await setClient(platform, reviewed(row));
      await persistDeveloperClient(platform, OWNER, { ...row, contacts: ['dev@app.example'] });
      assert.equal(cv.clientValidationLevel(await getClient(platform, 'dev-new'), null, null).level, 'appValidated');
      await persistDeveloperClient(platform, OWNER, { ...row, clientName: 'Renamed', validation: undefined });
      assert.equal(cv.clientValidationLevel(await getClient(platform, 'dev-new'), null, null).level, 'nonValidated');
      await assert.rejects(persistDeveloperClient(platform, OTHER, row), /belongs to another origin or owner/);
      await persistClient(platform, operatorClient());
      await assert.rejects(persistDeveloperClient(platform, OWNER, operatorClient()), /belongs to another origin or owner/);
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
    it('[OCVL10] no level settings: an operator client (curated) and a non-validated one (delegated) go through; the offer says the level', async () => {
      const platform = fakePlatform();
      await persistClient(platform, operatorClient());
      await persistClient(platform, developerClient());
      for (const [id, level, config] of [['op-app', 'appValidated', fakeConfig()], ['dev-app', 'nonValidated', fakeConfig(DELEGATED)]]) {
        const deps = { config, platform };
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

    it('[OCVL19] curated: a developer\'s client is not served (authorize, consent, refresh), its row kept; an operator client is', async () => {
      const platform = fakePlatform();
      await persistClient(platform, reviewed(developerClient({ grantTypes: ['authorization_code', 'refresh_token'] })));
      await persistClient(platform, operatorClient());
      const curated = { config: fakeConfig(), platform };
      const a = await authorize(curated, 'dev-app');
      assert.equal(a.signed, null);
      assert.equal(a.error, 'unauthorized_client');
      assert.equal(a.description, 'applications registered by developers are not served on this platform');
      // A consent started while delegated, finished after the switch back.
      const started = await authorize({ config: fakeConfig(DELEGATED), platform }, 'dev-app');
      assert.ok(started.signed);
      const acc = await accept(curated, started.signed, OWNER);
      assert.equal(acc.statusCode, 403, acc.raw);
      assert.equal(acc.body.reason, 'developer-clients-not-served');
      const r = await refresh(curated, 'dev-app');
      assert.equal(r.statusCode, 400, r.raw);
      assert.deepEqual([r.body.error, r.body.error_description], ['unauthorized_client', 'applications registered by developers are not served on this platform']);
      assert.ok(await getClient(platform, 'dev-app'), 'the row is kept');
      // Delegated again: served (the unknown refresh token is then what is refused).
      assert.equal((await refresh({ config: fakeConfig(DELEGATED), platform }, 'dev-app')).body.error, 'invalid_grant');
      assert.ok((await authorize(curated, 'op-app')).signed);
    });

    it('[OCVL20] consent refuse stops the refresh of grants already given too (an unvalidate included); allow lets it through', async () => {
      const platform = fakePlatform();
      await persistClient(platform, reviewed(developerClient({ grantTypes: ['authorization_code', 'refresh_token'] })));
      const deps = { config: fakeConfig(levels({ nonValidated: { consent: 'refuse' } })), platform };
      assert.equal((await refresh(deps, 'dev-app')).body.error, 'invalid_grant', 'App Validated: served');
      // The operator withdraws the review: the level drops to Non-Validated, refused.
      const row = await getClient(platform, 'dev-app');
      const { validation: _v, ...unreviewed } = row;
      await setClient(platform, unreviewed);
      const r = await refresh(deps, 'dev-app');
      assert.equal(r.statusCode, 400, r.raw);
      assert.deepEqual([r.body.error, r.body.error_description], ['unauthorized_client', 'this application is not validated on this platform']);
      assert.equal((await refresh({ config: fakeConfig(DELEGATED), platform }, 'dev-app')).body.error, 'invalid_grant');
    });

    it('[OCVL21] a metadata-document client under mode any is Non-Validated: nonValidated.consent refuse refuses it at /authorize', async () => {
      const url = 'https://client.example/c.json';
      const key = metadataClientKey(url);
      const now = Date.now();
      const cmd = { mode: 'any', client: { scope: 'read/a', allowedAudiences: [AUD] } };
      const platform = fakePlatform();
      await setClient(platform, {
        ...BASE,
        clientId: key,
        origin: 'metadata-document',
        metadataUrl: url,
        clientName: 'Agent',
        subjectType: 'pairwise',
        scope: ['read/a'],
        metadata: { fetchedAt: now, expiresAt: now + 10 ** 9, contentDigest: 'd', lastUsedAt: now, firstConsentAt: now },
        updatedAt: now,
      });
      const open = { config: fakeConfig({ 'oauth:clientMetadataDocuments': cmd }), platform };
      const served = await authorize(open, url);
      assert.ok(served.signed, served.res.raw + ' ' + served.res.headers.location);
      assert.deepEqual((await offer(open, served.signed)).body.client.validation, { level: 'nonValidated' });
      const deps = { config: fakeConfig({ 'oauth:clientMetadataDocuments': cmd, ...levels({ nonValidated: { consent: 'refuse' } }) }), platform };
      const rows = await auditRows(async () => {
        const refused = await authorize(deps, url);
        assert.equal(refused.error, 'unauthorized_client');
        assert.equal(refused.description, 'this application is not validated on this platform');
      });
      assert.ok(rows.some((x) => x.event === 'oauth.consent.refused' && x.reason === 'client-not-validated' && x.validationLevel === 'nonValidated'),
        JSON.stringify(rows));
    });

    it('[OCVL11] the offer names a developer client\'s publisher and review', async () => {
      const platform = fakePlatform();
      const deps = { config: fakeConfig(DELEGATED), platform };
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

    it('[OCVL14b] scopeTemplate at the consent: the level dropped after /authorize, the request outside the new level\'s template is refused and audited', async () => {
      const platform = fakePlatform();
      const deps = { config: fakeConfig(levels({ nonValidated: { scopeTemplate: 'read/a' } })), platform };
      await persistClient(platform, developerClient());
      await cv.setPublisher(platform, OWNER, { status: 'validated' });
      const a = await authorize(deps, 'dev-app', 'read/a read/b');
      assert.ok(a.signed, 'Publisher Validated: no template');
      await cv.setPublisher(platform, OWNER, { status: 'suspended' });
      let acc;
      const rows = await auditRows(async () => {
        acc = await accept(deps, a.signed, OWNER, [{ streamId: 'a', level: 'read' }, { streamId: 'b', level: 'read' }]);
      });
      assert.equal(acc.statusCode, 400, acc.raw);
      assert.deepEqual([acc.body.error, acc.body.reason], ['invalid_scope', 'client-scope-template']);
      assert.ok(rows.some((x) => x.event === 'oauth.consent.refused' && x.reason === 'client-scope-template' && x.validationLevel === 'nonValidated'),
        JSON.stringify(rows));
      // Within the template: accepted at the same level.
      const b = await authorize(deps, 'dev-app', 'read/a');
      assert.equal((await accept(deps, b.signed, OWNER)).statusCode, 200);
    });

    it('[OCVL14c] the template is judged on the permissions resolved for the real client, once per template (no other client\'s fields)', async () => {
      const seen = [];
      // A grammar whose expansion depends on the client: `read/self` reads the client's own stream.
      extension.setExtension({
        ...toy,
        name: 'toy-per-client',
        scopeGrammar: {
          ...toy.scopeGrammar,
          parse (s, ctx) {
            seen.push(ctx?.client?.clientId);
            const tokens = s.split(/\s+/).filter((t) => t !== '');
            const id = ctx?.client?.clientId ?? '';
            return { ok: true, tokens, offer: { permissions: tokens.map((t) => ({ streamId: t === 'read/self' ? id.replace(/[^a-z]/g, '') : t.slice(5), level: 'read' })) } };
          },
        },
      });
      scopeGrammar._resetForTests();
      const platform = fakePlatform();
      const deps = { config: fakeConfig(levels({ nonValidated: { scopeTemplate: 'read/devapp' } })), platform };
      await persistClient(platform, developerClient({ scope: ['read/self', 'read/devapp'] }));
      // `read/self` resolves to the client's stream `devapp`, inside the template: served.
      assert.ok((await authorize(deps, 'dev-app', 'read/self')).signed);
      // Another developer client: `read/self` is its own stream, outside the template.
      await persistClient(platform, developerClient({ clientId: 'other-app', scope: ['read/self'] }));
      assert.equal((await authorize(deps, 'other-app', 'read/self')).error, 'invalid_scope');
      // The template was parsed with its own neutral id, never as a requesting client.
      assert.ok(seen.some((id) => /^level-template-nonValidated-/.test(id)));
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

    it('[OCVL22] maxGrants reserves before the consent is written: a failed consent gives the unit back; racers at the cap are refused, never over it', async () => {
      const platform = fakePlatform();
      const deps = { config: fakeConfig(levels({ nonValidated: { maxGrants: 1 } })), platform };
      await persistClient(platform, developerClient());
      const a = await authorize(deps, 'dev-app');
      const failed = await accept(deps, a.signed, OWNER, undefined, async () => { throw new Error('storage down'); });
      assert.equal(failed.statusCode, 500, failed.raw);
      assert.equal(await cv.countLevelGrants(platform, 'dev-app'), 0, 'released');
      // Two new accounts at once against a cap of 1: at most one gets through.
      const [s1, s2] = [await authorize(deps, 'dev-app'), await authorize(deps, 'dev-app')];
      const results = await Promise.all([accept(deps, s1.signed, 'r1'), accept(deps, s2.signed, 'r2')]);
      assert.ok(results.filter((r) => r.statusCode === 200).length <= 1, results.map((r) => r.statusCode).join());
      assert.ok(await cv.countLevelGrants(platform, 'dev-app') <= 1);
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
      // The operator approves what it reviewed: the digest `show` prints.
      const bare = await run(cli.runValidate, platform, ['validate', 'dev-app']);
      assert.match(bare.error?.message ?? '', /--digest <digest> required/);
      const before = await run((p, a) => cli.runShow(p, a, getClient, () => ''), platform, ['show', 'dev-app']);
      const digest = /review digest: +(\S+)/.exec(before.out)?.[1];
      assert.equal(digest, cv.validationDigest(await getClient(platform, 'dev-app')));
      // Changed since the review: refused, not approved unseen.
      const reviewedRow = await getClient(platform, 'dev-app');
      await setClient(platform, { ...reviewedRow, clientName: 'Changed meanwhile' });
      const stale = await run(cli.runValidate, platform, ['validate', 'dev-app', '--digest', digest]);
      assert.match(stale.error?.message ?? '', /changed since the review digest given/);
      await setClient(platform, reviewedRow);
      const v = await run(cli.runValidate, platform, ['validate', 'dev-app', '--digest', digest]);
      assert.equal(v.error, null, v.error?.message);
      assert.match(v.out, /OK {3}client dev-app validated: level appValidated/);
      const row = await getClient(platform, 'dev-app');
      assert.equal(row.validation.app.by, process.env.USER ?? 'operator');
      assert.equal(row.validation.app.by, row.statusLog.at(-1).by);
      assert.equal(row.validation.app.v, 1);
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
      const op = await run(cli.runValidate, platform, ['validate', 'op-app', '--digest', 'x']);
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
