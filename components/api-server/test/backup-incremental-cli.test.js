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
/* global initTests, initCore, getNewFixture, coreRequest, assert */

const path = require('path');
const fs = require('node:fs');
const os = require('node:os');
const crypto = require('node:crypto');
const { spawnSync } = require('child_process');
const cuid = require('cuid');
const { childStorageEngineEnv } = require('test-helpers');
const { fromCallback } = require('utils');

const CLI = path.resolve(__dirname, '../../../bin/backup.js');
const REPO_ROOT = path.resolve(__dirname, '../../../');

function runCli (args) {
  const env = { ...process.env, ...childStorageEngineEnv() };
  // Each case states its own secrets; an ambient one must not leak in.
  delete env.PRYV_BACKUP_PASSPHRASE;
  const res = spawnSync('node', [CLI, ...args], { cwd: REPO_ROOT, encoding: 'utf8', env, timeout: 90000 });
  return { status: res.status, stdout: res.stdout || '', stderr: res.stderr || '' };
}

function assertOk (res, what) {
  assert.strictEqual(res.status, 0, what + '\n' + res.stdout + res.stderr);
}

/**
 * [BKIC] bin/backup.js: a full backup, then an incremental run into the same
 * directory, then a restore, gives back the account as it was at the
 * incremental run (the full run's data included).
 */
