/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */

/**
 * Per-user audiences at the oauth2 component level: the syntax of a
 * registered `https://{username}.<host>/...` audience, the matcher, the
 * binding of its label to the signed-in account (consent and token
 * exchange), and the exchange's `subject_token_resource`. In-memory platform
 * store, toy grammar, injected sessions.
 */

import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import * as extension from '../src/extension.ts';
import * as scopeGrammar from '../src/scopeGrammar.ts';
import * as offerRoute from '../src/routes/offer.ts';
import { handleAuthorize } from '../src/routes/authorize.ts';
import { handleOffer } from '../src/routes/offer.ts';
import { handleAccept } from '../src/routes/accept.ts';
import { handleToken } from '../src/routes/token.ts';
import { TOKEN_EXCHANGE, ACCESS_TOKEN_TYPE } from '../src/grants/token_exchange.ts';
import { persistClient, narrowedGrantFields, changedVettedFields } from '../src/clientRegistry.ts';
import { mintSecret } from '../src/clientSecret.ts';
import { setSessionIndex, getSessionIndex, getClient, setClient } from '../src/storage.ts';
import { MAX_RESOURCE_BYTES, matchAudience, withinResourceCap } from '../src/resourceIndicator.ts';
import { MAX_TEMPLATE_BYTES, audienceProbe } from '../src/audienceTemplate.ts';
import { labelNamesAccount, consentAudienceRefusal } from '../src/audienceAccount.ts';
import { describeClientMetadataConfig } from '../src/clientMetadataConfig.ts';

const ISSUER = 'https://core.example.com';
const CORE_ID = 'core-a';
const STATE_KEY = 'state-key-for-tests-0123456789abcdef';
const CONSENT_URL = 'https://consent.example.com/authorize';
const REDIRECT = 'https://app.example.com/redirect';
const TEMPLATE = 'https://{username}.example.com/adapter/calendar/api';
const REGION = 'https://auth-ch.example.com/adapter/calendar/api';
const at = (label) => 'https://' + label + '.example.com/adapter/calendar/api';
const USER_ID = 'u-alice';

function toyExtension () {
  return {
    apiVersion: 1,
    name: 'toy-per-user',
    scopeGrammar: {
      parse (scopeString) {
        const tokens = scopeString.split(/\s+/).filter((t) => t !== '');
        return { ok: true, tokens, offer: { permissions: tokens.filter((t) => t.startsWith('read/')).map((t) => ({ streamId: t.slice(5), level: 'read' })) } };
      },
      echo ({ permissions, requestedTokens }) {
        return requestedTokens.filter((t) => permissions.some((p) => 'read/' + p.streamId === t));
      },
    },
  };
}

function fakeConfig (overrides = {}) {
  const m = {
    'service:api': ISSUER,
    'core:id': CORE_ID,
    'oauth:stateKey': STATE_KEY,
    'oauth:consentUrl': CONSENT_URL,
    'oauth:accessTokenTTL': 3600,
    ...overrides,
  };
  return { get: (k) => m[k] };
}

