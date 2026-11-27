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

/**
 * [RCBC] bin/backup.js --restore --overwrite on a core serving the account:
 * the restore writes the storage from its own process, and tells the running
 * core's workers (here, the test process) to drop what they cache for the
 * account. The next read sees the restored stream tree and accesses at once,
 * not the cached pre-restore ones.
 */

/* global initTests, initCore, getNewFixture, coreRequest, assert, cuid */

const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const { spawn } = require('node:child_process');
const { childStorageEngineEnv } = require('test-helpers');

const CLI = path.resolve(__dirname, '../../../bin/backup.js');
const REPO_ROOT = path.resolve(__dirname, '../../../');

// Asynchronous on purpose: this process hosts the core and its pub/sub broker,
// which must keep answering while the restore runs.
function runCli (args) {
  const env = { ...process.env, ...childStorageEngineEnv() };
  delete env.PRYV_BACKUP_PASSPHRASE;
  return new Promise((resolve, reject) => {
    const child = spawn('node', [CLI, ...args], { cwd: REPO_ROOT, env });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', (d) => { stderr += d; });
    child.on('error', reject);
    child.on('close', (status) => resolve({ status, stdout, stderr }));
  });
}

function assertOk (res, what) {
  assert.strictEqual(res.status, 0, what + '\n' + res.stdout + res.stderr);
}

describe('[RCBC] restore into a running core invalidates its caches', function () {
  this.timeout(300000);

  let fixtures, tmpDir;

  before(async function () {
    await initTests();
    await initCore();
    fixtures = getNewFixture();
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'restore-cache-bust-cli-'));
  });

  after(async function () {
    if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
    await fixtures.clean();
  });

  it('[RCBC1] the restored stream name and the removal of an access created after the backup are seen by the next calls', async function () {
    const username = ('rcbc' + cuid().toLowerCase().replace(/[^a-z0-9]/g, '')).slice(0, 20);
    const user = await fixtures.user(username);
    const appToken = cuid();
    await user.access({ type: 'app', name: 'rcbc app', token: appToken, permissions: [{ streamId: '*', level: 'manage' }] });
    const personalToken = cuid();
    await user.access({ type: 'personal', token: personalToken });
    await user.session(personalToken);
    const streamId = 'rcbc-' + cuid().slice(-10);
    await user.stream({ id: streamId, name: 'before' });
    const api = (method, url, token = appToken) => coreRequest[method]('/' + username + url).set('Authorization', token);

    const dir = path.join(tmpDir, username);
    assertOk(await runCli(['--output', dir, '--user', username]), 'backup');

    // After the backup: the stream renamed and a new access, both cached here.
    let res = await api('put', '/streams/' + streamId).send({ name: 'after' });
    assert.strictEqual(res.status, 200, JSON.stringify(res.body));
    res = await api('post', '/accesses', personalToken).send({ type: 'app', name: 'rcbc later', permissions: [{ streamId, level: 'read' }] });
    assert.strictEqual(res.status, 201, JSON.stringify(res.body));
    const laterToken = res.body.access.token;
    res = await api('get', '/streams');
    assert.strictEqual(res.body.streams.find((s) => s.id === streamId)?.name, 'after');
    res = await api('get', '/events', laterToken);
    assert.strictEqual(res.status, 200, 'the later access works before the restore');

    const restore = await runCli(['--restore', dir, '--user', username, '--overwrite']);
    assertOk(restore, 'restore');
    assert.match(restore.stdout, /Restored: 1 users/);
    assert.match(restore.stdout, /Caches: the running core's workers were told to drop what they cache for the 1 account\(s\) written\./);

    res = await api('get', '/streams');
    assert.strictEqual(res.status, 200, JSON.stringify(res.body));
    assert.strictEqual(res.body.streams.find((s) => s.id === streamId)?.name, 'before', 'the restored stream tree, not the cached one');
    res = await api('get', '/events', laterToken);
    assert.ok(res.status === 401 || res.status === 403, 'the access the restore removed is refused at once, got ' + res.status);
  });
});
