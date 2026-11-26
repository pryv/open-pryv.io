/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */

/**
 * [ADSB] the setup step of the master boot: fresh vs legacy, one setup block,
 * the code file (0600), an operator-supplied hash, restarts, a joining core,
 * and the second-factor stamp of a sign-in. Over an in-memory store with the
 * platform store's semantics (the engines are covered by [ADKC]).
 */

import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { createHash } from 'node:crypto';
import { runSetupBoot, SETUP_CODE_FILE } from '../../src/admin/setupBoot.ts';
import { readSetupState, redeemSetupCode, markReady } from '../../src/admin/setupState.ts';
import { normalizeCode, generateCode } from '../../src/admin/codes.ts';
import { recordMfaSignIn, mfaSignInAt } from '../../src/admin/sessions.ts';

/** The subset of PlatformDB the administration module uses, in memory. */
function memoryStore () {
  const kv = new Map();
  const states = new Map();
  const counters = new Map();
  const live = (key) => {
    const e = states.get(key);
    if (e == null) return null;
    if (Date.now() > e.expiresAt) { states.delete(key); return null; }
    return e;
  };
  return {
    kv,
    states,
    async getPlatformKv (k) { return kv.has(k) ? kv.get(k) : null; },
    async setPlatformKv (k, v) { kv.set(k, v); },
    async setPlatformKvIfAbsent (k, v) { if (kv.has(k)) return false; kv.set(k, v); return true; },
    async deletePlatformKv (k) { kv.delete(k); },
    async listPlatformKvEntries (prefix) { return [...kv].filter(([k]) => k.startsWith(prefix)).map(([key, value]) => ({ key, value })); },
    async setAccessState (k, value, expiresAt) { states.set(k, JSON.parse(JSON.stringify({ value, expiresAt }))); },
    async getAccessState (k) { return live(k); },
    async deleteAccessState (k) { states.delete(k); },
    async consumeAccessState (k) { const e = live(k); states.delete(k); return e; },
    async bumpWindowedCounter (k, max, windowMs, now) {
      const c = counters.get(k);
      if (c == null || c.endsAt <= now) { counters.set(k, { count: 1, endsAt: now + windowMs }); return null; }
      if (c.count < max) { c.count++; return null; }
      return c.endsAt;
    },
    dump () { return JSON.stringify([...kv, ...states]); }
  };
}

function config (overrides = {}) {
  const base = {
    'http:ip': '127.0.0.1',
    'http:port': 3000,
    'dnsLess:isActive': true,
    'dnsLess:publicUrl': 'https://pryv.example.com/'
  };
  const values = { ...base, ...overrides };
  return { get: (k) => values[k] };
}

