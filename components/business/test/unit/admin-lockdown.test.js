/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */

/**
 * [ADLK] this core's lockdown (`admin.lockdown`): validation (through
 * `describeAdminConfig` too), the portal view, hidden capabilities, the
 * never-lockable capabilities, the cache, the boot step (digest, drift) and
 * the shipped profiles.
 */

import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import yaml from 'js-yaml';
import {
  describeLockdown, lockdownView, withoutHiddenCapabilities, parseLockdown, readLockdown,
  capabilityState, isPlatformConfigKeyReadonly, NEVER_LOCKED_CAPABILITIES, lockdownRefusal, lockdownKeyRefusal
} from '../../src/admin/lockdown.ts';
import { runLockdownBoot, LOCKDOWN_HASH_PREFIX } from '../../src/admin/lockdownBoot.ts';
import { describeAdminConfig } from '../../src/admin/config.ts';
import { CAPABILITY_NAMES } from '../../src/admin/capabilities.ts';

const require = createRequire(import.meta.url);
const here = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(here, '../../../..');
const DEFAULTS = yaml.load(fs.readFileSync(path.join(ROOT, 'config/default-config.yml'), 'utf8'));
const PROFILES_DIR = path.join(ROOT, 'config/lockdown-profiles');

/** A config reader over the shipped defaults with `admin:lockdown` set to `lockdown`. */
function config (lockdown) {
  return {
    get (key) {
      if (key === 'admin:lockdown') return lockdown;
      return key.split(':').reduce((o, k) => (o == null ? undefined : o[k]), DEFAULTS);
    }
  };
}

function messages (lockdown) {
  return describeLockdown(config(lockdown)).problems.map((p) => p.message);
}

/** The keys of the platform configuration module, or null when this build has none. */
function schemaKeys () {
  const file = path.join(ROOT, 'components/business/src/platformConfig/index.ts');
  if (!fs.existsSync(file)) return null;
  const schema = require(file).SCHEMA;
  return schema != null ? Object.keys(schema) : null;
}

function memoryStore (coreIds) {
  const kv = new Map();
  const store = {
    kv,
    async setPlatformKv (k, v) { kv.set(k, v); },
    async listPlatformKvEntries (prefix) { return [...kv].filter(([k]) => k.startsWith(prefix)).map(([key, value]) => ({ key, value })); }
  };
  if (coreIds != null) store.getAllCoreInfos = async () => coreIds.map((id) => ({ id }));
  return store;
}

function logger () {
  const out = { infos: [], warns: [] };
  out.info = (m) => out.infos.push(m);
  out.warn = (m) => out.warns.push(m);
  return out;
}

