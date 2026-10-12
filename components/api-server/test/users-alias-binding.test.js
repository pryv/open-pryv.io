/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */

import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
/* global initTests, initCore, assert */

/**
 * [BXAL] binding an alias on a multi-core platform claims its name -> core
 * mapping and never overwrites one held for another core. Runs the users
 * repository over a recording stand-in for the platform and the local index.
 */

const { getUsersRepository } = require('business/src/users/index.ts');

describe('[BXAL] alias name -> core claim', function () {
  let repository, realPlatform, realIndex;

  before(async function () {
    await initTests();
    await initCore();
    repository = await getUsersRepository();
    realPlatform = repository.platform;
    realIndex = repository.usersIndex;
  });

  afterEach(function () {
    repository.platform = realPlatform;
    repository.usersIndex = realIndex;
  });

  /** A multi-core platform where `heldElsewhere` names route to core-b. */
  function standIns (heldElsewhere) {
    const calls = [];
    const aliasRows = new Set();
    repository.platform = {
      isSingleCore: false,
      async getUserCore () { return 'core-a'; },
      async setUserUniqueFieldIfNotExists (owner, field, value) {
        calls.push(['reserve', field, value]);
        if (aliasRows.has(value)) return false;
        aliasRows.add(value);
        return true;
      },
      async deleteUserUniqueField (field, value) { calls.push(['release', field, value]); aliasRows.delete(value); },
      async setUserCore (name, coreId) { calls.push(['overwrite', name, coreId]); },
      async setUserCoreIfNotExists (name, coreId) {
        calls.push(['claim', name, coreId]);
        return !heldElsewhere(name);
      }
    };
    repository.usersIndex = {
      async addAlias (alias, userId) { calls.push(['index', alias, userId]); }
    };
    return calls;
  }

  it('[BXAL1] a specific alias whose name another core holds is refused, its reservation given back, nothing bound', async function () {
    const calls = standIns((name) => name === 'held-elsewhere');
    const reserved = await repository.reserveSpecificAlias('owner', 'owner-id', 'held-elsewhere');
    assert.strictEqual(reserved, false);
    assert.ok(!calls.some(([op]) => op === 'overwrite'), 'no mapping overwritten: ' + JSON.stringify(calls));
    assert.ok(!calls.some(([op]) => op === 'index'), 'nothing indexed: ' + JSON.stringify(calls));
    assert.ok(calls.some(([op, field, value]) => op === 'release' && field === 'alias' && value === 'held-elsewhere'), JSON.stringify(calls));
  });

  it('[BXAL2] a minted alias whose name another core holds is given back and another one minted', async function () {
    let first = null;
    const calls = standIns((name) => { if (first == null) { first = name; return true; } return false; });
    const alias = await repository.mintAlias('owner', 'owner-id');
    assert.notStrictEqual(alias, first);
    assert.match(alias, /^r-[a-z0-9]{8}$/);
    assert.ok(!calls.some(([op]) => op === 'overwrite'), JSON.stringify(calls));
    assert.ok(calls.some(([op, , value]) => op === 'release' && value === first), JSON.stringify(calls));
    assert.deepStrictEqual(calls.filter(([op]) => op === 'index'), [['index', alias, 'owner-id']]);
  });

  it('[BXAL3] a name already mapped to this core (a former username) is confirmed and bound', async function () {
    const calls = standIns(() => false);
    assert.strictEqual(await repository.reserveSpecificAlias('owner', 'owner-id', 'former-name'), true);
    assert.deepStrictEqual(calls.filter(([op]) => op === 'index'), [['index', 'former-name', 'owner-id']]);
  });
});
