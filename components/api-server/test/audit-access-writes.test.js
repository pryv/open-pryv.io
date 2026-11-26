/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */

import { createRequire } from 'node:module';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
const require = createRequire(import.meta.url);
const __dirname = dirname(fileURLToPath(import.meta.url));

/* global initTests, initCore, coreRequest, getNewFixture, assert, cuid */

const fs = require('node:fs');
const path = require('node:path');

// An app or shared access the server itself creates, changes or deletes leaves
// a record naming it in the account's trail. The OAuth consent and the token
// endpoint have theirs in oauth2-registry-consent, oauth2-e2e and
// oauth2-registry-purge; the address aliases in oauth2-per-user-audience.
describe('[ASDW] audit records of the accesses the server writes', function () {
  this.timeout(60_000);

  let fixtures, user, username, personalToken, personalId, auditStorage, originalForUser, storageLayer, mall;

  before(async function () {
    await initTests();
    await initCore();
    const config = await require('@pryv/boiler').getConfig();
    if (config.get('audit:active') !== true) this.skip();
    fixtures = getNewFixture();
    auditStorage = require('storages').auditStorage;
    originalForUser = auditStorage.forUser;
    storageLayer = await require('storage').getStorageLayer();
    mall = await require('api-server/src/methods/helpers/cmcMall.ts').buildMallForCmc();
    username = 'asdw-' + cuid().slice(-8);
    user = await fixtures.user(username);
    personalToken = cuid();
    personalId = (await user.access({ token: personalToken, type: 'personal' })).attrs.id;
    await user.session(personalToken);
    for (const id of ['s', 't']) await user.stream({ id, name: id });
  });

  afterEach(function () { if (auditStorage != null) auditStorage.forUser = originalForUser; });

  after(async function () {
    if (fixtures != null) {
      try { await fixtures.clean(); } catch (_e) { /* best-effort */ }
    }
  });

  async function rows () {
    const db = await originalForUser.call(auditStorage, username);
    return await db.getEvents({ query: [] });
  }

  /** The records `body` adds, by action (the server's access records, or the given actions). */
  async function added (body, actions = ['accesses.created', 'accesses.changed', 'accesses.deleted']) {
    const before = new Set((await rows()).map((e) => e.id));
    await body();
    return (await rows()).filter((e) => !before.has(e.id) && actions.includes(e.content?.action));
  }

  async function appAccess (extra = {}) {
    const token = cuid();
    const access = await user.access({ token, type: 'app', name: 'app-' + cuid(), permissions: [{ streamId: 's', level: 'manage' }, { streamId: 't', level: 'read' }], ...extra });
    return { id: access.attrs.id, token };
  }

  const who = () => ({ id: username, username });

  function assertRecord (row, action, access, expected) {
    assert.strictEqual(row.type, 'audit-log/access', JSON.stringify(row));
    assert.strictEqual(row.content.action, action);
    assert.deepStrictEqual(row.content.source, { name: expected.source });
    const { source, ...record } = expected;
    assert.deepStrictEqual(row.content.record, { accessId: access, ...record });
    for (const id of [access].concat(expected.related ?? [])) {
      assert.ok(row.streamIds.includes('access-' + id), JSON.stringify(row.streamIds));
    }
    assert.ok(row.streamIds.includes('action-' + action), JSON.stringify(row.streamIds));
  }

  it('[ASDW1] an access a plugin creates is recorded, without its token, name, address or counterparty', async function () {
    let created;
    const found = await added(async () => {
      created = await mall.accesses.create(username, {
        type: 'shared',
        name: 'secretname',
        permissions: [{ streamId: 's', level: 'read' }],
        clientData: { cmc: { role: 'data-grant', counterparty: { username: 'secretpeer', host: 'peer.example.com' } } }
      });
    });
    assert.strictEqual(found.length, 1, JSON.stringify(found));
    assertRecord(found[0], 'accesses.created', created.id, { source: 'cmc', accessType: 'shared', kind: 'data-grant', cause: 'plugin' });
    for (const secret of [created.token, 'secretname', 'secretpeer', 'peer.example.com']) {
      assert.ok(!JSON.stringify(found[0]).includes(secret), secret);
    }
  });

  it('[ASDW2] a plugin update is recorded when it changes the permissions or the expiry, not for its own marks', async function () {
    const { id } = await appAccess({ clientData: { cmc: { role: 'data-grant' } } });
    let found = await added(() => mall.accesses.update(username, { id, update: { permissions: [{ streamId: 's', level: 'read' }] } }));
    assert.strictEqual(found.length, 1, JSON.stringify(found));
    assertRecord(found[0], 'accesses.changed', id, { source: 'cmc', accessType: 'app', kind: 'data-grant', cause: 'plugin', changed: ['permissions'] });
    const expires = Date.now() / 1000 + 1000;
    found = await added(() => mall.accesses.update(username, { id, update: { expires } }));
    assert.deepStrictEqual(found.map((e) => e.content.record.changed), [['expires']]);
    // What the access already has, written back: nothing changed.
    found = await added(() => mall.accesses.update(username, { id, update: { permissions: [{ streamId: 's', level: 'read' }], expires } }));
    assert.deepStrictEqual(found, []);
    found = await added(() => mall.accesses.update(username, { id, update: { permissions: [{ streamId: 's', level: 'manage' }], expires } }));
    assert.deepStrictEqual(found.map((e) => e.content.record.changed), [['permissions']]);
    found = await added(() => mall.accesses.update(username, { id, update: { clientData: { cmc: { role: 'data-grant', mark: 1 } } } }));
    assert.deepStrictEqual(found, []);
  });

  it('[ASDW3] an access a plugin deletes is recorded once, with what it managed', async function () {
    const { id, token } = await appAccess({ clientData: { cmc: { role: 'data-grant' } } });
    const shared = await coreRequest.post('/' + username + '/accesses').set('Authorization', token)
      .send({ type: 'shared', name: 'sub-' + cuid(), permissions: [{ streamId: 's', level: 'read' }] });
    assert.strictEqual(shared.status, 201, JSON.stringify(shared.body));
    const sharedId = shared.body.access.id.split(':')[0];
    const found = await added(() => mall.accesses.delete(username, { id }));
    assert.strictEqual(found.length, 1, JSON.stringify(found));
    assertRecord(found[0], 'accesses.deleted', id, { source: 'cmc', accessType: 'app', kind: 'data-grant', cause: 'plugin', related: [sharedId] });
    assert.deepStrictEqual(await added(() => mall.accesses.delete(username, { id })), [], 'gone already');
  });

  it('[ASDWB] an access of the delegation plugin is recorded under that source; a personal one is not recorded', async function () {
    let created;
    let found = await added(async () => {
      created = await mall.accesses.create(username, { type: 'shared', name: 'd-' + cuid(), permissions: [{ streamId: 's', level: 'read' }], clientData: { delegation: { kind: 'control' } } });
    });
    assert.strictEqual(found.length, 1, JSON.stringify(found));
    assertRecord(found[0], 'accesses.created', created.id, { source: 'delegation', accessType: 'shared', kind: 'control', cause: 'plugin' });
    found = await added(() => mall.accesses.delete(username, { id: created.id }));
    assert.deepStrictEqual(found.map((e) => e.content.source.name), ['delegation']);
    let personal;
    found = await added(async () => {
      personal = await mall.accesses.create(username, { type: 'personal', name: 'd-' + cuid(), clientData: { delegation: { kind: 'delegate-pat' } } });
      await mall.accesses.delete(username, { id: personal.id });
    });
    assert.deepStrictEqual(found, []);
  });

  it('[ASDW7] a grant that changes: its sessions and what they created are recorded with the grant, changed then deleted', async function () {
    const { reconcileSessionsOfGrant } = require('api-server/src/methods/helpers/oauthSessionReconcile.ts');
    const grant = await appAccess({ clientData: { oauth: { grantOf: 'c' } } });
    const session = await appAccess({ name: 'oauth:c', clientData: { oauth: { dataGrantId: grant.id } } });
    const child = await user.access({ token: cuid(), type: 'shared', name: 'child-' + cuid(), permissions: [{ streamId: 's', level: 'manage' }], createdBy: session.id, clientData: { oauth: { dataGrantId: grant.id } } });
    const setGrant = (permissions) => new Promise((resolve, reject) =>
      storageLayer.accesses.updateOne(who(), { id: grant.id }, { permissions, modified: Date.now() / 1000 }, (err) => err ? reject(err) : resolve()));

    await setGrant([{ streamId: 's', level: 'read' }]);
    let found = await added(() => reconcileSessionsOfGrant(who(), grant.id));
    assert.deepStrictEqual(found.map((e) => e.content.action), ['accesses.changed', 'accesses.changed'], JSON.stringify(found));
    const byId = Object.fromEntries(found.map((e) => [e.content.record.accessId, e]));
    assertRecord(byId[session.id], 'accesses.changed', session.id, { source: 'oauth2', accessType: 'app', kind: 'oauth-session', cause: 'grant-changed', grantId: grant.id, changed: ['permissions'] });
    assertRecord(byId[child.attrs.id], 'accesses.changed', child.attrs.id, { source: 'oauth2', accessType: 'shared', kind: 'oauth-session-child', cause: 'grant-changed', grantId: grant.id, changed: ['permissions'] });
    assert.deepStrictEqual(await added(() => reconcileSessionsOfGrant(who(), grant.id)), [], 'nothing to change');

    await setGrant([{ streamId: 'elsewhere', level: 'read' }]);
    found = await added(() => reconcileSessionsOfGrant(who(), grant.id));
    const deleted = found.filter((e) => e.content.action === 'accesses.deleted');
    assert.deepStrictEqual(deleted.map((e) => e.content.record.accessId).concat(deleted.flatMap((e) => e.content.record.related ?? [])).sort(),
      [session.id, child.attrs.id].sort(), JSON.stringify(found));
    assert.ok(deleted.every((e) => e.content.record.grantId === grant.id && e.content.record.cause === 'grant-changed'));
  });

  function revokeGlue () {
    const { createSessions } = require('api-server/src/routes/oauth2/sessions.ts');
    const { createRevoke } = require('api-server/src/routes/oauth2/revoke.ts');
    const env = { config: { get: () => undefined }, storageLayer, logger: { warn: () => {}, debug: () => {}, info: () => {} } };
    return createRevoke(env, createSessions(env));
  }

  it('[ASDW6] the collapse of a chain names the grant and its sessions, beside its oauth event', async function () {
    const clientId = 'c-' + cuid();
    const grant = await appAccess({ clientData: { oauth: { grantOf: clientId } } });
    const session = await appAccess({ name: 'oauth:' + clientId, clientData: { oauth: { dataGrantId: grant.id } } });
    const found = await added(() => revokeGlue().revokeChain({ userId: username, username, clientId, dataGrantAccessId: grant.id }),
      ['accesses.deleted', 'oauth.token.revoked']);
    const deleted = found.filter((e) => e.content.action === 'accesses.deleted');
    assert.strictEqual(deleted.length, 1, JSON.stringify(found));
    assertRecord(deleted[0], 'accesses.deleted', grant.id, { source: 'oauth2', accessType: 'app', kind: 'oauth-grant', cause: 'refresh-token-reuse', related: [session.id] });
    assert.strictEqual(found.length - deleted.length, 1, 'one oauth.token.revoked');
  });

  it('[ASDW6b] a collapse whose teardown fails is recorded once, whether the access was gone or removed bare', async function () {
    const webhooks = storageLayer.webhooks;
    for (const late of [false, true]) {
      const clientId = 'c-' + cuid();
      const grant = await appAccess({ clientData: { oauth: { grantOf: clientId } } });
      const session = await appAccess({ name: 'oauth:' + clientId, clientData: { oauth: { dataGrantId: grant.id } } });
      let restore;
      if (late) {
        // after the rows are deleted
        const { pubsub } = require('messages');
        const emit = pubsub.scopedNotifications.emit;
        let failed = false;
        pubsub.scopedNotifications.emit = function (...args) { if (!failed) { failed = true; throw new Error('staged'); } return emit.apply(this, args); };
        restore = () => { pubsub.scopedNotifications.emit = emit; };
      } else {
        const original = webhooks.find;
        webhooks.find = (...args) => args.at(-1)(new Error('staged'));
        restore = () => { webhooks.find = original; };
      }
      let found;
      try {
        found = await added(() => revokeGlue().revokeChain({ userId: username, username, clientId, dataGrantAccessId: grant.id }));
      } finally {
        restore();
      }
      assert.deepStrictEqual(found.map((e) => [e.content.action, e.content.record.accessId, e.content.record.related]),
        [['accesses.deleted', grant.id, [session.id]]], 'late: ' + late);
    }
  });

  it('[ASDW8] a session revoked by its client is recorded', async function () {
    const clientId = 'c-' + cuid();
    const session = await appAccess({ name: 'oauth:' + clientId, clientData: { oauth: { dataGrantId: 'g' } } });
    let done;
    const found = await added(async () => { done = await revokeGlue().revokeSession({ userId: username, accessId: session.id, clientId }); });
    assert.strictEqual(done, true);
    assert.strictEqual(found.length, 1, JSON.stringify(found));
    assertRecord(found[0], 'accesses.deleted', session.id, { source: 'oauth2', accessType: 'app', kind: 'oauth-session', cause: 'client-revocation' });
  });

  it('[ASDW9] signing in and out, and the owner\'s own calls, add no server record', async function () {
    const found = await added(async () => {
      const created = await coreRequest.post('/' + username + '/accesses').set('Authorization', personalToken)
        .send({ type: 'shared', name: 'own-' + cuid(), permissions: [{ streamId: 's', level: 'read' }] });
      assert.strictEqual(created.status, 201, JSON.stringify(created.body));
      const updated = await coreRequest.put('/' + username + '/accesses/' + created.body.access.id).set('Authorization', personalToken)
        .send({ name: 'renamed-' + cuid() });
      assert.strictEqual(updated.status, 200, JSON.stringify(updated.body));
      const deleted = await coreRequest.delete('/' + username + '/accesses/' + updated.body.access.id).set('Authorization', personalToken);
      assert.strictEqual(deleted.status, 200, JSON.stringify(deleted.body));
    });
    assert.deepStrictEqual(found, []);
  });

  it('[ASDWG] the rows of accesses.update and accesses.delete name the access, and what was deleted with it', async function () {
    const { id, token } = await appAccess();
    const shared = await coreRequest.post('/' + username + '/accesses').set('Authorization', token)
      .send({ type: 'shared', name: 'sub-' + cuid(), permissions: [{ streamId: 's', level: 'read' }] });
    assert.strictEqual(shared.status, 201, JSON.stringify(shared.body));
    const sharedId = shared.body.access.id.split(':')[0];
    let head = id; // the id on the wire carries a serial once updated
    const call = async (method, body) => {
      const req = coreRequest[method]('/' + username + '/accesses/' + head).set('Authorization', personalToken);
      const res = await (body != null ? req.send(body) : req);
      assert.strictEqual(res.status, 200, JSON.stringify(res.body));
      head = res.body.access?.id ?? head;
    };
    const settled = async (action, body) => {
      const before = new Set((await rows()).map((e) => e.id));
      await body();
      // the row is written after the answer
      for (let i = 0; i < 100; i++) {
        const found = (await rows()).filter((e) => !before.has(e.id) && e.content?.action === action);
        if (found.length > 0) return found;
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      return [];
    };
    const updated = await settled('accesses.update', () => call('put', { name: 'renamed-' + cuid() }));
    assert.deepStrictEqual(updated.map((e) => e.content.record), [{ accessId: id }]);
    assert.ok(updated[0].streamIds.includes('access-' + personalId) && !updated[0].streamIds.includes('access-' + id), 'the caller is on the stream, not the target');
    const deleted = await settled('accesses.delete', () => call('delete'));
    assert.deepStrictEqual(deleted.map((e) => e.content.record), [{ accessId: id, related: [sharedId] }]);
  });

  it('[ASDWC] a record that cannot be written changes nothing for the write, and is counted once', async function () {
    const lossCounter = require('audit/src/lossCounter.ts');
    const { id } = await appAccess({ clientData: { cmc: { role: 'data-grant' } } });
    const before = lossCounter.snapshot().lost.total;
    auditStorage.forUser = async () => { throw new Error('staged: no audit storage'); };
    const outcome = await mall.accesses.delete(username, { id });
    auditStorage.forUser = originalForUser;
    assert.strictEqual(outcome.id, id);
    assert.strictEqual(lossCounter.snapshot().lost.total, before + 1);
    const left = await mall.accesses.getOne(username, { id });
    assert.strictEqual(left, null);
  });

  it('[ASDWD] no access deletion and no storage-direct access write of the API server is without its record', function () {
    const root = path.resolve(__dirname, '../src');
    const count = (pattern) => {
      const found = {};
      (function scan (dir) {
        for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
          const full = path.join(dir, entry.name);
          if (entry.isDirectory()) { scan(full); continue; }
          if (!entry.name.endsWith('.ts')) continue;
          const source = fs.readFileSync(full, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '').replace(/function deleteAccessChain \(/g, '');
          const n = [...source.matchAll(pattern)].length;
          if (n > 0) found[path.relative(root, full)] = n;
        }
      })(root);
      return found;
    };
    // The API route (its own row) and the recorded form.
    assert.deepStrictEqual(count(/\bdeleteAccessChain\(/g), { 'methods/accesses.ts': 1, 'methods/helpers/accessWriteAudit.ts': 1 });
    // Storage-direct writes of access rows. accessDeletion: under the two
    // above; oauthSessionReconcile: recorded; sessions.ts, oauthSessionRemoval
    // and revoke.ts: the `oauth.*` events and records of their callers; usage
    // statistics, sign-in and password reset: personal accesses or counters.
    assert.deepStrictEqual(count(/\b(?:accessesRepository|storageLayer\.accesses|accesses)\.(?:insertOne|updateOne|delete|removeOne|findOneAndUpdate|updateMany)\(/g), STORAGE_WRITES);
  });

  const STORAGE_WRITES = {
    'methods/accesses.ts': 2,
    'methods/helpers/accessDeletion.ts': 3,
    'methods/helpers/oauthSessionReconcile.ts': 2,
    'methods/helpers/oauthSessionRemoval.ts': 1,
    'routes/oauth2/revoke.ts': 1,
    'routes/oauth2/sessions.ts': 5
  };
});
