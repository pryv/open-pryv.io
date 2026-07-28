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
/* global initTests, initCore, coreRequest, getNewFixture, assert, cuid, charlatan, config */

const path = require('path');
const fs = require('fs');
const os = require('os');
const { spawnSync } = require('child_process');

// components/audit/test/acceptance -> repo root is four levels up.
const CLI = path.resolve(__dirname, '../../../../bin/breach-scope.js');
const REPO_ROOT = path.resolve(__dirname, '../../../../');

function runCli (args) {
  const res = spawnSync('node', [CLI, ...args], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
    timeout: 60000,
    env: process.env // inherit NODE_ENV=test + rqlite/PG/pepper injection
  });
  return { status: res.status, stdout: res.stdout || '', stderr: res.stderr || '' };
}

describe('[BRSC] bin/breach-scope.js CLI', function () {
  let username, personalToken, appAccessId;
  let basePath, tmpDir;
  let sinceIso, untilIso;

  before(async function () {
    this.timeout(60000);
    await initTests();
    if (!config.get('audit:active')) { this.skip(); return; }
    await initCore();

    const fixtures = getNewFixture();
    username = charlatan.Lorem.characters(8).toLowerCase();
    const user = await fixtures.user(username, { password: cuid() });
    await user.stream({ id: 'yo', name: 'YO' });
    personalToken = cuid();
    await user.access({ type: 'personal', token: personalToken });
    await user.session(personalToken);
    basePath = '/' + username;

    // App access created through the API so the reverse-index hook indexes it.
    const created = await coreRequest
      .post(basePath + '/accesses')
      .set('Authorization', personalToken)
      .send({ name: 'brsc-' + cuid(), type: 'app', token: 'brsc-tok-' + cuid(), permissions: [{ streamId: 'yo', level: 'manage' }] });
    assert.strictEqual(created.status, 201, JSON.stringify(created.body));
    appAccessId = created.body.access.id;
    const appToken = created.body.access.token;

    // Seed events, then drive a spread of audited calls with the app access.
    for (let i = 0; i < 3; i++) {
      await coreRequest.post(basePath + '/events').set('Authorization', appToken)
        .send({ streamIds: ['yo'], type: 'note/txt', content: 'e' + i });
    }
    const sinceTs = Date.now() / 1000 - 300;
    sinceIso = new Date((sinceTs) * 1000).toISOString();

    // scoped read (recordCount = 3), a getOne, a write, and an error call
    const list = await coreRequest.get(basePath + '/events').set('Authorization', appToken).query({ streams: ['yo'] });
    assert.strictEqual(list.status, 200);
    const firstId = list.body.events[0].id;
    await coreRequest.get(basePath + '/events/' + firstId).set('Authorization', appToken);
    await coreRequest.post(basePath + '/events').set('Authorization', appToken)
      .send({ streamIds: ['yo'], type: 'note/txt', content: 'written-during-window' });
    await coreRequest.get(basePath + '/events').set('Authorization', appToken).query({ fromTime: 'not-a-number' });

    untilIso = new Date((Date.now() / 1000 + 300) * 1000).toISOString();
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'brsc-'));
  });

  after(async function () {
    if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
    const { getUsersRepository } = require('business/src/users/index.ts');
    const usersRepository = await getUsersRepository();
    await usersRepository.deleteAll();
  });

  it('[BRSC1] produces a JSON report resolving the subject + record counts (hashed-mode recovery)', function () {
    const res = runCli(['--access', appAccessId, '--since', sinceIso, '--until', untilIso, '--json']);
    assert.strictEqual(res.status, 0, res.stderr);
    const report = JSON.parse(res.stdout);
    assert.strictEqual(report.reportVersion, 1);
    assert.strictEqual(report.subject.count, 1);
    // Hashed-mode: the CLI recovered the plaintext username locally from the token.
    assert.strictEqual(report.subject.username, username, 'subject resolved from the access token');
    assert.strictEqual(report.access.type, 'app');
    assert.ok(report.records.read.recordsRead >= 3, 'scoped read of the 3 seeded events counted: ' + report.records.read.recordsRead);
    assert.ok(report.records.written.calls >= 1, 'the write during the window counted');
    assert.ok(report.activity.byAction['events.get'] && report.activity.byAction['events.get'].valid >= 1);
    assert.ok(report.activity.errorCalls >= 1, 'the bad-parameter read is an error row');
    const codes = report.caveats.map((c) => c.code);
    assert.ok(codes.includes('G7') && codes.includes('G2') && !codes.includes('G1'), 'caveats present, no G1');
    // OD2: the local stream 'yo' resolves to its name best-effort.
    const yoStream = report.dataCategories.streams.find((s) => s.id === 'yo');
    assert.ok(yoStream, 'yo stream present in dataCategories');
    assert.strictEqual(yoStream.name, 'YO', 'stream-name resolution filled the name');
    assert.strictEqual(yoStream.resolvedAtReportTime, true);
  });

  it('[BRSC2] --output writes both a .json and a .md file', function () {
    const jsonOut = path.join(tmpDir, 'report.json');
    const mdOut = path.join(tmpDir, 'report.md');
    const res = runCli(['--access', appAccessId, '--since', sinceIso, '--until', untilIso, '--output', jsonOut, '--output', mdOut]);
    assert.strictEqual(res.status, 0, res.stderr);
    const report = JSON.parse(fs.readFileSync(jsonOut, 'utf8'));
    assert.strictEqual(report.subject.username, username);
    const md = fs.readFileSync(mdOut, 'utf8');
    assert.ok(md.includes('# Breach-scope report'));
    assert.ok(md.includes('actual exposure per call is <= scope'));
  });

  it('[BRSC3] exits 3 when the accessId is not in the index', function () {
    const res = runCli(['--access', 'cnot-indexed-' + cuid(), '--since', sinceIso, '--json']);
    assert.strictEqual(res.status, 3, res.stderr);
    assert.match(res.stderr, /not in the reverse-index/);
  });

  it('[BRSC4] exits 2 on a bad --since date', function () {
    const res = runCli(['--access', appAccessId, '--since', 'yesterdayish']);
    assert.strictEqual(res.status, 2, res.stderr);
    assert.match(res.stderr, /invalid --since/);
  });

  it('[BRSC5] --help exits 0 with usage', function () {
    const res = runCli(['--help']);
    assert.strictEqual(res.status, 0);
    assert.match(res.stdout, /Usage:/);
  });
});