describe('[ADLK] admin lockdown', function () {
  describe('validation', function () {
    it('[LK01] no block, an empty block or all editable: no problem, nothing locked', function () {
      for (const l of [undefined, null, {}, { capabilities: {} }, { capabilities: { dns: 'editable' }, platformConfig: { readonly: [] } }]) {
        assert.deepEqual(messages(l), [], JSON.stringify(l));
        assert.equal(lockdownView(config(l)), null, JSON.stringify(l));
      }
    });

    it('[LK02] the shipped defaults validate', function () {
      const c = config(DEFAULTS.admin?.lockdown);
      assert.deepEqual(describeLockdown(c), { problems: [], warnings: [] });
    });

    it('[LK03] an unknown capability, a wrong state or an unknown setting is a problem naming its path', function () {
      const l = { capabilities: { dns: 'locked', nope: 'readonly' }, platformConfig: { readonly: 'service.name', other: [] }, extra: true };
      const report = describeLockdown(config(l));
      const paths = report.problems.map((p) => p.path.join('.')).sort();
      assert.deepEqual(paths, [
        'admin.lockdown.capabilities.dns',
        'admin.lockdown.capabilities.nope',
        'admin.lockdown.extra',
        'admin.lockdown.platformConfig.other',
        'admin.lockdown.platformConfig.readonly'
      ]);
      for (const p of report.problems) assert.ok(p.message.startsWith(p.path.join('.') + ' '), p.message);
      assert.deepEqual(messages('readonly').length, 1);
      assert.deepEqual(messages({ capabilities: ['dns'] }).length, 1);
      assert.deepEqual(messages({ platformConfig: ['service.name'] }).length, 1);
    });

    it('[LK04] setup, roles and claim codes cannot be locked: a problem, and never locked when read', function () {
      assert.deepEqual([...NEVER_LOCKED_CAPABILITIES].sort(), ['claimCodes', 'roles', 'setup']);
      for (const name of NEVER_LOCKED_CAPABILITIES) {
        for (const state of ['readonly', 'hidden']) {
          const l = { capabilities: { [name]: state } };
          const m = messages(l);
          assert.equal(m.length, 1, name + ' ' + state);
          assert.match(m[0], /cannot be locked/);
          assert.equal(capabilityState(config(l), name), 'editable');
          assert.equal(lockdownView(config(l)), null);
          assert.deepEqual(withoutHiddenCapabilities(config(l), [name]), [name]);
        }
        assert.deepEqual(messages({ capabilities: { [name]: 'editable' } }), []);
      }
    });

    it('[LK05] a malformed platform configuration key is a problem', function () {
      for (const bad of ['', 'a..b', '.a', 'a.', 'a b', 'a%', 'a/b', 42, null]) {
        assert.equal(messages({ platformConfig: { readonly: [bad] } }).length, 1, JSON.stringify(bad));
      }
    });

    it('[LK06] an unknown platform configuration key is a problem when the keys are known', function () {
      const known = new Set(['service.name', 'service.home']);
      const ok = parseLockdown({ platformConfig: { readonly: ['service.name'] } }, known);
      assert.deepEqual(ok.report.problems, []);
      const bad = parseLockdown({ platformConfig: { readonly: ['service.name', 'dns.domain'] } }, known);
      assert.equal(bad.report.problems.length, 1);
      assert.match(bad.report.problems[0].message, /'dns\.domain'/);
      assert.deepEqual([...bad.readonlyKeys], ['service.name']);
      // Not known here: the form only.
      assert.deepEqual(parseLockdown({ platformConfig: { readonly: ['dns.domain'] } }, null).report.problems, []);
    });

    it('[LK20] once the build has a platform configuration schema, the configuration is checked against it', function () {
      if (schemaKeys() == null) return this.skip(); // no platform configuration module in this build
      assert.equal(messages({ platformConfig: { readonly: ['no.such.key'] } }).length, 1,
        'lockdown.ts must check platformConfig.readonly against the schema keys (PLATFORM_CONFIG_KEYS)');
    });

    it('[LK07] describeAdminConfig carries the lockdown problems (boot validation, bin/check-config.js)', function () {
      const report = describeAdminConfig(config({ capabilities: { nope: 'hidden' } }));
      assert.equal(report.problems.filter((p) => p.path.join('.') === 'admin.lockdown.capabilities.nope').length, 1);
      assert.deepEqual(describeAdminConfig(config({ capabilities: { dns: 'readonly' } })).problems, []);
    });
  });

  describe('view and state', function () {
    it('[LK08] the view lists the locked capabilities and the read-only keys (sorted, distinct)', function () {
      const l = { capabilities: { mail: 'readonly', dns: 'hidden', users: 'editable' }, platformConfig: { readonly: ['b.key', 'a.key', 'a.key'] } };
      const parsed = parseLockdown(l, new Set(['a.key', 'b.key']));
      assert.deepEqual(parsed.view, { capabilities: { dns: 'hidden', mail: 'readonly' }, platformConfig: { readonly: ['a.key', 'b.key'] } });
      assert.equal(parsed.readonlyKeys.has('a.key'), true);
      assert.equal(parsed.readonlyKeys.has('c.key'), false);
    });

    it('[LK09] hidden capabilities are left out, readonly ones kept', function () {
      const c = config({ capabilities: { mail: 'readonly', dns: 'hidden' } });
      assert.deepEqual(withoutHiddenCapabilities(c, ['users', 'dns', 'mail']), ['users', 'mail']);
      assert.equal(capabilityState(c, 'dns'), 'hidden');
      assert.equal(capabilityState(c, 'mail'), 'readonly');
      assert.equal(capabilityState(c, 'users'), 'editable');
      assert.deepEqual(lockdownView(c), { capabilities: { dns: 'hidden', mail: 'readonly' }, platformConfig: { readonly: [] } });
    });

    it('[LK10] the view is a copy: changing it changes nothing', function () {
      const c = config({ capabilities: { mail: 'readonly' } });
      const v = lockdownView(c);
      v.capabilities.users = 'hidden';
      assert.equal(capabilityState(c, 'users'), 'editable');
      assert.deepEqual(lockdownView(c).capabilities, { mail: 'readonly' });
    });

    it('[LK11] cached per configuration object, and read again when the value changes', function () {
      let value = { capabilities: { mail: 'readonly' } };
      let reads = 0;
      const c = { get (k) { if (k === 'admin:lockdown') { reads++; return value; } return undefined; } };
      const first = readLockdown(c);
      assert.equal(readLockdown(c), first, 'same object while the value reads the same');
      assert.equal(readLockdown(c), first);
      assert.equal(reads, 3);
      value = { capabilities: { mail: 'hidden' } };
      assert.notEqual(readLockdown(c), first);
      assert.equal(capabilityState(c, 'mail'), 'hidden');
      value = undefined;
      assert.equal(capabilityState(c, 'mail'), 'editable');
    });

    it('[LK12] the digest depends on what is locked only (order, editable entries, duplicates do not count)', function () {
      const a = parseLockdown({ capabilities: { mail: 'readonly', dns: 'hidden' }, platformConfig: { readonly: ['x.y', 'a.b'] } }, null);
      const b = parseLockdown({ capabilities: { dns: 'hidden', users: 'editable', mail: 'readonly' }, platformConfig: { readonly: ['a.b', 'x.y', 'a.b'] } }, null);
      assert.equal(a.digest, b.digest);
      assert.match(a.digest, /^[0-9a-f]{64}$/);
      assert.equal(parseLockdown(undefined, null).digest, parseLockdown({ capabilities: { dns: 'editable' } }, null).digest);
      assert.notEqual(a.digest, parseLockdown({ capabilities: { mail: 'hidden', dns: 'hidden' }, platformConfig: { readonly: ['x.y', 'a.b'] } }, null).digest);
    });

    it('[LK19] a read-only key reads as such from the configuration', function () {
      const keys = schemaKeys();
      const key = keys != null && keys.length > 0 ? keys[0] : 'service.name';
      if (keys != null && keys.length === 0) return this.skip(); // the schema holds no key yet
      const c = config({ platformConfig: { readonly: [key] } });
      assert.equal(isPlatformConfigKeyReadonly(c, key), true);
      assert.equal(isPlatformConfigKeyReadonly(c, key + 'x'), false);
      assert.equal(isPlatformConfigKeyReadonly(config(undefined), key), false);
    });
  });

  describe('refusals', function () {
    it('[LK21] lockdownRefusal: null when editable or never locked, 403 when locked, 500 when the configuration is invalid', function () {
      const c = config({ capabilities: { dns: 'readonly', mail: 'hidden' } });
      assert.equal(lockdownRefusal(c, 'users'), null);
      for (const cap of ['dns', 'mail']) {
        const err = lockdownRefusal(c, cap);
        assert.equal(err.httpStatus, 403);
        assert.equal(err.id, 'admin-lockdown-capability');
        assert.deepEqual(err.data, { capability: cap });
      }
      const invalid = config({ capabilities: { dns: 'readonyl', mail: 'readonly' } });
      for (const cap of ['dns', 'mail', 'users']) {
        const err = lockdownRefusal(invalid, cap);
        assert.equal(err.httpStatus, 500, cap);
        assert.equal(err.id, 'admin-lockdown-invalid', cap);
      }
      for (const cap of NEVER_LOCKED_CAPABILITIES) assert.equal(lockdownRefusal(invalid, cap), null, cap);
      assert.equal(lockdownRefusal(config(undefined), 'dns'), null);
    });

    it('[LK22] lockdownKeyRefusal: 403 admin-lockdown-key for a read-only key only', function () {
      const keys = schemaKeys();
      if (keys != null && keys.length === 0) return this.skip(); // the schema holds no key yet
      const key = keys != null ? keys[0] : 'service.name';
      const c = config({ platformConfig: { readonly: [key] } });
      const err = lockdownKeyRefusal(c, key);
      assert.equal(err.httpStatus, 403);
      assert.equal(err.id, 'admin-lockdown-key');
      assert.deepEqual(err.data, { key });
      assert.equal(lockdownKeyRefusal(c, key + 'x'), null);
    });
  });

  describe('boot', function () {
    it('[LK13] writes this core\'s digest and warns when a registered core differs', async function () {
      const db = memoryStore(['core-a', 'core-b', 'core-c']);
      const same = parseLockdown({ capabilities: { mail: 'readonly' } }, null).digest;
      db.kv.set(LOCKDOWN_HASH_PREFIX + 'core-b', JSON.stringify({ digest: same, at: 1 }));
      db.kv.set(LOCKDOWN_HASH_PREFIX + 'core-c', JSON.stringify({ digest: 'other', at: 1 }));
      db.kv.set(LOCKDOWN_HASH_PREFIX + 'core-gone', JSON.stringify({ digest: 'other', at: 1 }));
      const log = logger();
      const result = await runLockdownBoot({ config: config({ capabilities: { mail: 'readonly' } }), logger: log, db, coreId: 'core-a', now: () => 42 });
      assert.deepEqual(JSON.parse(db.kv.get(LOCKDOWN_HASH_PREFIX + 'core-a')), { digest: same, at: 42 });
      assert.deepEqual(result, { digest: same, drift: ['core-c'] });
      assert.equal(log.warns.length, 1);
      assert.match(log.warns[0], /^\[admin-lockdown-drift\] .*core-c/);
      assert.ok(!log.warns[0].includes('core-gone'), 'a core no longer registered is not compared');
      assert.equal(log.infos.length, 1);
      assert.match(log.infos[0], /^\[admin-lockdown\] .*mail \(readonly\)/);
    });

    it('[LK14] no lock, every core alike: no warning, no info line', async function () {
      const db = memoryStore(null);
      const none = parseLockdown(undefined, null).digest;
      db.kv.set(LOCKDOWN_HASH_PREFIX + 'core-b', JSON.stringify({ digest: none, at: 1 }));
      db.kv.set(LOCKDOWN_HASH_PREFIX + 'core-c', 'not json');
      const log = logger();
      const result = await runLockdownBoot({ config: config(undefined), logger: log, db, coreId: 'core-a' });
      assert.deepEqual(result.drift, []);
      assert.deepEqual(log.warns, []);
      assert.deepEqual(log.infos, []);
    });

    it('[LK15] a store failure never stops the boot', async function () {
      const db = { async setPlatformKv () { throw new Error('store down'); }, async listPlatformKvEntries () { return []; } };
      const log = logger();
      assert.equal(await runLockdownBoot({ config: config(undefined), logger: log, db, coreId: 'core-a' }), null);
      assert.equal(log.warns.length, 1);
      assert.match(log.warns[0], /store down/);
    });
  });

  describe('profiles', function () {
    const files = fs.readdirSync(PROFILES_DIR).filter((f) => f.endsWith('.yml')).sort();

    function profile (name) {
      return yaml.load(fs.readFileSync(path.join(PROFILES_DIR, name + '.yml'), 'utf8'));
    }

    it('[LK16] the four profiles ship, each a ready admin.lockdown block with a header comment', function () {
      assert.deepEqual(files, ['air-gap.yml', 'behind-cloudflare.yml', 'dokku.yml', 'gitops.yml']);
      for (const f of files) {
        const text = fs.readFileSync(path.join(PROFILES_DIR, f), 'utf8');
        assert.match(text, /^# Lockdown profile: /, f);
        assert.match(text, /# Assumes: /, f);
        const doc = yaml.load(text);
        assert.deepEqual(Object.keys(doc), ['admin'], f);
        assert.deepEqual(Object.keys(doc.admin), ['lockdown'], f);
      }
    });

    it('[LK17] every profile validates and locks only lockable capabilities of this release', function () {
      for (const f of files) {
        const l = profile(f.replace(/\.yml$/, '')).admin.lockdown;
        const keys = schemaKeys();
        assert.deepEqual(parseLockdown(l, keys != null ? new Set(keys) : null).report.problems, [], f);
        for (const name of Object.keys(l.capabilities ?? {})) {
          assert.ok(CAPABILITY_NAMES.includes(name), f + ' ' + name);
          assert.ok(!NEVER_LOCKED_CAPABILITIES.has(name), f + ' ' + name);
        }
      }
    });

    it('[LK18] gitops lists every key of the platform configuration schema read-only', function () {
      const keys = schemaKeys();
      if (keys == null) return this.skip(); // no platform configuration module in this build
      assert.deepEqual([...profile('gitops').admin.lockdown.platformConfig.readonly].sort(), [...keys].sort());
    });
  });
});
