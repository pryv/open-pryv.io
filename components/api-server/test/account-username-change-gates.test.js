/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */

import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);

/* global initTests, initCore, coreRequest, getNewFixture, assert, cuid */

const PASSWORD = 'test-password-1';
const APP_ID = 'pryv-test-no-cors'; // trusted for any origin in test-config

function freshName (prefix = 'u') {
  return (prefix + cuid()).toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 20);
}

async function freshUser (prefix) {
  const uname = freshName(prefix);
  const fu = await getNewFixture().user(uname, { password: PASSWORD });
  return { uname, fu, userId: fu.attrs.id, email: fu.attrs.email };
}

async function login (uname) {
  const res = await coreRequest
    .post('/' + uname + '/auth/login')
    .send({ username: uname, password: PASSWORD, appId: APP_ID });
  assert.equal(res.status, 200, 'login: ' + JSON.stringify(res.body));
  return res.body.token;
}

function changeUsername (addressedName, newUsername, token) {
  return coreRequest
    .post('/' + addressedName + '/account/change-username')
    .set('Authorization', token)
    .send({ newUsername });
}

describe('[UCRC] changeUsername gates (the availability check passed, the name taken meanwhile)', function () {
  let usersRepository, platform, usersIndex;

  before(async function () {
    await initTests();
    await initCore();
    const { getUsersRepository } = require('business/src/users/index.ts');
    usersRepository = await getUsersRepository();
    platform = usersRepository.platform;
    usersIndex = usersRepository.usersIndex;
  });

  /** The account still holds `name` exactly as before a refused change. */
  async function assertUnchanged ({ uname, userId, email }) {
    assert.strictEqual(await usersRepository.getUserIdForUsername(uname), userId, 'the name still resolves to the account');
    assert.strictEqual(await usersRepository.getUsernameForUserId(userId), uname, 'and is still its username');
    assert.ok(!(await usersIndex.getAliasesForId(userId)).includes(uname), 'not left as an alias');
    assert.strictEqual(await platform.getUsersUniqueField('alias', uname), null, 'no alias reservation left');
    assert.strictEqual(await platform.getUsersUniqueField('email', email), platform.hashFor('username', uname), 'the email row keeps its owner');
    assert.strictEqual(await usersRepository.getUsernameChangeCount(userId), 0, 'no change counted');
  }

  it('[UCRC1] a name another account of this core holds as its username is refused, nothing written', async function () {
    const renamer = await freshUser('ra');
    const holder = await freshUser('rb');
    await assert.rejects(usersRepository.changeUsername(renamer.userId, renamer.uname, holder.uname, 'system'),
      (err) => err.id === 'item-already-exists', 'refused as taken');
    await assertUnchanged(renamer);
    assert.strictEqual(await usersRepository.getUserIdForUsername(holder.uname), holder.userId, 'the holder keeps its name');
    assert.strictEqual(await platform.getUsersUniqueField('email', holder.email), platform.hashFor('username', holder.uname));
  });

  it('[UCRC2] a name another account holds as an alias (a former username) is refused, the holder keeps it', async function () {
    const renamer = await freshUser('rc');
    const holder = await freshUser('rd');
    await usersRepository.changeUsername(holder.userId, holder.uname, freshName('re'), 'system');
    await assert.rejects(usersRepository.changeUsername(renamer.userId, renamer.uname, holder.uname, 'system'),
      (err) => err.id === 'item-already-exists', 'refused as taken');
    await assertUnchanged(renamer);
    assert.strictEqual(await usersRepository.getUserIdForUsername(holder.uname), holder.userId, 'the former name still routes to its account');
  });

  it('[UCRC3] when the current name cannot be kept as an alias, the change is refused and nothing written', async function () {
    const renamer = await freshUser('rf');
    const original = platform.setUserUniqueFieldIfNotExists;
    platform.setUserUniqueFieldIfNotExists = async function (owner, field, value) {
      if (field === 'alias' && value === renamer.uname) return false;
      return await original.call(this, owner, field, value);
    };
    try {
      await assert.rejects(usersRepository.changeUsername(renamer.userId, renamer.uname, freshName('rg'), 'system'),
        (err) => err.id === 'invalid-operation');
    } finally {
      platform.setUserUniqueFieldIfNotExists = original;
    }
    await assertUnchanged(renamer);
  });

  it('[UCRC4] of two concurrent changes of one account to different names, one applies and is counted once', async function () {
    const { uname, userId } = await freshUser('rh');
    const token = await login(uname);
    const names = [freshName('ri'), freshName('rj')];
    const results = await Promise.all(names.map((n) => changeUsername(uname, n, token)));
    const applied = results.filter((r) => r.status === 200);
    assert.strictEqual(applied.length, 1, JSON.stringify(results.map((r) => [r.status, r.body])));
    const loser = results.find((r) => r.status !== 200);
    assert.strictEqual(loser.status, 400, JSON.stringify(loser.body));
    const current = applied[0].body.account.username;
    assert.strictEqual(await usersRepository.getUsernameForUserId(userId), current);
    assert.strictEqual(await usersRepository.getUserIdForUsername(uname), userId, 'the former name routes');
    const other = names.find((n) => n !== current);
    assert.strictEqual(await usersRepository.getUserIdForUsername(other), undefined, 'the other name is not taken');
    assert.strictEqual(await usersRepository.getUsernameChangeCount(userId), 1);
  });

  it('[UCRC6] a storage failure after the gates is undone: the account stays whole under its name, the new name stays free, a retry applies', async function () {
    const failures = [
      ['platform rows, failing before any write', () => {
        const original = platform.renameUser;
        platform.renameUser = async function (from, to) {
          if (platform.renameUser.failNext) { platform.renameUser.failNext = false; throw new Error('injected'); }
          return await original.call(this, from, to);
        };
        platform.renameUser.failNext = true;
        return () => { platform.renameUser = original; };
      }],
      ['platform rows, failing after every write', () => {
        const original = platform.renameUser;
        platform.renameUser = async function (from, to) {
          await original.call(this, from, to);
          if (platform.renameUser.failNext) { platform.renameUser.failNext = false; throw new Error('injected'); }
        };
        platform.renameUser.failNext = true;
        return () => { platform.renameUser = original; };
      }],
      ['username account field', () => {
        const storage = usersRepository.userAccountStorage;
        const original = storage.setAccountField;
        storage.setAccountField = async function (userId, field, ...rest) {
          if (field === 'username') throw new Error('injected');
          return await original.call(this, userId, field, ...rest);
        };
        return () => { storage.setAccountField = original; };
      }]
    ];
    for (const [where, inject] of failures) {
      const renamer = await freshUser('rm');
      const target = freshName('rn');
      const restore = inject();
      try {
        await assert.rejects(usersRepository.changeUsername(renamer.userId, renamer.uname, target, 'system'),
          (err) => err.id === 'unexpected-error', where);
      } finally {
        restore();
      }
      await assertUnchanged(renamer);
      assert.strictEqual(await usersRepository.getUserIdForUsername(target), undefined, where + ': the new name is free');
      assert.strictEqual(await platform.getUsersUniqueField('username', target), null, where + ': no platform row for the new name');
      await usersRepository.changeUsername(renamer.userId, renamer.uname, target, 'system');
      assert.strictEqual(await usersRepository.getUsernameForUserId(renamer.userId), target, where + ': a retry applies');
      assert.strictEqual(await usersRepository.getUsernameChangeCount(renamer.userId), 1, where);
    }
  });

  it('[UCRC7] deleting the account by a former name removes its platform rows', async function () {
    const { uname, userId, email } = await freshUser('ro');
    await usersRepository.changeUsername(userId, uname, freshName('rp'), 'system');
    await usersRepository.deleteOne(userId, uname);
    assert.strictEqual(await platform.getUsersUniqueField('email', email), null, 'the email row is released');
    assert.strictEqual(await usersRepository.getUserIdForUsername(uname), undefined, 'the former name is free');
  });

  it('[UCRC5] of two concurrent changes of one account to the same name, one applies and the account stays whole', async function () {
    const { uname, userId, email } = await freshUser('rk');
    const target = freshName('rl');
    const results = await Promise.allSettled([1, 2].map(() => usersRepository.changeUsername(userId, uname, target, 'system')));
    assert.strictEqual(results.filter((r) => r.status === 'fulfilled').length, 1, JSON.stringify(results));
    assert.strictEqual(results.find((r) => r.status === 'rejected').reason.id, 'invalid-operation');
    assert.strictEqual(await usersRepository.getUsernameForUserId(userId), target);
    assert.strictEqual(await usersRepository.getUserIdForUsername(uname), userId, 'the former name routes');
    assert.notStrictEqual(await platform.getUsersUniqueField('alias', uname), null, 'and is reserved');
    assert.strictEqual(await platform.getUsersUniqueField('email', email), platform.hashFor('username', target));
    assert.strictEqual(await usersRepository.getUsernameChangeCount(userId), 1);
  });
});
