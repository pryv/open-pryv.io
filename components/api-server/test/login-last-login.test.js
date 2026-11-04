/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */

import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);

/**
 * [LGLL] a completed sign-in records `lastLogin` on the personal access.
 *
 * `lastLogin` is the OpenID Connect `auth_time` of a consent made with that
 * access. It is written when the sign-in completes: at the password step
 * when no second factor is asked for, else when the factor is verified. It
 * is covered by the access integrity hash, so each write must leave a valid
 * one.
 */

const crypto = require('node:crypto');
const timestamp = require('unix-timestamp');
const { getStorageLayer } = require('storage');
const { integrity } = require('business');
const { withInjectedConfig, injectTestConfigSnapshot } = require('test-helpers');
const { _resetMFASingletons } = require('business/src/mfa/index.ts');
const { base32Decode, totpCode } = require('business/src/mfa/totp.ts');

/* global initTests, initCore, coreRequest, getNewFixture, assert, cuid */

const totpConfig = {
  services: {
    mfa: {
      active: true,
      defaultMethod: 'totp',
      methods: {
        totp: { active: true, digits: 6, periodSeconds: 30, driftSteps: 1, secretsKey: crypto.randomBytes(32).toString('base64') },
        sms: { active: false }
      },
      sessions: { ttlSeconds: 1800 }
    }
  }
};

function totpCodeFor (secretB32, offsetSteps) {
  return totpCode(base32Decode(secretB32), { time: Math.floor(Date.now() / 1000) + offsetSteps * 30, periodSeconds: 30, digits: 6 });
}

