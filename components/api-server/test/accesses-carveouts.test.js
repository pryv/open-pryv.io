/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */

import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
const require = createRequire(import.meta.url);
/* global initTests, initCore, coreRequest, getNewFixture, assert, cuid */

const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { getConfig } = require('@pryv/boiler');
const storage = require('storage');
const { fromCallback } = require('utils');

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../');

/**
 * [ACCV] An app access's narrower entries below a stream it grants to a
 * shared access it creates (`none`, `create-only`, a lower level) are carried
 * into that shared access, on accesses.create and accesses.update; the
 * read-only audit tool lists the shared accesses created before that.
 */
describe('[ACCV] accesses: creator carve-outs carried into child accesses', function () {
  this.timeout(60_000);
  let username, fixtureUser, user, accessStorage, personalToken;

  before(async function () {
    await initTests();
    await initCore();
    await getConfig();
    username = cuid();
    user = { id: username, username };
    accessStorage = (await storage.getStorageLayer()).accesses;
    fixtureUser = await getNewFixture().user(username);
    personalToken = cuid();
    await fixtureUser.access({ type: 'personal', token: personalToken });
    await fixtureUser.session(personalToken);
  });

  // A, A/B, A/B/C and Z, with one event in A, A/B and A/B/C.
  async function tree () {
    const t = { A: 'a' + cuid(), B: 'b' + cuid(), C: 'c' + cuid(), Z: 'z' + cuid() };
    const a = await fixtureUser.stream({ id: t.A, name: t.A });
    const b = await a.stream({ id: t.B, name: t.B });
    await b.stream({ id: t.C, name: t.C });
    await fixtureUser.stream({ id: t.Z, name: t.Z });
    t.evA = cuid(); t.evB = cuid(); t.evC = cuid();
    await fixtureUser.event({ id: t.evA, type: 'note/txt', content: 'in A', streamIds: [t.A] });
    await fixtureUser.event({ id: t.evB, type: 'note/txt', content: 'in B', streamIds: [t.B] });
    await fixtureUser.event({ id: t.evC, type: 'note/txt', content: 'in C', streamIds: [t.C] });
    return t;
  }

  async function appAccess (permissions) {
    const id = cuid();
    const token = cuid();
    await fixtureUser.access({ id, token, name: 'app ' + id, type: 'app', permissions });
    return { id, token };
  }

  async function createShared (token, permissions) {
    const res = await coreRequest.post('/' + username + '/accesses').set('Authorization', token)
      .send({ name: 'shared ' + cuid(), type: 'shared', permissions });
    assert.strictEqual(res.status, 201, JSON.stringify(res.body));
    return res.body.access;
  }

  async function storedPermissions (accessId) {
    const row = await fromCallback((cb) => accessStorage.findOne(user, { id: accessId }, null, cb));
    return row.permissions;
  }

  function levelOf (permissions, streamId) {
    const p = permissions.find((x) => x.streamId === streamId);
    return p ? p.level : undefined;
  }

  async function listedEventIds (token) {
    const res = await coreRequest.get('/' + username + '/events').set('Authorization', token).query({ limit: 1000 });
    assert.strictEqual(res.status, 200, JSON.stringify(res.body));
    return res.body.events.map((e) => e.id);
  }

  async function getOneStatus (token, eventId) {
    const res = await coreRequest.get('/' + username + '/events/' + eventId).set('Authorization', token);
    return res.status;
  }

  it('[ACCV01] `none` below the grant: the child carries it and cannot read A/B (events.get, getOne)', async function () {
    const t = await tree();
    const app = await appAccess([{ streamId: t.A, level: 'read' }, { streamId: t.B, level: 'none' }]);
    const child = await createShared(app.token, [{ streamId: t.A, level: 'read' }]);
    assert.strictEqual(await getOneStatus(child.token, t.evA), 200);
    assert.strictEqual(await getOneStatus(child.token, t.evB), 403);
    assert.strictEqual(await getOneStatus(child.token, t.evC), 403);
    const listed = await listedEventIds(child.token);
    assert.ok(listed.includes(t.evA), 'A is still readable');
    assert.ok(!listed.includes(t.evB), 'A/B is not listed');
    assert.ok(!listed.includes(t.evC), 'A/B/C is not listed');
    assert.strictEqual(levelOf(await storedPermissions(child.id), t.B), 'none');
  });

  it('[ACCV02] `create-only` below the grant: the child carries it and cannot read or update A/B', async function () {
    const t = await tree();
    const app = await appAccess([{ streamId: t.A, level: 'contribute' }, { streamId: t.B, level: 'create-only' }]);
    const child = await createShared(app.token, [{ streamId: t.A, level: 'contribute' }]);
    assert.strictEqual(levelOf(await storedPermissions(child.id), t.B), 'create-only');
    assert.ok(!(await listedEventIds(child.token)).includes(t.evB));
    assert.strictEqual(await getOneStatus(child.token, t.evB), 403);
    const upd = await coreRequest.put('/' + username + '/events/' + t.evB).set('Authorization', child.token)
      .send({ content: 'changed' });
    assert.strictEqual(upd.status, 403);
  });

  it('[ACCV03] a lower level below the grant: the child carries it and cannot write in A/B', async function () {
    const t = await tree();
    const app = await appAccess([{ streamId: t.A, level: 'contribute' }, { streamId: t.B, level: 'read' }]);
    const child = await createShared(app.token, [{ streamId: t.A, level: 'contribute' }]);
    assert.strictEqual(levelOf(await storedPermissions(child.id), t.B), 'read');
    const inB = await coreRequest.post('/' + username + '/events').set('Authorization', child.token)
      .send({ type: 'note/txt', content: 'x', streamIds: [t.B] });
    assert.strictEqual(inB.status, 403);
    const inA = await coreRequest.post('/' + username + '/events').set('Authorization', child.token)
      .send({ type: 'note/txt', content: 'x', streamIds: [t.A] });
    assert.strictEqual(inA.status, 201);
    assert.strictEqual(await getOneStatus(child.token, t.evB), 200, 'reading A/B stays allowed');
  });

  it('[ACCV04] `read` below a `create-only` grant leaves nothing: the child gets `none` there', async function () {
    const t = await tree();
    const app = await appAccess([{ streamId: t.A, level: 'contribute' }, { streamId: t.B, level: 'read' }]);
    const child = await createShared(app.token, [{ streamId: t.A, level: 'create-only' }]);
    assert.strictEqual(levelOf(await storedPermissions(child.id), t.B), 'none');
  });

  it('[ACCV05] a `*` grant carries the creator\'s carve-outs anywhere in the store', async function () {
    const t = await tree();
    const app = await appAccess([{ streamId: '*', level: 'read' }, { streamId: t.B, level: 'none' }]);
    const child = await createShared(app.token, [{ streamId: '*', level: 'read' }]);
    assert.strictEqual(levelOf(await storedPermissions(child.id), t.B), 'none');
    assert.strictEqual(await getOneStatus(child.token, t.evB), 403);
    assert.strictEqual(await getOneStatus(child.token, t.evA), 200);
  });

  it('[ACCV06] a grant inside a carve-out keeps its reach: A/B/C stays readable under A/B none', async function () {
    const t = await tree();
    const app = await appAccess([{ streamId: t.A, level: 'read' }, { streamId: t.B, level: 'none' }, { streamId: t.C, level: 'read' }]);
    const child = await createShared(app.token, [{ streamId: t.A, level: 'read' }]);
    const perms = await storedPermissions(child.id);
    assert.strictEqual(levelOf(perms, t.B), 'none');
    assert.strictEqual(levelOf(perms, t.C), 'read');
    assert.strictEqual(await getOneStatus(child.token, t.evB), 403);
    assert.strictEqual(await getOneStatus(child.token, t.evC), 200);
  });

  it('[ACCV07] regression: entries outside the granted streams, or not narrower, are not added', async function () {
    const t = await tree();
    const app = await appAccess([{ streamId: t.A, level: 'read' }, { streamId: t.B, level: 'read' }, { streamId: t.Z, level: 'none' }]);
    const child = await createShared(app.token, [{ streamId: t.A, level: 'read' }]);
    const streamPerms = (await storedPermissions(child.id)).filter((p) => p.streamId != null);
    assert.deepStrictEqual(streamPerms, [{ streamId: t.A, level: 'read' }]);
  });

  it('[ACCV08] regression: a personal token creates exactly what it asks for', async function () {
    const t = await tree();
    const child = await createShared(personalToken, [{ streamId: t.A, level: 'read' }]);
    const streamPerms = (await storedPermissions(child.id)).filter((p) => p.streamId != null);
    assert.deepStrictEqual(streamPerms, [{ streamId: t.A, level: 'read' }]);
  });

  it('[ACCV09] accesses.update widening a child to A carries the managing app\'s carve-out', async function () {
    const t = await tree();
    const app = await appAccess([{ streamId: t.A, level: 'read' }, { streamId: t.B, level: 'none' }, { streamId: t.Z, level: 'read' }]);
    // The child starts on Z only, then is widened to A, by the owner and by the app.
    const child = await createShared(app.token, [{ streamId: t.Z, level: 'read' }]);
    let head = child.id;
    for (const token of [personalToken, app.token]) {
      const narrow = await coreRequest.put('/' + username + '/accesses/' + head).set('Authorization', personalToken)
        .send({ permissions: [{ streamId: t.Z, level: 'read' }] });
      assert.strictEqual(narrow.status, 200, JSON.stringify(narrow.body));
      assert.strictEqual(levelOf(await storedPermissions(child.id), t.B), undefined, 'fixture: no carve-out yet');
      const res = await coreRequest.put('/' + username + '/accesses/' + narrow.body.access.id).set('Authorization', token)
        .send({ permissions: [{ streamId: t.A, level: 'read' }] });
      assert.strictEqual(res.status, 200, JSON.stringify(res.body));
      head = res.body.access.id;
      assert.strictEqual(levelOf(await storedPermissions(child.id), t.B), 'none');
      assert.strictEqual(await getOneStatus(child.token, t.evA), 200);
      assert.strictEqual(await getOneStatus(child.token, t.evB), 403);
      assert.ok(!(await listedEventIds(child.token)).includes(t.evB));
    }
  });

  describe('[ACCV10] bin/access-scope-audit.js', function () {
    // The test harness picks the storage engines in this process's memory
    // config; a separate process reads the config files only, so hand the
    // resolved engines over through the environment.
    async function engineEnv () {
      const config = await getConfig();
      const env = {};
      for (const kind of ['base', 'series', 'file']) {
        const engine = config.get('storages:' + kind + ':engine');
        if (engine != null) env['storages__' + kind + '__engine'] = engine;
      }
      return env;
    }

    async function runTool (...args) {
      return execFileSync(process.execPath, ['bin/access-scope-audit.js', '--user', username, ...args], {
        cwd: repoRoot,
        env: { ...process.env, NODE_ENV: process.env.NODE_ENV || 'test', ...(await engineEnv()) },
        encoding: 'utf8'
      });
    }

    it('[ACCV10A] reports a child planted without the carve-out, ignores a compliant one, and writes nothing', async function () {
      const t = await tree();
      const app = await appAccess([{ streamId: t.A, level: 'read' }, { streamId: t.B, level: 'none' }]);
      const overId = cuid();
      const overToken = cuid();
      await fixtureUser.access({
        id: overId,
        token: overToken,
        name: 'over ' + overId,
        type: 'shared',
        permissions: [{ streamId: t.A, level: 'read' }],
        createdBy: app.id,
        modifiedBy: app.id
      });
      const okChild = await createShared(app.token, [{ streamId: t.A, level: 'read' }]);
      const before = await fromCallback((cb) => accessStorage.findOne(user, { id: overId }, null, cb));

      const out = await runTool();
      assert.match(out, /REPORT ONLY/);
      assert.ok(out.includes('access ' + overId + ' (shared, created by ' + app.id + '): reaches a carve-out (1 missing entry)'), out);
      assert.ok(!out.includes(okChild.id), 'the compliant child is not listed');
      assert.ok(!out.includes(overToken) && !out.includes(app.token), 'tokens are never printed');

      const after = await fromCallback((cb) => accessStorage.findOne(user, { id: overId }, null, cb));
      assert.deepStrictEqual(after.permissions, before.permissions);
      assert.strictEqual(after.modified, before.modified);
      assert.strictEqual(after.serial ?? null, before.serial ?? null);
    });

    it('[ACCV10B] --help prints the usage and exits 0', function () {
      const out = execFileSync(process.execPath, ['bin/access-scope-audit.js', '--help'], { cwd: repoRoot, encoding: 'utf8' });
      assert.match(out, /Report only: nothing is written/);
    });
  });
});
