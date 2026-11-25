/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */

import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
/* global initTests, initCore, coreRequest, getNewFixture, assert, cuid */

const { ErrorIds } = require('errors');
const { ErrorMessages } = require('errors/src/ErrorMessages.ts');

// A permission naming an account field without its prefix (`email` for
// `:system:email`), with a `defaultName`, used to create an ordinary empty
// stream that looked like the account field on the consent screen. Refused
// for personal callers when no such stream exists.
describe('[AFNS] accesses: a bare account-field name does not create a stream', function () {
  this.timeout(60_000);

  let fixtures;

  before(async function () {
    await initTests();
    await initCore();
    fixtures = getNewFixture();
  });

  after(async function () {
    if (fixtures != null) {
      try { await fixtures.clean(); } catch (_e) { /* best-effort */ }
    }
  });

  async function newAccount () {
    const username = 'afns-' + cuid().slice(-8);
    const token = cuid();
    const user = await fixtures.user(username);
    await user.access({ token, type: 'personal' });
    await user.session(token);
    return { username, token, user };
  }

  function createAccess ({ username, token }, permissions, type = 'app') {
    return coreRequest.post('/' + username + '/accesses').set('Authorization', token)
      .send({ name: 'afns ' + cuid(), type, permissions });
  }

  async function streamIds ({ username, token }) {
    const res = await coreRequest.get('/' + username + '/streams').set('Authorization', token).query({ state: 'all' });
    assert.strictEqual(res.status, 200, res.text);
    const ids = [];
    const walk = (streams) => { for (const s of streams) { ids.push(s.id); walk(s.children ?? []); } };
    walk(res.body.streams);
    return ids;
  }

  function assertCollision (res, param, accountStreamId) {
    assert.strictEqual(res.status, 400, res.text);
    assert.deepStrictEqual(res.body.error, {
      id: ErrorIds.InvalidOperation,
      message: ErrorMessages[ErrorIds.AccountFieldNameCollision],
      data: { param, accountStreamId },
    });
  }

  it('[AFNC2] refused before any stream is created, the entries before it included', async function () {
    const account = await newAccount();
    const res = await createAccess(account, [
      { streamId: 'afnc-first', level: 'read', defaultName: 'First' },
      { streamId: 'email', level: 'read', defaultName: 'Email' },
    ]);
    assertCollision(res, 'email', ':system:email');
    const ids = await streamIds(account);
    assert.ok(!ids.includes('email'), 'no stream email');
    assert.ok(!ids.includes('afnc-first'), 'no stream for the entry before it');
  });

  it('[AFNC3] the local-store spelling is refused the same way', async function () {
    const account = await newAccount();
    const res = await createAccess(account, [{ streamId: ':local:email', level: 'read', defaultName: 'Email' }]);
    assertCollision(res, 'email', ':system:email');
    assert.ok(!(await streamIds(account)).includes('email'));
  });

  it('[AFNC4] accepted when the stream exists (created with streams.create)', async function () {
    const account = await newAccount();
    const made = await coreRequest.post('/' + account.username + '/streams').set('Authorization', account.token)
      .send({ id: 'email', name: 'Mail archive' });
    assert.strictEqual(made.status, 201, made.text);
    const res = await createAccess(account, [{ streamId: 'email', level: 'read', defaultName: 'Email' }]);
    assert.strictEqual(res.status, 201, res.text);
  });

  it('[AFNC5] accepted when the stream exists trashed; it is untrashed', async function () {
    const account = await newAccount();
    const made = await coreRequest.post('/' + account.username + '/streams').set('Authorization', account.token)
      .send({ id: 'email', name: 'Mail archive' });
    assert.strictEqual(made.status, 201, made.text);
    const trashed = await coreRequest.delete('/' + account.username + '/streams/email').set('Authorization', account.token);
    assert.strictEqual(trashed.status, 200, trashed.text);
    assert.strictEqual(trashed.body.stream.trashed, true);
    const res = await createAccess(account, [{ streamId: 'email', level: 'read', defaultName: 'Email' }]);
    assert.strictEqual(res.status, 201, res.text);
    const all = await coreRequest.get('/' + account.username + '/streams').set('Authorization', account.token);
    const email = all.body.streams.find((s) => s.id === 'email');
    assert.ok(email != null && email.trashed !== true, 'untrashed');
  });

  it('[AFNC6] accepted without defaultName; no stream is created', async function () {
    const account = await newAccount();
    const res = await createAccess(account, [{ streamId: 'email', level: 'read' }]);
    assert.strictEqual(res.status, 201, res.text);
    assert.ok(!(await streamIds(account)).includes('email'));
  });

  it('[AFNC7] an app access creating a shared access is not refused by this rule (it creates no stream)', async function () {
    const account = await newAccount();
    const appToken = cuid();
    await account.user.access({ type: 'app', name: 'afnc7 ' + cuid(), token: appToken, permissions: [{ streamId: '*', level: 'manage' }] });
    const res = await createAccess({ username: account.username, token: appToken },
      [{ streamId: 'email', level: 'read', defaultName: 'Email' }], 'shared');
    assert.strictEqual(res.status, 201, res.text);
    assert.ok(!(await streamIds(account)).includes('email'));
  });

  it('[AFNC8] accesses.update adding such an entry is refused', async function () {
    const account = await newAccount();
    const created = await createAccess(account, [{ streamId: 'afnc8', level: 'read', defaultName: 'Afnc8' }]);
    assert.strictEqual(created.status, 201, created.text);
    const res = await coreRequest.put('/' + account.username + '/accesses/' + created.body.access.id).set('Authorization', account.token)
      .send({ permissions: [{ streamId: 'afnc8-new', level: 'read', defaultName: 'New' }, { streamId: 'email', level: 'read', defaultName: 'Email' }] });
    assertCollision(res, 'email', ':system:email');
    const ids = await streamIds(account);
    assert.ok(!ids.includes('email') && !ids.includes('afnc8-new'), ids.join(','));
  });

  it('[AFNC9] accesses.checkApp reports it as the same error', async function () {
    const account = await newAccount();
    const res = await coreRequest.post('/' + account.username + '/accesses/check-app').set('Authorization', account.token)
      .send({ requestingAppId: 'afnc9-app', requestedPermissions: [{ streamId: 'email', level: 'read', defaultName: 'Email' }] });
    assertCollision(res, 'email', ':system:email');
  });

  it('[AFNCA] a hidden built-in field counts too', async function () {
    const account = await newAccount();
    const res = await createAccess(account, [{ streamId: 'referer', level: 'read', defaultName: 'Referer' }]);
    assertCollision(res, 'referer', ':_system:referer');
    assert.ok(!(await streamIds(account)).includes('referer'));
  });
});