describe('[LGLL] sign-in records lastLogin', function () {
  this.timeout(30000);

  const PASSWORD = 'lgll-password-123';
  const APP_ID = 'pryv-test-no-cors'; // trusted for any origin in test-config

  let storageLayer;

  before(async function () {
    await initTests();
    await initCore();
    storageLayer = await getStorageLayer();
  });

  async function freshUser () {
    const username = ('lgll' + cuid().toLowerCase().replace(/[^a-z0-9]/g, '')).slice(0, 20);
    const fu = await getNewFixture().user(username, { password: PASSWORD });
    return { username, user: { id: fu.attrs.id, username } };
  }

  async function login (username) {
    const res = await coreRequest
      .post('/' + username + '/auth/login')
      .send({ username, password: PASSWORD, appId: APP_ID });
    assert.equal(res.status, 200, 'login: ' + JSON.stringify(res.body));
    return res.body;
  }

  function personalAccess (user) {
    return new Promise((resolve, reject) => {
      storageLayer.accesses.findOne(user, { name: APP_ID, type: 'personal' }, null, (err, access) => (err ? reject(err) : resolve(access)));
    });
  }

  function assertIntegrity (access) {
    if (!integrity.accesses.isActive) return;
    assert.equal(access.integrity, integrity.accesses.hash(access), 'the stored integrity matches the access');
  }

  it('[LGLL1] a login records lastLogin, with access tracking off too, and leaves a valid integrity', async function () {
    const { username, user } = await freshUser();
    const before = timestamp.now();
    await withInjectedConfig({ accessTracking: { isActive: false } }, async () => {
      await login(username);
    });
    const access = await personalAccess(user);
    assert.ok(access != null, 'personal access created');
    assert.equal(typeof access.lastLogin, 'number');
    assert.ok(access.lastLogin >= before - 1 && access.lastLogin <= timestamp.now() + 1, 'lastLogin is the login time');
    assert.ok(access.lastUsed == null, 'no usage recorded with tracking off');
    assertIntegrity(access);
  });

  it('[LGLL2] a later login moves lastLogin forward on the same access', async function () {
    const { username, user } = await freshUser();
    const firstToken = (await login(username)).token;
    const first = await personalAccess(user);
    const secondToken = (await login(username)).token;
    const second = await personalAccess(user);
    assert.equal(second.id, first.id, 'same access');
    assert.equal(secondToken, firstToken, 'same token (the session is reused)');
    assert.ok(second.lastLogin > first.lastLogin, 'lastLogin moved: ' + first.lastLogin + ' then ' + second.lastLogin);
    assertIntegrity(second);
  });

  it('[LGLL3] with a second factor, the password step leaves lastLogin untouched and mfa.verify records it', async function () {
    const { username, user } = await freshUser();
    const restore = injectTestConfigSnapshot(totpConfig);
    await _resetMFASingletons();
    try {
      const token = (await login(username)).token;
      const act = await coreRequest.post('/' + username + '/mfa/activate').set('Authorization', token).send({ method: 'totp' });
      assert.equal(act.status, 200, JSON.stringify(act.body));
      // The confirm uses the previous step's code, leaving the current one to the verify.
      const left = 30 - (Math.floor(Date.now() / 1000) % 30);
      if (left < 5) await new Promise((resolve) => setTimeout(resolve, left * 1000 + 100));
      const confirm = await coreRequest.post('/' + username + '/mfa/confirm').set('Authorization', act.body.mfaToken)
        .send({ code: totpCodeFor(act.body.secret, -1) });
      assert.equal(confirm.status, 200, JSON.stringify(confirm.body));
      const beforePending = await personalAccess(user);

      const pending = await login(username);
      assert.equal(typeof pending.mfaToken, 'string', 'the second factor is asked for');
      const whilePending = await personalAccess(user);
      assert.equal(whilePending.lastLogin, beforePending.lastLogin, 'the password step records no sign-in');
      assertIntegrity(whilePending);

      const verifyStart = timestamp.now();
      const verify = await coreRequest.post('/' + username + '/mfa/verify').set('Authorization', pending.mfaToken)
        .send({ code: totpCodeFor(act.body.secret, 0) });
      assert.equal(verify.status, 200, JSON.stringify(verify.body));
      const after = await personalAccess(user);
      assert.equal(after.token, verify.body.token, 'the released token is the access token');
      assert.ok(after.lastLogin >= verifyStart, 'lastLogin is the verify time: ' + after.lastLogin + ' < ' + verifyStart);
      assertIntegrity(after);
    } finally {
      restore();
      await _resetMFASingletons();
    }
  });

  it('[LGLL4] lastLogin is read-only: reported by getAccessInfo, refused by accesses.create', async function () {
    const { username } = await freshUser();
    const token = (await login(username)).token;
    const info = await coreRequest.get('/' + username + '/access-info').set('Authorization', token);
    assert.equal(info.status, 200, JSON.stringify(info.body));
    assert.equal(typeof info.body.lastLogin, 'number');
    const create = await coreRequest.post('/' + username + '/accesses').set('Authorization', token)
      .send({ name: 'lgll-app', type: 'app', permissions: [{ streamId: '*', level: 'read' }], lastLogin: 1 });
    assert.equal(create.status, 400, JSON.stringify(create.body));
  });

  it('[LGLL5] PostgreSQL: the last_login migration adds the column and can run twice', async function () {
    const storages = require('storages');
    if (storageLayer.accesses.constructor.name !== 'AccessesPG' || storages.databasePG == null) return this.skip();
    const migration = require('storages/engines/postgresql/migrations/20261102_120000_access_last_login.js');
    const hasColumn = async (client) => (await client.query(
      "SELECT 1 FROM information_schema.columns WHERE table_name = 'accesses' AND column_name = 'last_login'")).rows.length === 1;
    // In a transaction rolled back at the end: dropping the column for real
    // would lose the values the access integrity hashes cover.
    const ROLLBACK = new Error('rollback');
    const seen = [];
    await assert.rejects(storages.databasePG.withTransaction(async (client) => {
      await client.query('ALTER TABLE accesses DROP COLUMN last_login;');
      seen.push(await hasColumn(client));
      await migration.up({ db: client });
      seen.push(await hasColumn(client));
      await migration.up({ db: client });
      seen.push(await hasColumn(client));
      throw ROLLBACK;
    }), (err) => err === ROLLBACK);
    assert.deepEqual(seen, [false, true, true]);
    assert.equal(await hasColumn(storages.databasePG), true, 'the column is back after the rollback');
    const { username, user } = await freshUser();
    await login(username);
    assert.equal(typeof (await personalAccess(user)).lastLogin, 'number', 'written with the column in place');
  });
});