describe('[BKIC] bin/backup.js incremental chain, end to end', function () {
  this.timeout(300000);

  let fixtures, username, token, tmpDir, storageLayer, eventFiles;
  const ids = { s1: 'bkic-s1-' + cuid.slug(), s2: 'bkic-s2-' + cuid.slug(), e0: cuid(), e1: cuid(), e2: null, e3: null, access: null, fileId: null };
  const attachmentBytes = Buffer.from('BKIC attachment of e2 ' + cuid());

  async function exportAll (collection) {
    return await fromCallback((cb) => storageLayer[collection].exportAll({ id: username }, cb));
  }

  async function attachmentOf (eventId, fileId) {
    const stream = await eventFiles.getAttachmentStream(username, eventId, fileId);
    const chunks = [];
    for await (const c of stream) chunks.push(Buffer.from(c));
    return Buffer.concat(chunks);
  }

  function api (method, url) {
    return coreRequest[method]('/' + username + url).set('Authorization', token);
  }

  before(async function () {
    await initTests();
    await initCore();
    fixtures = getNewFixture();
    username = 'bkic' + cuid.slug().toLowerCase();
    token = cuid();
    const user = await fixtures.user(username);
    await user.access({ token, type: 'personal' });
    await user.session(token);
    storageLayer = await require('storage').getStorageLayer();
    eventFiles = await require('storage/src/eventFiles/getEventFiles.ts').getEventFiles();
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'backup-incremental-cli-'));

    let res = await api('post', '/streams').send({ id: ids.s1, name: 'BKIC S1' });
    assert.strictEqual(res.status, 201, JSON.stringify(res.body));
    res = await api('post', '/events').send({ id: ids.e1, streamIds: [ids.s1], type: 'note/txt', content: 'e1' });
    assert.strictEqual(res.status, 201, JSON.stringify(res.body));
    res = await api('post', '/events')
      .field('event', JSON.stringify({ streamIds: [ids.s1], type: 'note/txt', content: 'e2 old' }))
      .attach('file', attachmentBytes, 'e2.txt');
    assert.strictEqual(res.status, 201, JSON.stringify(res.body));
    ids.e2 = res.body.event.id;
    ids.fileId = res.body.event.attachments[0].id;
    res = await api('post', '/accesses').send({ type: 'app', name: 'bkic-app', permissions: [{ streamId: ids.s1, level: 'read' }] });
    assert.strictEqual(res.status, 201, JSON.stringify(res.body));
    ids.access = res.body.access.id;
    // An event last changed an hour before the full run: only the full run holds it.
    const { getMall } = require('mall');
    const mall = await getMall();
    const anHourAgo = Date.now() / 1000 - 3600;
    await mall.events.create(username, { id: ids.e0, streamIds: [ids.s1], type: 'note/txt', content: 'e0 old', time: anHourAgo, created: anHourAgo, createdBy: 'test', modified: anHourAgo, modifiedBy: 'test' }, null, true);
  });

  after(async function () {
    if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
    await fixtures.clean();
  });

  it('[BKIC1] full encrypted backup, changes, incremental run, restore: the account comes back whole, changes and deletions included', async function () {
    const dir = path.join(tmpDir, 'chain');
    const passphraseFile = path.join(tmpDir, 'passphrase');
    fs.writeFileSync(passphraseFile, 'bkic-passphrase\n', { mode: 0o600 });

    assertOk(runCli(['--output', dir, '--user', username, '--passphrase-file', passphraseFile]), 'full backup');

    let res = await api('post', '/streams').send({ id: ids.s2, name: 'BKIC S2' });
    assert.strictEqual(res.status, 201, JSON.stringify(res.body));
    res = await api('post', '/events').send({ streamIds: [ids.s2], type: 'note/txt', content: 'e3' });
    assert.strictEqual(res.status, 201, JSON.stringify(res.body));
    ids.e3 = res.body.event.id;
    res = await api('put', '/events/' + ids.e2).send({ content: 'e2 new' });
    assert.strictEqual(res.status, 200, JSON.stringify(res.body));
    for (let i = 0; i < 2; i++) { // trash, then delete
      res = await api('delete', '/events/' + ids.e1);
      assert.strictEqual(res.status, 200, JSON.stringify(res.body));
    }
    res = await api('put', '/accesses/' + ids.access).send({ clientData: { bkic: 'changed' } });
    assert.strictEqual(res.status, 200, JSON.stringify(res.body));

    const inc = runCli(['--output', dir, '--user', username, '--incremental', '--passphrase-file', passphraseFile]);
    assertOk(inc, 'incremental backup');

    const restore = runCli(['--restore', dir, '--user', username, '--passphrase-file', passphraseFile, '--overwrite']);
    assertOk(restore, 'restore');
    assert.match(restore.stdout, /Restored: 1 users/);

    const streams = Object.fromEntries((await exportAll('streams')).map((s) => [s.id, s]));
    assert.ok(streams[ids.s1], 'S1 (full run) restored');
    assert.ok(streams[ids.s2], 'S2 (incremental run) restored');
    const events = Object.fromEntries((await exportAll('events')).map((e) => [e.id, e]));
    assert.strictEqual(events[ids.e0]?.content, 'e0 old', 'e0, in the full run only, restored');
    assert.strictEqual(events[ids.e2]?.content, 'e2 new', 'e2 in its newer version');
    assert.deepStrictEqual(events[ids.e2].attachments.map((a) => a.id), [ids.fileId]);
    assert.strictEqual(events[ids.e3]?.content, 'e3');
    assert.ok(events[ids.e1] != null && typeof events[ids.e1].deleted === 'number', 'e1 restored as a deletion');
    assert.deepStrictEqual(await attachmentOf(ids.e2, ids.fileId), attachmentBytes, 'the attachment of e2');
    const accesses = Object.fromEntries((await exportAll('accesses')).map((a) => [a.id, a]));
    assert.deepStrictEqual(accesses[ids.access]?.clientData, { bkic: 'changed' }, 'the access in its newer version');
    assert.ok(Object.values(accesses).some((a) => a.token === token), 'the personal access restored');
    assert.match(inc.stdout, /Incremental backup: run \S+ of the chain/);
  });

  it('[BKIC2] --inspect lists the chain; a directory the old in-place incremental run left is reported DAMAGED and its restore is refused', function () {
    const dir = path.join(tmpDir, 'chain');
    const passphraseFile = path.join(tmpDir, 'passphrase');
    const ok = runCli(['--inspect', dir]);
    assertOk(ok, 'inspect');
    assert.match(ok.stdout, /Runs: 2/);
    assert.match(ok.stdout, /OK \(2 runs\)/);
    assert.doesNotMatch(ok.stdout, /Storage initialized/);

    // The old layout: no chain.json, the delta's manifest and envelope at the root.
    const damaged = path.join(tmpDir, 'damaged');
    fs.cpSync(dir, damaged, { recursive: true });
    const runId = fs.readdirSync(path.join(damaged, 'incrementals'))[0];
    for (const name of ['manifest.json', 'encryption.json']) {
      fs.copyFileSync(path.join(damaged, 'incrementals', runId, name), path.join(damaged, name));
    }
    fs.rmSync(path.join(damaged, 'chain.json'));
    fs.rmSync(path.join(damaged, 'incrementals'), { recursive: true });

    const unknown = runCli(['--inspect', damaged]);
    assert.strictEqual(unknown.status, 2, unknown.stdout + unknown.stderr);
    assert.match(unknown.stdout, /UNKNOWN: pass --passphrase-file \/ --private-key/);
    const report = runCli(['--inspect', damaged, '--passphrase-file', passphraseFile]);
    assert.strictEqual(report.status, 1, report.stdout + report.stderr);
    assert.match(report.stdout, /DAMAGED: the root manifest says "incremental" and there is no chain.json/);

    const restore = runCli(['--restore', damaged, '--user', username, '--passphrase-file', passphraseFile, '--overwrite']);
    assert.strictEqual(restore.status, 1, restore.stdout + restore.stderr);
    assert.match(restore.stderr, /holds only the delta of an incremental run that overwrote its full backup/);
    assert.doesNotMatch(restore.stdout, /Restored:/);
  });

  it('[BKIC3] a hybrid chain continues with the recipient public key only; restore with the private key gives the merged account', async function () {
    const { publicKey, privateKey } = crypto.generateKeyPairSync('rsa', {
      modulusLength: 2048,
      publicKeyEncoding: { type: 'spki', format: 'pem' },
      privateKeyEncoding: { type: 'pkcs8', format: 'pem' }
    });
    const pubFile = path.join(tmpDir, 'recipient.pub.pem');
    const keyFile = path.join(tmpDir, 'recipient.key.pem');
    fs.writeFileSync(pubFile, publicKey);
    fs.writeFileSync(keyFile, privateKey, { mode: 0o600 });
    const dir = path.join(tmpDir, 'hybrid');

    assertOk(runCli(['--output', dir, '--user', username, '--recipient-pubkey', pubFile]), 'full backup');
    const res = await api('post', '/events').send({ streamIds: [ids.s2], type: 'note/txt', content: 'e4 after the hybrid full run' });
    assert.strictEqual(res.status, 201, JSON.stringify(res.body));
    const e4 = res.body.event.id;

    assertOk(runCli(['--output', dir, '--user', username, '--incremental', '--recipient-pubkey', pubFile]), 'incremental backup with the public key only');
    assertOk(runCli(['--restore', dir, '--user', username, '--private-key', keyFile, '--overwrite']), 'restore');

    const events = Object.fromEntries((await exportAll('events')).map((e) => [e.id, e]));
    assert.strictEqual(events[e4]?.content, 'e4 after the hybrid full run', 'the incremental run');
    assert.strictEqual(events[ids.e0]?.content, 'e0 old', 'the full run');
    assert.strictEqual(events[ids.e2]?.content, 'e2 new');
    assert.deepStrictEqual(await attachmentOf(ids.e2, ids.fileId), attachmentBytes);
  });

  it('[BKIC4] an account deleted between two whole-core runs is not re-created by the restore; --through-run restores it as of the run that held it', async function () {
    // Whole-core runs: every account of the test core, plaintext, in a directory removed in `after`.
    const dir = path.join(tmpDir, 'whole-core');
    const userB = 'bkicb' + cuid.slug().toLowerCase();
    const streamB = 'bkic-b-' + cuid.slug();
    const b = await fixtures.user(userB);
    await b.stream({ id: streamB, name: 'BKIC B stream' });
    const streamsOfB = async () => (await fromCallback((cb) => storageLayer.streams.exportAll({ id: userB }, cb))).map((s) => s.id);
    assert.ok((await streamsOfB()).includes(streamB), 'control: B has its stream');

    assertOk(runCli(['--output', dir]), 'whole-core full backup');
    await require('api-server/src/methods/auth/delete.ts').default(global.app.api);
    const adminKey = (await require('@pryv/boiler').getConfig()).get('auth:adminAccessKey');
    const del = await coreRequest.delete('/users/' + userB).set('Authorization', adminKey);
    assert.strictEqual(del.status, 200, JSON.stringify(del.body));
    assertOk(runCli(['--output', dir, '--incremental']), 'whole-core incremental run');

    const inspect = runCli(['--inspect', dir]);
    assertOk(inspect, 'inspect');
    assert.match(inspect.stdout, new RegExp(`deleted before run \\S+: ${userB} \\(last in run full\\)`));

    const refused = runCli(['--restore', dir, '--user', userB, '--overwrite']);
    assert.strictEqual(refused.status, 1, refused.stdout + refused.stderr);
    assert.match(refused.stderr, new RegExp(`User ${userB} was deleted before run \\S+ of the chain \\(last exported by run full\\): not restored; --through-run full restores the account as of that run`));
    assert.doesNotMatch(refused.stdout, /Restored:/);
    assert.ok(!(await streamsOfB()).includes(streamB), 'B not re-created');

    const asOfFull = runCli(['--restore', dir, '--user', userB, '--through-run', 'full', '--overwrite']);
    assertOk(asOfFull, 'restore as of the full run');
    assert.match(asOfFull.stdout, /Restored: 1 users/);
    assert.ok((await streamsOfB()).includes(streamB), 'B is back with its stream');
    // A single-account restore leaves the platform rows out: delete B again so
    // the platform and the users repository agree for the checks after this
    // test. Through the repository with the username given: on SQLite this
    // process still holds its handle on B's account file from before the
    // deletion, so it does not see the account fields the restore (another
    // process) wrote, and the API answers "Unknown user".
    const usersRepository = await require('business/src/users/repository.ts').getUsersRepository();
    await usersRepository.deleteOne(userB, userB);
  });
});
