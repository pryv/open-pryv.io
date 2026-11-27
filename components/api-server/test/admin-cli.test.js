/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */

import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';
const require = createRequire(import.meta.url);
const __dirname = dirname(fileURLToPath(import.meta.url));
/* global initTests, initCore, assert */

const path = require('path');
const { spawnSync } = require('child_process');
const { childStorageEngineEnv } = require('test-helpers');

const CLI = path.resolve(__dirname, '../../../bin/admin.js');
const CODE_RE = /[0-9A-Z]{5}-[0-9A-Z]{5}-[0-9A-Z]{5}-[0-9A-Z]{5}-[0-9A-Z]{6}/;

function runCli (args) {
  const res = spawnSync('node', [CLI, ...args], {
    cwd: path.resolve(__dirname, '../../../'),
    env: { ...process.env, ...childStorageEngineEnv() },
    encoding: 'utf8',
    timeout: 60000
  });
  return { status: res.status, stdout: res.stdout || '', stderr: res.stderr || '' };
}

/**
 * [ADMC] bin/admin.js: the setup code (state, replacement printed once, the
 * hash helper), claim codes, the role list and revocation (the last owner
 * kept unless --force), the revocation of an administrator's sessions; on the
 * platform store the core uses, with the API not involved.
 */
describe('[ADMC] bin/admin.js', function () {
  this.timeout(120000);
  let db, coreId;
  const setup = require('business/src/admin/setupState.ts');
  const roles = require('business/src/admin/roles.ts');
  const codes = require('business/src/admin/codes.ts');
  const { KEYS } = require('business/src/admin/store.ts');

  before(async function () {
    await initTests();
    await initCore();
    db = require('storages').platformDB;
    coreId = require('platform').platform.coreId;
    await reset();
  });

  async function reset () {
    await db.deletePlatformKv(KEYS.setupState);
    for (const { key } of await db.listPlatformKvEntries(KEYS.rolePrefix)) await db.deletePlatformKv(key);
  }

  afterEach(reset);

  it('[ADMC1] --help prints the usage; an unknown command exits 2', () => {
    const help = runCli(['--help']);
    assert.strictEqual(help.status, 0);
    assert.match(help.stdout, /setup-code --new/);
    assert.match(help.stdout, /claim-code/);
    assert.strictEqual(runCli(['nope']).status, 2);
  });

  it('[ADMC2] setup-code --hash: the SHA-256 of a chosen code (canonical form), or a new code with its hash', () => {
    const code = codes.generateCode();
    const hashed = runCli(['setup-code', '--hash', codes.formatCode(code).toLowerCase()]);
    assert.strictEqual(hashed.status, 0, hashed.stderr);
    assert.strictEqual(hashed.stdout.trim(), codes.hashCode(code));
    assert.strictEqual(runCli(['setup-code', '--hash', 'not-a-code']).status, 2);
    const fresh = runCli(['setup-code', '--hash']);
    assert.strictEqual(fresh.status, 0, fresh.stderr);
    const shown = CODE_RE.exec(fresh.stdout)[0];
    assert.match(fresh.stdout, new RegExp('hash\\s+' + codes.hashCode(codes.normalizeCode(shown))));
  });

  it('[ADMC3] setup-code: the state; --new replaces the pending code, printed once, the old one stops working', async () => {
    assert.strictEqual(runCli(['setup-code']).status, 1, 'no setup state yet');
    assert.strictEqual(await setup.claimFreshPending(db, { coreId, now: Date.now() }), true);
    const old = await setup.mintSetupCode(db, { coreId, ttlMs: 3600000, now: Date.now() });
    const status = runCli(['setup-code']);
    assert.strictEqual(status.status, 0, status.stderr);
    assert.match(status.stdout, /setup state\s+pending/);
    assert.match(status.stdout, /valid until/);
    assert.ok(!status.stdout.includes(old.display), 'a pending code is never shown again');
    const replaced = runCli(['setup-code', '--new']);
    assert.strictEqual(replaced.status, 0, replaced.stderr);
    assert.match(replaced.stdout, /PRYV SETUP CODE/);
    assert.match(replaced.stdout, /\/system\/setup\//);
    const shown = CODE_RE.exec(replaced.stdout)[0];
    assert.strictEqual(replaced.stdout.split(shown).length - 1, 1, 'printed once');
    assert.strictEqual(await setup.redeemSetupCode(db, old.code), null, 'the old code is refused');
    assert.notStrictEqual(await setup.redeemSetupCode(db, shown), null, 'the new code works');
    await setup.markReady(db, { by: 'admin-key', now: Date.now() });
    assert.strictEqual(runCli(['setup-code', '--new']).status, 1, 'nothing to replace once ready');
  });

  it('[ADMC6] setup finish: ready without a first administrator; a second run says so', async () => {
    assert.strictEqual(await setup.claimFreshPending(db, { coreId, now: Date.now() }), true);
    const pendingCode = await setup.mintSetupCode(db, { coreId, ttlMs: 3600000, now: Date.now() });
    const res = runCli(['setup', 'finish']);
    assert.strictEqual(res.status, 0, res.stderr);
    assert.match(res.stdout, /claim-code --role owner/);
    const state = await setup.readSetupState(db);
    assert.strictEqual(state.state, 'ready');
    assert.strictEqual(state.readyBy, 'cli');
    assert.strictEqual(await setup.redeemSetupCode(db, pendingCode.code), null, 'the code no longer works');
    const again = runCli(['setup', 'finish']);
    assert.strictEqual(again.status, 0);
    assert.match(again.stdout, /already ready/);
    assert.ok(!res.stdout.includes(pendingCode.display) && !res.stderr.includes(pendingCode.display));
  });

  it('[ADMC4] claim-code: a one-time code for the role, with its TTL; a bad role or TTL is refused', async () => {
    const res = runCli(['claim-code', '--role', 'owner', '--ttl', '10m']);
    assert.strictEqual(res.status, 0, res.stderr);
    const shown = CODE_RE.exec(res.stdout)[0];
    const row = await db.getAccessState(KEYS.claimCodePrefix + codes.hashCode(codes.normalizeCode(shown)));
    assert.ok(row != null);
    assert.strictEqual(row.value.mintedBy, 'cli');
    assert.ok(row.expiresAt <= Date.now() + 10 * 60000 + 1000);
    const claimed = await roles.claimRole(db, shown, { userId: 'adcl-claimer', now: Date.now() });
    assert.strictEqual(claimed.grant.role, 'owner');
    assert.strictEqual(runCli(['claim-code', '--role', 'god']).status, 1);
    assert.strictEqual(runCli(['claim-code', '--ttl', '25h']).status, 1);
  });

  it('[ADMC5] roles list and revoke: the last lasting owner is kept unless --force; sessions revoke', async () => {
    const now = Date.now();
    await roles.grantRole(db, 'adcl-owner-1', { role: 'owner', scope: 'platform', grantedBy: 'test', via: 'grant', now });
    const list = runCli(['roles', 'list']);
    assert.strictEqual(list.status, 0, list.stderr);
    assert.match(list.stdout, /adcl-owner-1/);
    assert.match(list.stdout, /owner @ platform\s+via grant/);
    const kept = runCli(['roles', 'revoke', 'adcl-owner-1']);
    assert.strictEqual(kept.status, 1);
    assert.match(kept.stderr, /last lasting owner/);
    assert.notStrictEqual(await roles.readRoleRow(db, 'adcl-owner-1'), null);
    const sessions = runCli(['sessions', 'revoke', 'adcl-owner-1']);
    assert.strictEqual(sessions.status, 0, sessions.stderr);
    assert.ok((await roles.readRoleRow(db, 'adcl-owner-1')).sessionsRevokedAt >= now);
    assert.strictEqual(runCli(['sessions', 'revoke', 'adcl-nobody']).status, 1);
    const forced = runCli(['roles', 'revoke', 'adcl-owner-1', '--force']);
    assert.strictEqual(forced.status, 0, forced.stderr);
    assert.strictEqual(await roles.readRoleRow(db, 'adcl-owner-1'), null);
    assert.strictEqual(runCli(['roles', 'revoke', 'adcl-owner-1']).status, 1, 'nothing left');
  });

  it('[ADMC7] roles grant: a role at a scope, with an expiry; bad role, scope or expiry refused; the last lasting owner kept unless --force; orphan scopes flagged', async () => {
    const now = Date.now();
    const ok = runCli(['roles', 'grant', 'adcl-support-1', '--role', 'support', '--scope', 'core:' + coreId, '--expires', '2d']);
    assert.strictEqual(ok.status, 0, ok.stderr);
    assert.match(ok.stdout, /Granted: support @ core:/);
    const row = await roles.readRoleRow(db, 'adcl-support-1');
    assert.deepStrictEqual(row.grants.map((g) => [g.role, g.scope, g.via, g.grantedBy]), [['support', 'core:' + coreId, 'grant', 'cli']]);
    assert.ok(row.grants[0].expiresAt > now + 47 * 3600000 && row.grants[0].expiresAt < now + 49 * 3600000, 'two days');
    const orphan = runCli(['roles', 'grant', 'adcl-support-1', '--role', 'viewer', '--scope', 'zone:nowhere']);
    assert.strictEqual(orphan.status, 0, orphan.stderr);
    assert.match(orphan.stdout, /names no region, zone, hosting or core/);
    const list = runCli(['roles', 'list']);
    assert.match(list.stdout, /viewer @ zone:nowhere .*\[orphan scope\]/);
    assert.doesNotMatch(list.stdout, /support @ core:\S+ .*\[orphan scope\]/);
    assert.strictEqual(runCli(['roles', 'grant', 'adcl-x', '--role', 'god', '--scope', 'platform']).status, 1, 'unknown role');
    const badScope = runCli(['roles', 'grant', 'adcl-x', '--role', 'viewer', '--scope', 'continent:eu']);
    assert.strictEqual(badScope.status, 1);
    assert.match(badScope.stderr, /region:<id>/);
    assert.strictEqual(runCli(['roles', 'grant', 'adcl-x', '--role', 'viewer', '--scope', 'platform', '--expires', '2000-01-01T00:00:00Z']).status, 1, 'past expiry');
    assert.strictEqual(runCli(['roles', 'grant', 'adcl-x', '--role', 'viewer', '--scope', 'platform', '--expires', 'soon']).status, 1, 'unreadable expiry');
    assert.strictEqual(runCli(['roles', 'grant', 'adcl-x', '--role', 'viewer']).status, 1, 'no scope');
    assert.strictEqual(await roles.readRoleRow(db, 'adcl-x'), null, 'nothing written on a refusal');
    // The last lasting owner: replacing its grant by an expiring one needs --force.
    await roles.grantRole(db, 'adcl-owner-2', { role: 'owner', scope: 'platform', grantedBy: 'test', via: 'grant', now });
    const kept = runCli(['roles', 'grant', 'adcl-owner-2', '--role', 'owner', '--scope', 'platform', '--expires', '1h']);
    assert.strictEqual(kept.status, 1);
    assert.match(kept.stderr, /last lasting owner/);
    assert.strictEqual((await roles.readRoleRow(db, 'adcl-owner-2')).grants[0].expiresAt, undefined, 'unchanged');
    const forced = runCli(['roles', 'grant', 'adcl-owner-2', '--role', 'owner', '--scope', 'platform', '--expires', '1h', '--force']);
    assert.strictEqual(forced.status, 0, forced.stderr);
    assert.ok((await roles.readRoleRow(db, 'adcl-owner-2')).grants[0].expiresAt > now);
  });
});