describe('[ADSB] setup step of the master boot', function () {
  let dir;
  beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'adsb-')); });
  afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

  function boot (db, opts = {}) {
    const out = { printed: [], logs: [], warns: [] };
    const deps = {
      db,
      config: opts.config ?? config(),
      coreId: opts.coreId ?? 'core-a',
      joining: opts.joining ?? false,
      platformInUse: async () => opts.inUse ?? false,
      configDir: opts.configDir === undefined ? dir : opts.configDir,
      log: (m) => out.logs.push(m),
      warn: (m) => out.warns.push(m),
      print: (t) => out.printed.push(t)
    };
    return runSetupBoot(deps).then((result) => ({ result, out }));
  }

  function codeIn (text) {
    const m = text.match(/\b([0-9A-Z]{5}-[0-9A-Z]{5}-[0-9A-Z]{5}-[0-9A-Z]{5}-[0-9A-Z]{6})\b/);
    return m ? m[1] : null;
  }

  it('[ADSB1] a fresh platform: one block with the code and the setup page; the file is 0600; only the hash is stored', async () => {
    const db = memoryStore();
    const { result, out } = await boot(db);
    assert.equal(result.action, 'minted');
    assert.equal(out.printed.length, 1);
    const block = out.printed[0];
    const display = codeIn(block);
    assert.ok(display != null, 'the block shows the code');
    assert.ok(block.includes('https://pryv.example.com/system/setup/') && block.includes('http://127.0.0.1:3000/system/setup/'));
    assert.ok(!out.logs.join('\n').includes(display) && !out.warns.join('\n').includes(display), 'the code is in no log line');
    const file = path.join(dir, SETUP_CODE_FILE);
    assert.equal(result.codeFile, file);
    assert.equal(fs.statSync(file).mode & 0o777, 0o600);
    assert.ok(fs.readFileSync(file, 'utf8').includes(display));
    const canonical = normalizeCode(display);
    assert.ok(!db.dump().includes(canonical) && !db.dump().includes(display), 'no plain code in the store');
    assert.ok(db.dump().includes(createHash('sha256').update(canonical).digest('hex')));
    assert.notEqual(await redeemSetupCode(db, display), null, 'the printed code works');
  });

  it('[ADSB2] a restart neither mints nor prints; it says a code is pending; after ready the file is removed', async () => {
    const db = memoryStore();
    await boot(db);
    const { result, out } = await boot(db);
    assert.equal(result.action, 'pending');
    assert.equal(out.printed.length, 0);
    assert.match(out.logs.join('\n'), /a setup code issued at .* is valid until/);
    assert.ok(fs.existsSync(path.join(dir, SETUP_CODE_FILE)));
    await markReady(db, { by: 'user-1', now: Date.now() });
    const after = await boot(db);
    assert.equal(after.result.action, 'ready');
    assert.equal(fs.existsSync(path.join(dir, SETUP_CODE_FILE)), false, 'stale code file deleted');
  });

  it('[ADSB3] an existing platform (or a joining core) is recorded ready, without a code', async () => {
    for (const opts of [{ inUse: true }, { joining: true }]) {
      const db = memoryStore();
      const { result, out } = await boot(db, opts);
      assert.equal(result.action, 'legacy', JSON.stringify(opts));
      assert.equal(out.printed.length, 0);
      assert.equal((await readSetupState(db)).state, 'ready');
      assert.equal(db.states.size, 0, 'no code row');
    }
  });

  it('[ADSB4] two cores booting at once on a fresh platform: exactly one mints', async () => {
    const db = memoryStore();
    const [a, b] = await Promise.all([boot(db, { coreId: 'core-a' }), boot(db, { coreId: 'core-b', configDir: null })]);
    const minted = [a, b].filter((r) => r.result.action === 'minted');
    assert.equal(minted.length, 1);
    assert.equal(a.out.printed.length + b.out.printed.length, 1);
    const later = await boot(db, { coreId: 'core-c', joining: true, configDir: null });
    assert.equal(later.result.action, 'pending', 'a joining core reads pending and mints nothing');
    assert.equal(later.out.printed.length, 0);
  });

  it('[ADSB5] setup.printCode false: no block, the code is in the file only', async () => {
    const db = memoryStore();
    const { result, out } = await boot(db, { config: config({ 'setup:printCode': false }) });
    assert.equal(result.action, 'minted');
    assert.equal(out.printed.length, 0);
    assert.match(out.logs.join('\n'), /not printed/);
    assert.ok(codeIn(fs.readFileSync(path.join(dir, SETUP_CODE_FILE), 'utf8')) != null);
    const noFile = await boot(memoryStore(), { config: config({ 'setup:printCode': false }), configDir: path.join(dir, 'missing', 'dir') });
    assert.match(noFile.out.warns.join('\n'), /could not be saved and is not printed/);
  });

  it('[ADSB6] an operator-supplied hash: nothing secret printed; installed once, never re-armed after use; a new hash replaces it', async () => {
    const db = memoryStore();
    const code = generateCode();
    const hash = createHash('sha256').update(code).digest('hex');
    const cfg = config({ 'setup:codeHash': hash });
    const first = await boot(db, { config: cfg });
    assert.equal(first.result.action, 'supplied');
    assert.equal(first.out.printed.length, 0);
    assert.equal(fs.existsSync(path.join(dir, SETUP_CODE_FILE)), false);
    assert.notEqual(await redeemSetupCode(db, code), null);
    const restart = await boot(db, { config: cfg });
    assert.equal(restart.result.action, 'pending', 'the consumed hash is not installed again');
    assert.equal(await redeemSetupCode(db, code), null);
    const other = generateCode();
    const replaced = await boot(db, { config: config({ 'setup:codeHash': createHash('sha256').update(other).digest('hex') }) });
    assert.equal(replaced.result.action, 'supplied');
    assert.notEqual(await redeemSetupCode(db, other), null);
  });

  it('[ADSB7] the second factor of a sign-in is stamped for its token and account only', async () => {
    const values = new Map();
    const kv = {
      async get (k) { return values.has(k) ? values.get(k) : null; },
      async set (k, v) { values.set(k, v); return true; }
    };
    const now = Date.now();
    assert.equal(await recordMfaSignIn(kv, { token: 'personal-token-1', userId: 'u1', now, ttlMs: 60000 }), true);
    assert.equal(await mfaSignInAt(kv, { token: 'personal-token-1', userId: 'u1' }), now);
    assert.equal(await mfaSignInAt(kv, { token: 'personal-token-1', userId: 'u2' }), null, 'another account');
    assert.equal(await mfaSignInAt(kv, { token: 'personal-token-2', userId: 'u1' }), null, 'another token');
    assert.ok(![...values.keys()].some((k) => k.includes('personal-token-1')), 'the token is not a key');
  });
});
