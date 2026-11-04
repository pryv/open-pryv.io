/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */

import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);

/**
 * [DXCR] deleting an account on a core of a multi-core platform while the
 * platform routes its username to another core (that core's account of the
 * name: taken there after an earlier attempt of this deletion freed it, or
 * restored there): this core's data of the account is deleted, and the
 * platform rows of the name (routing, unique and indexed values) are left to
 * the other core. The users repository runs over the test platform store as
 * a member of a multi-core platform; the other core is its routing row.
 */

/* global initTests, initCore, getNewFixture, assert */

const cuid = require('cuid');
const { getUsersRepository } = require('business/src/users/index.ts');

const SLUG = cuid.slug().toLowerCase();
const THIS_CORE = 'dxcr-a-' + SLUG;
const OTHER_CORE = 'dxcr-b-' + SLUG;

describe('[DXCR] account deletion of a name routed to another core', function () {
  let repository, realPlatform, platformDB;
  const fixtures = [];

  before(async function () {
    await initTests();
    await initCore();
    repository = await getUsersRepository();
    realPlatform = repository.platform;
    platformDB = require('storages').platformDB;
  });

  afterEach(function () {
    repository.platform = realPlatform;
  });

  after(async function () {
    for (const f of fixtures) await f.clean();
  });

  /** The repository sees the platform as `THIS_CORE` of a multi-core platform. */
  function asMultiCore () {
    repository.platform = new Proxy(realPlatform, {
      get (target, prop) {
        if (prop === 'isSingleCore') return false;
        if (prop === 'coreId') return THIS_CORE;
        const value = Reflect.get(target, prop, target);
        return typeof value === 'function' ? value.bind(target) : value;
      }
    });
  }

  async function account () {
    const fx = getNewFixture();
    fixtures.push(fx);
    const username = ('dxcr' + cuid().toLowerCase().replace(/[^a-z0-9]/g, '')).slice(0, 20);
    const fu = await fx.user(username);
    return { id: fu.attrs.id, username, token: realPlatform.hashFor('username', username) };
  }

  async function rowsOf (u) {
    const rows = await platformDB.getAllForUser(u.token);
    return rows.map((r) => JSON.stringify([r.isUnique, r.field, r.value])).sort();
  }

  it('[DXCR1] the account is deleted on this core; the name keeps its routing row and its unique and indexed values', async function () {
    const u = await account();
    const rows = await rowsOf(u);
    assert.ok(rows.some((r) => r.startsWith('[true,"email"')), JSON.stringify(rows));
    await realPlatform.setUserCore(u.username, OTHER_CORE);
    try {
      asMultiCore();
      await repository.deleteOne(u.id, u.username);
      repository.platform = realPlatform;
      assert.equal(await repository.getUserIdForUsername(u.username), null, 'deleted on this core');
      assert.strictEqual(await realPlatform.getUserCore(u.username), OTHER_CORE, 'still routed to the other core');
      assert.deepStrictEqual(await rowsOf(u), rows, 'the rows of the name are kept');
    } finally {
      repository.platform = realPlatform;
      await realPlatform.deleteUser(u.username);
      await realPlatform.deleteUserCore(u.username);
    }
  });

  it('[DXCR2] a name routed to this core loses its rows and routing; an alias routed to another core keeps its routing row', async function () {
    const u = await account();
    const ownAlias = 'dxcra' + SLUG;
    const movedAlias = 'dxcrb' + SLUG;
    await realPlatform.setUserCore(u.username, THIS_CORE);
    try {
      asMultiCore();
      assert.strictEqual(await repository.reserveSpecificAlias(u.username, u.id, ownAlias), true);
      assert.strictEqual(await repository.reserveSpecificAlias(u.username, u.id, movedAlias), true);
      assert.strictEqual(await realPlatform.getUserCore(ownAlias), THIS_CORE);
      await realPlatform.setUserCore(movedAlias, OTHER_CORE);

      await repository.deleteOne(u.id, u.username);
      repository.platform = realPlatform;
      assert.equal(await repository.getUserIdForUsername(u.username), null, 'deleted on this core');
      assert.strictEqual(await realPlatform.getUserCore(u.username), null, 'routing row removed');
      assert.deepStrictEqual(await rowsOf(u), [], 'unique and indexed rows removed');
      assert.strictEqual(await realPlatform.getUserCore(ownAlias), null, 'the alias routed here is released');
      assert.strictEqual(await realPlatform.getUserCore(movedAlias), OTHER_CORE, 'the alias routed to the other core is kept');
    } finally {
      repository.platform = realPlatform;
      for (const name of [u.username, ownAlias, movedAlias]) await realPlatform.deleteUserCore(name);
    }
  });
});
