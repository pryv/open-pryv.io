/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */

/**
 * [CFGU] the effective configuration document over in-memory configuration
 * layers: classification completeness, the no-leak canary, the value scan,
 * the environment layer, sources, fingerprints, digests and odd values.
 */

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import yaml from 'js-yaml';
import {
  buildEffectiveConfig, computeDigests, findRule, RULES, stableStringify, FORMAT
} from '../../src/effectiveConfig/index.ts';

const here = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_CONFIG_PATH = path.resolve(here, '../../../../config/default-config.yml');
const FILES_SECRET = 'files-read-token-secret-for-unit-tests-0123';

function loadDefault () {
  return yaml.load(fs.readFileSync(DEFAULT_CONFIG_PATH, 'utf8'));
}

function isPlainObject (v) {
  return v != null && typeof v === 'object' && !Array.isArray(v);
}

function clone (v) {
  return v;
}

function own (o, k) {
  return Object.prototype.hasOwnProperty.call(o, k) ? o[k] : undefined;
}

function deepMerge (target, source) {
  for (const k of Object.keys(source)) {
    const value = (isPlainObject(source[k]) && isPlainObject(own(target, k)))
      ? deepMerge(Object.assign({}, own(target, k)), source[k])
      : source[k];
    Object.defineProperty(target, k, { value, enumerable: true, writable: true, configurable: true });
  }
  return target;
}

// The boiler's resolution: from the highest scope down to the first non-object
// value, objects merged with the higher scopes winning.
function mergedOf (scopes) {
  return (key) => {
    const objects = [];
    let found;
    for (const scope of scopes) {
      const v = scope.tree[key];
      if (v === undefined) continue;
      if (isPlainObject(v)) { objects.push(v); continue; }
      found = v;
      break;
    }
    if (objects.length === 0) return clone(found);
    let out = {};
    for (let i = objects.length - 1; i >= 0; i--) out = deepMerge(out, objects[i]);
    return out;
  };
}

/** Layers, highest priority first; `default-file` is the shipped default unless given. */
function build (layers = {}, options = {}) {
  const order = ['memory', 'override-file', 'bootstrap-file', 'test', 'argv', 'env', 'base', 'default-file'];
  const trees = Object.assign({ 'default-file': loadDefault() }, layers);
  if (trees.test == null) trees.test = { auth: { filesReadTokenSecret: FILES_SECRET } };
  const scopes = order.filter((n) => trees[n] != null).map((name) => ({ name, tree: trees[name] }));
  return buildEffectiveConfig({
    scopes,
    merged: mergedOf(scopes),
    observability: options.observability ?? null,
    coreId: 'core-a',
    apiVersion: '9.9.9',
    now: new Date(0)
  });
}

// The document's walk: a secret or opaque node is one entry, never descended.
function leafPaths (node, segments, out) {
  const rule = segments.length > 0 ? findRule(segments) : null;
  if (rule != null && (rule.class === 'secret' || rule.class === 'opaque')) {
    out.push(segments);
    return out;
  }
  if (isPlainObject(node) && Object.keys(node).length > 0) {
    for (const k of Object.keys(node)) leafPaths(node[k], [...segments, k], out);
    return out;
  }
  if (Array.isArray(node) && node.some((x) => x !== null && typeof x === 'object')) {
    node.forEach((x, i) => leafPaths(x, [...segments, String(i)], out));
    return out;
  }
  out.push(segments);
  return out;
}

function setPath (tree, segments, value) {
  let cur = tree;
  for (let i = 0; i < segments.length - 1; i++) {
    if (!isPlainObject(cur[segments[i]])) cur[segments[i]] = {};
    cur = cur[segments[i]];
  }
  cur[segments[segments.length - 1]] = value;
}