function fakePlatform () {
  const state = new Map();
  const kv = new Map();
  return {
    async setAccessState (k, v, exp) { state.set(k, { value: v, expiresAt: exp }); },
    async setAccessStateIfAbsent (k, v, exp) { if (state.has(k)) return false; state.set(k, { value: v, expiresAt: exp }); return true; },
    async getAccessState (k) {
      const e = state.get(k);
      if (e == null) return null;
      if (Date.now() > e.expiresAt) { state.delete(k); return null; }
      return e;
    },
    async deleteAccessState (k) { state.delete(k); },
    async consumeAccessState (k) { const e = state.get(k); state.delete(k); return e ?? null; },
    async setPlatformKv (k, v) { kv.set(k, v); },
    async getPlatformKv (k) { return kv.has(k) ? kv.get(k) : null; },
    async deletePlatformKv (k) { kv.delete(k); },
    async listPlatformKvKeys (p) { return [...kv.keys()].filter((k) => k.startsWith(p)); },
    async listPlatformKvEntries (p) { return [...kv.entries()].filter(([k]) => k.startsWith(p)).map(([key, value]) => ({ key, value })); },
    async getAllCoreInfos () { return [{ id: CORE_ID }]; },
    _state: state,
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

/** Run `body` while recording the audit rows (the debug channel the audit helper writes first). */
async function auditRows (body) {
  const rows = [];
  const saved = process.env.OAUTH_AUDIT_DEBUG;
  const debug = console.debug;
  process.env.OAUTH_AUDIT_DEBUG = '1';
  console.debug = (tag, event, payload) => { if (tag === '[oauth.audit]') rows.push({ event, payload }); };
  try {
    await body();
  } finally {
    console.debug = debug;
    if (saved == null) delete process.env.OAUTH_AUDIT_DEBUG; else process.env.OAUTH_AUDIT_DEBUG = saved;
  }
  return rows;
}

const basic = (id, secret) => 'Basic ' + Buffer.from(id + ':' + secret).toString('base64');

const VERIFIER = 'v'.repeat(50);
const CHALLENGE = crypto.createHash('sha256').update(VERIFIER).digest('base64url');

const CONNECTOR = {
  clientId: 'conn-app',
  kind: 'registry',
  redirectUris: [REDIRECT],
  scope: ['read/a', 'read/b'],
  grantTypes: ['authorization_code', 'refresh_token'],
  tokenEndpointAuthMethod: 'none',
  allowedAudiences: [TEMPLATE],
  subjectType: 'public',
};

describe('[OPUA] OAuth2: per-user audiences', () => {
  let rsSecret;
  before(async () => { rsSecret = await mintSecret(); });
  beforeEach(() => {
    extension.setExtension(toyExtension());
    scopeGrammar._resetForTests();
    offerRoute._resetForTests();
  });
  afterEach(() => extension._resetForTests());

  describe('syntax and matching', () => {
    it('[OPUA1] a per-user audience: the accepted forms, and every other placement refused with the accepted form named', async () => {
      for (const ok of [TEMPLATE, 'https://{username}.example.com:8443/adapter/calendar/api', 'https://{username}.example.com/adapter/calendar/api?v=1',
        'https://{username}.example.com']) {
        assert.ok('probe' in audienceProbe(ok), ok);
      }
      assert.equal(audienceProbe(TEMPLATE).probe, 'https://a1b2c.example.com/adapter/calendar/api');
      assert.deepEqual(audienceProbe(REGION), { probe: REGION });
      const long = 'https://{username}.example.com/' + 'p'.repeat(MAX_TEMPLATE_BYTES - 'https://{username}.example.com/'.length + 1);
      assert.equal(Buffer.byteLength(long), 463);
      for (const bad of [
        'https://example.com/{username}/api', // in the path
        'https://x.{username}.example.com/api', // a later label
        'https://{username}-x.example.com/api', // glued
        'https://{username}.{username}.example.com/api', // twice
        'https://{username}.example.com/{username}', // twice, once in the path
        'http://{username}.example.com/api', // not https
        'https://{username}.example.com/api#frag', // fragment: refused by the URL rules on the probe
        'https://{username}.u@example.com/api', // user information
        'https://{username}./api', // no host after it
        'https://{username}.:8443/api',
        'https://{username}.ex%61mple.com/api', // a percent-escape in the host
        'https://{username}.example.com:443/api', // the default port spelt out
        long,
      ]) {
        const checked = audienceProbe(bad);
        const refused = 'problem' in checked || new URL(checked.probe).hash !== '';
        assert.ok(refused, bad);
        if ('problem' in checked) assert.match(checked.problem, /https:\/\/\{username\}\.<host>/);
      }
      assert.equal(MAX_TEMPLATE_BYTES, MAX_RESOURCE_BYTES - 50);
      // The registry: same rules, one code path (fragment included).
      for (const bad of ['https://example.com/{username}/api', 'https://{username}.example.com/api#f', 'https://{username}.u@example.com/api', long]) {
        await assert.rejects(registryRow(bad), /allowedAudiences/, bad);
      }
      await registryRow(TEMPLATE);
      // The metadata-document template: same rules.
      const problems = describeClientMetadataConfig({ mode: 'allowList', allowedHosts: ['client.example'], client: { scope: 'read/a', allowedAudiences: [TEMPLATE, 'https://x.{username}.example.com/'] } }).problems;
      assert.equal(problems.filter((p) => p.includes('allowedAudiences')).length, 1, JSON.stringify(problems));
      assert.match(problems.find((p) => p.includes('allowedAudiences')), /x\.\{username\}/);
    });

    it('[OPUA2] matching: the label in any host case, with a trailing slash; the stored audience is the instantiated entry; other shapes do not match', () => {
      for (const v of [at('alice'), 'https://ALICE.EXAMPLE.COM/adapter/calendar/api', at('alice') + '/', 'HTTPS://Alice.Example.com/adapter/calendar/api/']) {
        assert.deepEqual(matchAudience(v, [TEMPLATE]), { audience: at('alice'), label: 'alice' }, v);
      }
      // The label shape alone: an IDNA label matches here (no account can hold it; the binding refuses it).
      assert.deepEqual(matchAudience(at('xn--abc1'), [TEMPLATE]), { audience: at('xn--abc1'), label: 'xn--abc1' });
      for (const v of [
        'https://alice.example.com/Adapter/calendar/api', // path case
        at('ab'), // too short
        'https://al.ice.example.com/adapter/calendar/api', // a dot
        at('a'.repeat(61)), // too long
        at('-alice'),
        'http://alice.example.com/adapter/calendar/api',
        'https://u@alice.example.com/adapter/calendar/api',
        'https://alice.example.com:443/adapter/calendar/api',
        'https://alice.example.com/adapter/calendar/api/more',
        'https://evil.test/x.example.com/adapter/calendar/api',
      ]) {
        assert.equal(matchAudience(v, [TEMPLATE]), null, v);
      }
      assert.deepEqual(matchAudience(at('a'.repeat(60)), [TEMPLATE]).label, 'a'.repeat(60));
      // The entry's spelling: host lowercased, path as written.
      assert.deepEqual(matchAudience('https://alice.example.com/A/b/', ['https://{username}.EXAMPLE.com/A/b/']), { audience: 'https://alice.example.com/A/b/', label: 'alice' });
      // A malformed per-user entry matches nothing.
      assert.equal(matchAudience('https://example.com/alice/api', ['https://example.com/{username}/api']), null);
    });

    it('[OPUA3] exact entries first: a region address listed exactly binds no account; against the per-user entry alone it reads as a label', () => {
      assert.deepEqual(matchAudience(REGION, [REGION, TEMPLATE]), { audience: REGION, label: null });
      assert.deepEqual(matchAudience(REGION, [TEMPLATE, REGION]), { audience: REGION, label: null });
      assert.deepEqual(matchAudience(REGION, [TEMPLATE]), { audience: REGION, label: 'auth-ch' });
      assert.deepEqual(matchAudience(at('alice'), [REGION, TEMPLATE]), { audience: at('alice'), label: 'alice' });
    });

    it('[OPUA4] the cap: a 512-byte address of a 462-byte entry is matched; 513 bytes is refused before matching', () => {
      const base = 'https://{username}.example.com/';
      const entry = base + 'p'.repeat(MAX_TEMPLATE_BYTES - base.length);
      assert.equal(Buffer.byteLength(entry), 462);
      assert.ok('probe' in audienceProbe(entry));
      const label = 'a'.repeat(60);
      const value = entry.replace('{username}', label);
      assert.equal(Buffer.byteLength(value), 512);
      assert.ok(withinResourceCap(value, [entry]));
      assert.equal(matchAudience(value, [entry]).label, label);
      const tooLong = value + 'x';
      assert.equal(withinResourceCap(tooLong, [entry]), false);
    });

    it('[OPUA6] the binding: the platform\'s own names first, then the current username or an address alias', () => {
      const routed = (names) => (l) => names.includes(l);
      assert.equal(labelNamesAccount('alice', { username: 'alice' }, routed([])), true);
      assert.equal(labelNamesAccount('ALICE', { username: 'alice' }, routed([])), true);
      // The platform routes the name: refused, even for the account that holds it.
      assert.equal(labelNamesAccount('alice', { username: 'alice' }, routed(['alice'])), false);
      assert.equal(labelNamesAccount('auth-x', { username: 'bob' }, routed([])), false);
      assert.equal(labelNamesAccount('xn--abc1', { username: 'bob' }), false);
      // An address alias of the account; a routed alias is refused too.
      assert.equal(labelNamesAccount('addr-alice', { username: 'alice', addressAliases: ['addr-alice'] }, routed([])), true);
      assert.equal(labelNamesAccount('addr-alice', { username: 'alice', addressAliases: ['addr-alice'] }, routed(['addr-alice'])), false);
      assert.equal(labelNamesAccount('addr-bob', { username: 'alice', addressAliases: ['addr-alice'] }, routed([])), false);
      // The consent helper: exact entries and listless clients bind nothing; an unlisted audience is told apart.
      const client = { allowedAudiences: [REGION, TEMPLATE] };
      assert.equal(consentAudienceRefusal(REGION, client, { username: 'bob' }), null);
      assert.equal(consentAudienceRefusal(at('alice'), client, { username: 'alice' }), null);
      assert.equal(consentAudienceRefusal(at('alice'), client, { username: 'bob' }), 'mismatch');
      assert.equal(consentAudienceRefusal(at('alice'), { anyAudience: true, allowedAudiences: [] }, { username: 'bob' }), null);
      assert.equal(consentAudienceRefusal('https://gone.example.com/', client, { username: 'bob' }), 'unlisted');
      assert.equal(consentAudienceRefusal(undefined, client, { username: 'bob' }), null);
      // The client row gone since /authorize: an audience is refused, none is not checked.
      assert.equal(consentAudienceRefusal(at('alice'), null, { username: 'alice' }), 'unlisted');
      assert.equal(consentAudienceRefusal(undefined, null, { username: 'alice' }), null);
    });

    it('[OPUC1] the registry: adding a per-user audience is a widening (vetted), removing one a narrowing', () => {
      const before = { ...CONNECTOR, allowedAudiences: [REGION] };
      const after = { ...CONNECTOR, allowedAudiences: [REGION, TEMPLATE] };
      assert.ok(changedVettedFields(before, after).includes('allowedAudiences'));
      assert.deepEqual(narrowedGrantFields(before, after), []);
      assert.deepEqual(narrowedGrantFields(after, before), ['allowedAudiences']);
    });
  });

  // --- Consent ---------------------------------------------------------------

  async function seedConnector (platform, extra = {}) {
    await persistClient(platform, { ...CONNECTOR, ...extra });
  }

  async function authorize (platform, value, extra = {}) {
    const res = fakeRes();
    await handleAuthorize({ config: fakeConfig(), platform })({
      method: 'GET',
      query: {
        client_id: 'conn-app',
        redirect_uri: REDIRECT,
        response_type: 'code',
        code_challenge: CHALLENGE,
        code_challenge_method: 'S256',
        state: 'client-state',
        scope: 'read/a',
        resource: value,
        ...extra,
      },
    }, res);
    const location = res.headers.location ?? '';
    return { res, signed: location.startsWith(CONSENT_URL) ? new URL(location).searchParams.get('state') : null, location };
  }

  function consentDeps (platform, session, calls, more = {}) {
    return {
      config: fakeConfig(),
      platform,
      resolveUser: async () => ({ userId: USER_ID, username: 'alice', personal: true, ...session }),
      createAccess: async (params) => {
        calls.push(params);
        return { accessId: 'session-' + calls.length, accessToken: 'tok-' + calls.length, apiEndpoint: 'https://alice.example.com/', dataGrantAccessId: 'grant-1', permissions: params.grantedPermissions };
      },
      ...more,
    };
  }

  async function offer (deps, signed) {
    const res = fakeRes();
    await handleOffer(deps)({ body: { state: signed, username: 'whoever', userToken: 'personal' } }, res);
    return res;
  }

  async function accept (deps, signed) {
    const res = fakeRes();
    await handleAccept(deps)({ body: { state: signed, username: 'whoever', userToken: 'personal', grantedPermissions: [{ streamId: 'a', level: 'read' }] } }, res);
    return res;
  }

  describe('consent', () => {
    it('[OPUE9] an address alias of the signed-in account is its address; another account\'s alias, or a former username, is not', async () => {
      const platform = fakePlatform();
      await seedConnector(platform);
      const a = await authorize(platform, at('addr-alice'));
      assert.ok(a.signed, a.location);
      const calls = [];
      const own = consentDeps(platform, { username: 'alice', addressAliases: ['addr-alice'] }, calls);
      assert.equal((await offer(own, a.signed)).statusCode, 200);
      const ok = await accept(own, a.signed);
      assert.equal(ok.statusCode, 200, ok.raw);
      assert.equal(calls[0].audience, at('addr-alice'));
      // The grant adopts the address alias: a pseudonymous grant with that alias.
      assert.deepEqual([calls[0].offer.randomAlias, calls[0].offer.adoptAlias], [true, 'addr-alice']);
      const shown = await offer(own, a.signed);
      assert.equal(shown.body.addressAlias, 'addr-alice');
      // At the username's own address nothing is adopted.
      const plain = await authorize(platform, at('alice'));
      await accept(own, plain.signed);
      assert.equal(calls[1].offer.adoptAlias, undefined);
      calls.length = 1;
      for (const session of [{ username: 'bob', addressAliases: ['addr-bob'] }, { username: 'alice-renamed', addressAliases: [] }]) {
        const refused = await accept(consentDeps(platform, session, calls), a.signed);
        assert.equal(refused.statusCode, 403, refused.raw);
        assert.deepEqual(refused.body, { error: 'access_denied', error_description: 'the requested resource names another account\'s address', reason: 'audience-account-mismatch' });
      }
      assert.equal(calls.length, 1, 'nothing minted for a refused consent');
    });

    it('[OPUE11] the platform\'s own name is refused at /offer and /accept for the account that holds it, audited without a username; nothing written', async () => {
      const platform = fakePlatform();
      await seedConnector(platform);
      const a = await authorize(platform, at('svc-alpha'));
      assert.ok(a.signed, a.location);
      const calls = [];
      const deps = consentDeps(platform, { username: 'svc-alpha' }, calls, { isPlatformRoutedLabel: (l) => l === 'svc-alpha' });
      let o, r;
      const rows = await auditRows(async () => {
        o = await offer(deps, a.signed);
        r = await accept(deps, a.signed);
      });
      for (const res of [o, r]) {
        assert.equal(res.statusCode, 403, res.raw);
        assert.equal(res.body.reason, 'audience-account-mismatch');
      }
      assert.equal(calls.length, 0);
      assert.equal([...platform._state.keys()].filter((k) => k.startsWith('oauth-ac/')).length, 0);
      const refused = rows.filter((x) => x.event === 'oauth.consent.refused');
      assert.equal(refused.length, 2);
      assert.ok(refused.every((x) => x.payload.reason === 'audience-account-mismatch'));
      assert.ok(!JSON.stringify(rows).includes('svc-alpha'), 'no username nor label in the audit rows');
      // Without the predicate the same account would be bound (what the predicate closes).
      const unguarded = await accept(consentDeps(platform, { username: 'svc-alpha' }, calls), a.signed);
      assert.equal(unguarded.statusCode, 200, unguarded.raw);
    });

    it('[OPUE12] the client\'s list changed since /authorize: the audience is not bound to a stale list (invalid_target, restart)', async () => {
      const platform = fakePlatform();
      await seedConnector(platform);
      const a = await authorize(platform, at('alice'));
      // The list changed under the same client version (a registry edit also ends the flow by its version).
      const row = await getClient(platform, 'conn-app');
      await setClient(platform, { ...row, allowedAudiences: [REGION] });
      const calls = [];
      const deps = consentDeps(platform, {}, calls);
      for (const res of [await offer(deps, a.signed), await accept(deps, a.signed)]) {
        assert.equal(res.statusCode, 400, res.raw);
        assert.deepEqual([res.body.error, res.body.reason], ['invalid_target', 'audience-not-listed']);
      }
      assert.equal(calls.length, 0);
    });
  });

  // --- Token exchange --------------------------------------------------------

  async function seededExchange (audience = at('alice'), rsAudiences = [TEMPLATE]) {
    const platform = fakePlatform();
    await persistClient(platform, CONNECTOR);
    const rs = { ...CONNECTOR, tokenEndpointAuthMethod: 'client_secret_basic', clientSecretHash: rsSecret.hash, canExchange: true };
    await persistClient(platform, { ...rs, clientId: 'rs-one', allowedAudiences: rsAudiences });
    await setSessionIndex(platform, 'subject-token', {
      userId: USER_ID,
      accessId: 'session-1',
      clientId: 'conn-app',
      coreId: CORE_ID,
      expiresAt: Date.now() + 3600e3,
      dataGrantAccessId: 'grant-1',
      coreTokens: [],
      grammarTokens: ['read/a'],
      audience,
    });
    return platform;
  }

  function subjectSession (overrides = {}) {
    const now = Date.now() / 1000;
    return {
      username: 'alice',
      created: now - 10,
      expires: now + 1800,
      permissions: [{ streamId: 'a', level: 'read' }],
      subject: USER_ID,
      aliased: false,
      apiBase: 'https://alice.example.com/',
      addressAliases: [],
      ...overrides,
    };
  }

  function derivedStore () {
    const rows = new Map();
    const calls = [];
    let n = 0;
    return {
      calls,
      async issue (params) {
        const key = params.clientId + '|' + params.subjectAccessId;
        const existing = rows.get(key);
        calls.push(params);
        if (existing != null) return { ...existing, reused: true };
        n++;
        const row = { accessId: 'derived-' + n, accessToken: 'derived-token-' + n, expires: Math.floor(params.expiresAt / 1000) };
        rows.set(key, row);
        return { ...row, reused: false };
      },
    };
  }

  async function exchange (platform, { body = {}, subject = subjectSession(), store = derivedStore(), isPlatformRoutedLabel } = {}) {
    const res = fakeRes();
    await handleToken({
      config: fakeConfig(),
      platform,
      resolveUsername: async () => 'alice',
      readSubjectSession: async () => subject,
      issueDerivedSession: (p) => store.issue(p),
      coreUrlFor: async (id) => 'https://' + id + '.example.com',
      ...(isPlatformRoutedLabel != null ? { isPlatformRoutedLabel } : {}),
    })({
      headers: { authorization: basic('rs-one', rsSecret.plaintext) },
      body: { grant_type: TOKEN_EXCHANGE, subject_token: 'subject-token', subject_token_type: ACCESS_TOKEN_TYPE, ...body },
    }, res);
    return res;
  }

  const NOT_ACTIVE = { error: 'invalid_grant', error_description: 'subject token is not active' };
  const MISMATCH = { error: 'invalid_target', error_description: 'the subject token was not issued for the resource it was presented at' };

  describe('token exchange', () => {
    it('[OPUX1] a resource server listing the per-user audience exchanges a token issued for an account\'s address; again: the same token', async () => {
      const platform = await seededExchange();
      const store = derivedStore();
      const first = await exchange(platform, { store });
      assert.equal(first.statusCode, 200, first.raw);
      const again = await exchange(platform, { store });
      assert.equal(again.body.access_token, first.body.access_token);
    });

    it('[OPUX2] an exact-only resource server does not take a per-user token, nor a per-user-only one a region token', async () => {
      for (const [audience, rsAudiences] of [[at('alice'), [REGION]], [REGION, [TEMPLATE.replace('example.com', 'other.example')]]]) {
        const platform = await seededExchange(audience, rsAudiences);
        let res;
        const rows = await auditRows(async () => { res = await exchange(platform); });
        assert.equal(res.statusCode, 400, res.raw);
        assert.equal(res.body.error, 'invalid_target');
        assert.equal(rows[0].payload.reason, 'foreign-audience');
      }
      // A region address on a per-user-only resource server reads as the label `auth-ch`: no account of that name.
      const platform = await seededExchange(REGION, [TEMPLATE]);
      assert.deepEqual((await exchange(platform)).body, NOT_ACTIVE);
    });

    it('[OPUX3] an index row whose audience names another account\'s address: invalid_grant uniform, audited audience-account-mismatch', async () => {
      const platform = await seededExchange(at('bob-account'));
      const store = derivedStore();
      let res;
      const rows = await auditRows(async () => { res = await exchange(platform, { store }); });
      assert.equal(res.statusCode, 400, res.raw);
      assert.deepEqual(res.body, NOT_ACTIVE);
      assert.deepEqual(rows, [{ event: 'oauth.token.exchange_refused', payload: { clientId: 'rs-one', reason: 'audience-account-mismatch' } }]);
      assert.equal(store.calls.length, 0);
    });

    it('[OPUX5] the exchange takes an address alias or a former username the subject account still holds; an exact entry binds nothing', async () => {
      const platform = await seededExchange(at('addr-alice'));
      assert.equal((await exchange(platform, { subject: subjectSession({ addressAliases: ['addr-alice'] }) })).statusCode, 200);
      assert.deepEqual((await exchange(platform)).body, NOT_ACTIVE);
      // Renamed alice -> alice2: the chain at alice's address keeps exchanging while the account holds the name.
      const renamed = await seededExchange(at('alice'));
      assert.equal((await exchange(renamed, { subject: subjectSession({ username: 'alice2', formerUsernames: ['alice'] }) })).statusCode, 200);
      let res;
      const rows = await auditRows(async () => {
        res = await exchange(renamed, { subject: subjectSession({ username: 'alice2', formerUsernames: ['someone-else'] }) });
      });
      assert.deepEqual(res.body, NOT_ACTIVE);
      assert.equal(rows[0].payload.reason, 'audience-account-mismatch');
      // A former username the platform now routes is refused like any routed name.
      const routedFormer = await exchange(renamed, { subject: subjectSession({ username: 'alice2', formerUsernames: ['alice'] }), isPlatformRoutedLabel: (l) => l === 'alice' });
      assert.deepEqual(routedFormer.body, NOT_ACTIVE);
      const exact = await seededExchange(REGION, [REGION, TEMPLATE]);
      assert.equal((await exchange(exact)).statusCode, 200);
    });

    it('[OPUX6] subject_token_resource naming the token\'s audience (any host case, trailing slash): the same derived token as without it', async () => {
      const platform = await seededExchange();
      const store = derivedStore();
      const plain = await exchange(platform, { store });
      assert.equal(plain.statusCode, 200, plain.raw);
      for (const value of [at('alice'), at('alice') + '/', 'https://ALICE.example.com/adapter/calendar/api']) {
        const res = await exchange(platform, { store, body: { subject_token_resource: value } });
        assert.equal(res.statusCode, 200, value + ': ' + res.raw);
        assert.equal(res.body.access_token, plain.body.access_token);
      }
      assert.equal((await getSessionIndex(platform, plain.body.access_token)).audience, undefined, 'the derived token has no audience');
    });

    it('[OPUX7] subject_token_resource naming another address: invalid_target, audited subject-resource-mismatch, nothing minted nor indexed', async () => {
      for (const [audience, rsAudiences, presented] of [
        [at('alice'), [TEMPLATE, REGION], at('bob-account')],
        [at('alice'), [TEMPLATE, REGION], REGION],
        [REGION, [TEMPLATE, REGION], at('alice')],
      ]) {
        const platform = await seededExchange(audience, rsAudiences);
        const store = derivedStore();
        let res;
        const rows = await auditRows(async () => { res = await exchange(platform, { store, body: { subject_token_resource: presented } }); });
        assert.equal(res.statusCode, 400, res.raw);
        assert.deepEqual(res.body, MISMATCH);
        assert.deepEqual(rows, [{ event: 'oauth.token.exchange_refused', payload: { clientId: 'rs-one', reason: 'subject-resource-mismatch' } }]);
        assert.equal(store.calls.length, 0);
        assert.equal([...platform._state.keys()].filter((k) => k.startsWith('oauth-at/')).length, 1, 'no index row written');
      }
    });

    it('[OPUX8] the shape of subject_token_resource: array, non-string, too long, plain http, a placeholder, user information refused; absent or empty accepted', async () => {
      const platform = await seededExchange();
      for (const [value, error] of [
        [[at('alice'), at('alice')], 'invalid_target'],
        [42, 'invalid_request'],
        ['https://alice.example.com/' + 'p'.repeat(MAX_RESOURCE_BYTES), 'invalid_target'],
        ['http://alice.example.com/adapter/calendar/api', 'invalid_target'],
        [TEMPLATE, 'invalid_target'],
        ['https://u@alice.example.com/adapter/calendar/api', 'invalid_target'],
      ]) {
        let res;
        const rows = await auditRows(async () => { res = await exchange(platform, { body: { subject_token_resource: value } }); });
        assert.equal(res.statusCode, 400, JSON.stringify(value) + ': ' + res.raw);
        assert.equal(res.body.error, error, JSON.stringify(value));
        assert.equal(rows[0].payload.reason, 'request-shape');
      }
      for (const body of [{}, { subject_token_resource: '' }]) {
        assert.equal((await exchange(platform, { body })).statusCode, 200);
      }
    });

    it('[OPUX9] on another core: a mismatching subject_token_resource is refused before the core is named; the matching one gets 421', async () => {
      const platform = await seededExchange();
      const row = await getSessionIndex(platform, 'subject-token');
      await setSessionIndex(platform, 'subject-token', { ...row, coreId: 'core-b' });
      const refused = await exchange(platform, { body: { subject_token_resource: at('bob-account') } });
      assert.deepEqual([refused.statusCode, refused.body], [400, MISMATCH]);
      assert.ok(!refused.raw.includes('core-b'), 'no core URL');
      const moved = await exchange(platform, { body: { subject_token_resource: at('alice') } });
      assert.deepEqual([moved.statusCode, moved.body], [421, { error: 'wrong_core', coreUrl: 'https://core-b.example.com' }]);
      // OPUX4: the per-user audience matches, then the 421 (the audience check comes first).
      assert.equal((await exchange(platform)).statusCode, 421);
    });

    it('[OPUX10] an index row naming a platform name as the address of the account holding it: invalid_grant, audience-account-mismatch', async () => {
      const platform = await seededExchange(at('svc-alpha'));
      let res;
      const rows = await auditRows(async () => {
        res = await exchange(platform, { subject: subjectSession({ username: 'svc-alpha' }), isPlatformRoutedLabel: (l) => l === 'svc-alpha' });
      });
      assert.deepEqual(res.body, NOT_ACTIVE);
      assert.equal(rows[0].payload.reason, 'audience-account-mismatch');
      assert.equal((await exchange(platform, { subject: subjectSession({ username: 'svc-alpha' }) })).statusCode, 200, 'without the predicate');
    });
  });
});

/** A registry row naming one audience, through the registry's validator. */
async function registryRow (audience) {
  await persistClient(fakePlatform(), { ...CONNECTOR, allowedAudiences: [audience] });
}