describe('[CFGU] effective configuration document', function () {
  it('[CFC1] every leaf of default-config.yml matches an explicit rule with a scope', function () {
    const missing = [];
    for (const segments of leafPaths(loadDefault(), [], [])) {
      const rule = findRule(segments);
      if (rule == null || (rule.scope !== 'platform' && rule.scope !== 'core')) missing.push(segments.join('.'));
    }
    assert.deepEqual(missing, [], 'unclassified keys in default-config.yml: add a rule in effectiveConfig/classification.ts');
  });

  it('[CFC2] no shipped key is redacted by the name heuristic; a new secret-looking key is', function () {
    const doc = build();
    const unclassified = Object.keys(doc.keys).filter((k) => doc.keys[k].class === 'unclassified');
    assert.deepEqual(unclassified, [], 'a public key hits the name heuristic: add it to NAME_EXCEPTIONS if its value is not a secret');
    const doc2 = build({ 'override-file': { limits: { fooSecret: 'not shown', barToken: 12, bazKey: 'x' } } });
    for (const k of ['limits.fooSecret', 'limits.barToken', 'limits.bazKey']) {
      assert.equal(doc2.keys[k].redacted, true, k);
      assert.equal(doc2.keys[k].class, 'unclassified', k);
    }
  });

  it('[CFC3] no secret, opaque, unclassified or out-of-universe value appears; every public one does', function () {
    const def = loadDefault();
    const override = {};
    let n = 0;
    const secret = () => 'SECRETCANARY-' + (n++) + '-x';
    let m = 0;
    const pub = [];
    const publicValue = () => { const v = 'PUBCANARY-' + (m++); pub.push(v); return v; };
    // every secret / opaque rule without a wildcard
    for (const rule of RULES) {
      if (rule.class !== 'secret' && rule.class !== 'opaque') continue;
      if (rule.pattern.some((s) => s === '*' || s === '**')) continue;
      if (rule.pattern.join('.') === 'auth.filesReadTokenSecret') continue;
      setPath(override, rule.pattern, rule.class === 'opaque' ? { a: { url: secret(), headers: { k: secret() } } } : secret());
    }
    override.invitationTokens = [secret(), secret()];
    override.sso.providers = { google: { issuer: 'https://idp.example.com', clientId: publicValue(), clientSecret: secret(), label: publicValue() } };
    override.oauth.signingKeys = [{ kid: publicValue(), privateKeyPem: secret() }, { kid: publicValue(), privateKeyFile: publicValue() }];
    override.custom = { dataStores: [{ id: publicValue(), settings: { token: secret(), nested: { password: secret() } } }] };
    override.logs = { custom: { active: true, settings: { apiKey: secret() } } };
    // every public string leaf of the default file gets a public canary
    for (const segments of leafPaths(def, [], [])) {
      const rule = findRule(segments);
      if (rule == null || rule.class !== 'public') continue;
      const cur = segments.reduce((o, s) => (o == null ? undefined : o[s]), def);
      if (typeof cur !== 'string') continue;
      if (segments[0] === 'custom' || segments[0] === 'logs') continue;
      setPath(override, segments, publicValue());
    }
    // unclassified keys, and keys outside the reported universe in every layer
    override.auth.someNewThing = secret();
    override.operatorTypo = { value: secret() };
    const env = { PATH: secret(), HOME: secret(), DATABASE_URL: 'postgres://u:' + secret() + '@h/db', auth: { filesReadTokenSecret: FILES_SECRET } };
    const argv = { config: secret(), bootstrap: secret() };
    const memory = { systemStreams: { x: secret() }, somethingDerived: secret() };
    const doc = build({ 'override-file': override, env, argv, memory, test: {} });
    const json = JSON.stringify(doc);
    assert.equal(json.includes('SECRETCANARY'), false, 'a secret value leaked: ' + (json.match(/"[^"]*SECRETCANARY[^"]*"/) || [])[0]);
    assert.equal(json.includes(FILES_SECRET), false);
    for (const v of pub) assert.ok(json.includes('"' + v + '"'), 'public value missing: ' + v);
    assert.ok(n > 20, 'the canary walk covered secrets');
    assert.deepEqual(doc.configMeta.unknownTopLevelKeys, ['operatorTypo']);
    for (const k of Object.keys(doc.keys)) {
      assert.ok(['PATH', 'HOME', 'DATABASE_URL', 'config', 'bootstrap', 'systemStreams', 'somethingDerived', 'operatorTypo'].every((t) => k !== t && !k.startsWith(t + '.')), k);
    }
    assert.equal(doc.keys['auth.someNewThing'].class, 'unclassified');
    assert.equal(doc.keys['invitationTokens'].size, 2);
    assert.equal(doc.keys['services.mfa.methods.sms.endpoints'].class, 'opaque');
    assert.equal(doc.keys['custom.dataStores.0.settings'].class, 'opaque');
  });

  it('[CFC4] the value scan redacts secret-looking strings whatever their key', function () {
    const adminKey = 'an-admin-key-0123456789abcdef';
    const doc = build({
      'override-file': {
        auth: { adminAccessKey: adminKey, passwordResetPageURL: 'https://u:p@reset.example.com/a?t=1&x=2#frag', trustedApps: ['https://app.example.com/?k=v', 'plain'] },
        dns: { domain: 'prefix-' + adminKey },
        reporting: { templateVersion: '-----BEGIN PRIVATE KEY-----' },
        caching: { isActive: 'Bearer abc' },
        trace: { enable: 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.c2ln' },
        tcpBroker: { port: '0123456789abcdef0123456789abcdef' },
        migrations: { autoRunOnStart: 'Ab3dEfGhIjKlMnOpQrStUvWxYz0123456789AbCdEf==' },
        storages: { engines: { rqlite: { url: 'http://user:pw@rqlite.local:4001/path?q=1' } } }
      }
    });
    const k = doc.keys;
    assert.equal(k['dns.domain'].class, 'value-pattern');
    assert.equal(k['reporting.templateVersion'].class, 'value-pattern');
    assert.equal(k['caching.isActive'].class, 'value-pattern');
    assert.equal(k['trace.enable'].class, 'value-pattern');
    assert.equal(k['tcpBroker.port'].class, 'value-pattern');
    assert.equal(k['migrations.autoRunOnStart'].class, 'value-pattern');
    assert.deepEqual(k['auth.passwordResetPageURL'], { value: 'https://***@reset.example.com/a?t=***&x=***', sanitized: true, source: 'override-file', scope: 'platform' });
    assert.deepEqual(k['auth.trustedApps'].value, ['https://app.example.com/?k=***', 'plain']);
    assert.equal(k['auth.trustedApps'].sanitized, true);
    assert.equal(k['storages.engines.rqlite.url'].value, 'http://rqlite.local:4001');
    assert.equal(JSON.stringify(doc).includes(adminKey), false);
  });

  it('[CFC5] the environment layer reports only keys under known sections', function () {
    const doc = build({ env: { PATH: '/usr/bin', HOME: '/root', auth: { filesReadTokenSecret: FILES_SECRET, foo: 'bar' }, http: { port: 4242 }, platform: 'linux/amd64' } });
    assert.equal(doc.keys.PATH, undefined);
    assert.equal(doc.keys.HOME, undefined);
    assert.equal(doc.keys['auth.foo'].source, 'env');
    assert.equal(doc.keys['auth.foo'].class, 'unclassified');
    assert.deepEqual(doc.keys['http.port'], { value: 4242, source: 'env', scope: 'core' });
    assert.equal(doc.keys.platform.class, 'shape-mismatch');
    assert.equal(doc.keys['platform.piiMode'], undefined);
  });

  it('[CFC6] sources, arrays, escaped segments and the observability overlay', function () {
    const parsed = JSON.parse('{"limits": {"__proto__": {"x": 1}, "a.b": 2}}');
    const doc = build({
      memory: { core: { url: 'https://core-a.example.com/' } },
      'override-file': Object.assign(parsed, { http: { trustedProxies: ['loopback', '10.0.0.0/8'] } }),
      argv: { http: { port: 3999 } },
      base: { uploads: { maxFiles: 3 } }
    }, {
      observability: {
        values: { enabled: true, provider: 'otlp', appName: 'x', logLevel: 'error', otlp: { endpoint: 'https://otlp.example.com/v1?key=abc', headers: { 'api-key': 'k' }, flushIntervalSeconds: null } },
        origins: { enabled: 'db', provider: 'db', appName: 'local', logLevel: 'default', endpoint: 'db', headers: 'db', flushIntervalSeconds: 'default' }
      }
    });
    const k = doc.keys;
    assert.equal(k['core.url'].source, 'derived');
    assert.equal(k['http.port'].source, 'argv');
    assert.equal(k['uploads.maxFiles'].source, 'base-file');
    assert.equal(k['uploads.maxSizeMb'].source, 'default-file');
    assert.equal(k['auth.filesReadTokenSecret'].source, 'test');
    assert.deepEqual(k['http.trustedProxies'].value, ['loopback', '10.0.0.0/8']);
    assert.equal(k['limits.__proto__.x'].value, 1);
    assert.equal(k['limits.a\\.b'].value, 2);
    assert.equal(Object.getPrototypeOf(k), null);
    assert.equal(k['observability.enabled'].source, 'platform-db');
    assert.equal(k['observability.logLevel'].source, 'derived');
    assert.deepEqual(k['observability.otlp.endpoint'], { value: 'https://otlp.example.com', sanitized: true, source: 'platform-db', scope: 'platform' });
    assert.equal(k['observability.otlp.headers'].class, 'opaque');
    assert.equal(k['observability.otlp.headers'].source, 'platform-db');
    const sorted = Object.keys(k).slice().sort();
    assert.deepEqual(Object.keys(k), sorted);
  });

  it('[CFC7] fingerprints compare across cores without revealing secrets', function () {
    const layer = (pass, fs = FILES_SECRET) => ({ test: { auth: { filesReadTokenSecret: fs } }, 'override-file': { services: { email: { smtp: { auth: { pass } } } }, oauth: { stateKey: 'same-value-1234567890' }, sso: { stateKey: 'same-value-1234567890' } } });
    const a = build(layer('pw-one'));
    const b = build(layer('pw-one'));
    const c = build(layer('pw-two'));
    const fpA = a.keys['services.email.smtp.auth.pass'].fingerprint;
    assert.match(fpA, /^[0-9a-f]{12}$/);
    assert.equal(b.keys['services.email.smtp.auth.pass'].fingerprint, fpA);
    assert.notEqual(c.keys['services.email.smtp.auth.pass'].fingerprint, fpA);
    assert.notEqual(a.keys['oauth.stateKey'].fingerprint, a.keys['sso.stateKey'].fingerprint);
    assert.equal(a.keys['auth.filesReadTokenSecret'].fingerprint, undefined);
    assert.equal(a.configMeta.secretFingerprints, true);
    assert.equal(a.keys['letsEncrypt.atRestKey'].placeholder, true);
    for (const weak of ['REPLACE ME', 'short']) {
      const d = build(layer('pw-one', weak));
      assert.equal(d.configMeta.secretFingerprints, false);
      assert.equal(JSON.stringify(d).includes('"fingerprint"'), false);
    }
    // unset secret: no fingerprint
    assert.equal(a.keys['platform.piiHmacKey'].set, false);
    assert.equal(a.keys['platform.piiHmacKey'].fingerprint, undefined);
  });

  it('[CFC8] digests ignore order and sources, and split platform from core keys', function () {
    const base = build({ 'override-file': { dns: { domain: 'example.com' }, http: { port: 3000 } } });
    const fromEnv = build({ env: { http: { port: 3000 }, dns: { domain: 'example.com' } } });
    assert.deepEqual(fromEnv.configMeta.digests, base.configMeta.digests);
    const portChanged = build({ 'override-file': { dns: { domain: 'example.com' }, http: { port: 3001 } } });
    assert.equal(portChanged.configMeta.digests.platform, base.configMeta.digests.platform);
    assert.notEqual(portChanged.configMeta.digests.full, base.configMeta.digests.full);
    const domainChanged = build({ 'override-file': { dns: { domain: 'example.org' }, http: { port: 3000 } } });
    assert.notEqual(domainChanged.configMeta.digests.platform, base.configMeta.digests.platform);
    // recomputable from the document
    const full = {};
    for (const k of Object.keys(base.keys)) { const { source, scope, ...rest } = base.keys[k]; full[k] = rest; }
    assert.equal(base.configMeta.digests.full, createHash('sha256').update(stableStringify({ format: FORMAT, keys: full })).digest('hex'));
    assert.deepEqual(computeDigests(base.keys), base.configMeta.digests);
    assert.equal(stableStringify({ b: 1, a: [2, { d: 1, c: undefined }] }), '{"a":[2,{"d":1}],"b":1}');
  });

  it('[CFC9] functions, class instances, cycles, depth and long strings are redacted', function () {
    const cycle = { a: 1 };
    cycle.self = cycle;
    let deep = { leaf: 1 };
    for (let i = 0; i < 15; i++) deep = { d: deep };
    const doc = build({
      memory: {
        limits: { fn: () => 1, date: new Date(0), cycle, deep, long: 'x'.repeat(5000), nan: NaN }
      }
    });
    const k = doc.keys;
    assert.equal(k['limits.fn'].class, 'unsupported-type');
    assert.equal(k['limits.date'].class, 'unsupported-type');
    assert.equal(k['limits.cycle.self'].class, 'unsupported-type');
    assert.equal(k['limits.cycle.a'].value, 1);
    assert.equal(k['limits.long'].class, 'unsupported-type');
    assert.equal(k['limits.nan'].class, 'unsupported-type');
    assert.ok(Object.keys(k).some((p) => p.startsWith('limits.deep.') && k[p].class === 'unsupported-type'));
  });
});
