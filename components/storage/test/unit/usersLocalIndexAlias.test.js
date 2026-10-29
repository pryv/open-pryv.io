/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */

import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const assert = require('node:assert');
const cuid = require('cuid');
const { getUsersLocalIndex } = require('storage');

// An alias row is removed only for the user that holds it: the owner is part
// of the delete, not a check made beforehand by the caller.
describe('[ALDK] users local index: alias removal', function () {
  let index;
  const owner = cuid();
  const other = cuid();
  const alias = 'r-' + cuid().slice(-8);

  before(async function () {
    index = await getUsersLocalIndex();
  });

  after(async function () {
    await index.deleteAliasesForId(owner);
  });

  it('[ALDK1] deleteAlias(alias, userId) removes the alias of that user only', async function () {
    await index.addAlias(alias, owner);
    await index.deleteAlias(alias, other);
    assert.deepStrictEqual(await index.getAliasesForId(owner), [alias], 'another user cannot remove it');
    await index.deleteAlias(alias, owner);
    assert.deepStrictEqual(await index.getAliasesForId(owner), []);
  });
});

// The change-username flow relies on the rename itself to refuse: a name held
// by another user, and a name no longer held (a concurrent rename won).
describe('[ULRN] users local index: rename', function () {
  let index;
  const userA = cuid();
  const userB = cuid();
  const nameA = 'ulrna' + cuid().slice(-8);
  const nameB = 'ulrnb' + cuid().slice(-8);
  const nameC = 'ulrnc' + cuid().slice(-8);

  before(async function () {
    index = await getUsersLocalIndex();
    await index.addUser(nameA, userA);
    await index.addUser(nameB, userB);
  });

  after(async function () {
    await index.deleteById(userA);
    await index.deleteById(userB);
  });

  it('[ULRN1] resolves true once renamed, false when no user holds the old name, rejects a name another user holds', async function () {
    await assert.rejects(index.renameUser(nameA, nameB));
    assert.strictEqual(await index.getUserId(nameA), userA, 'nothing renamed');
    assert.strictEqual(await index.renameUser(nameA, nameC), true);
    assert.strictEqual(await index.getUsername(userA), nameC);
    assert.strictEqual(await index.renameUser(nameA, nameC + 'x'), false, 'the old name is gone');
    assert.strictEqual(await index.getUsername(userA), nameC);
  });

  it('[ULRN2] resolveName tells the canonical username from an alias', async function () {
    const alias = 'r-' + cuid().slice(-8);
    await index.addAlias(alias, userB);
    try {
      for (let i = 0; i < 2; i++) { // storage, then cache
        assert.deepStrictEqual(await index.resolveName(nameB), { userId: userB, isCanonical: true });
        assert.deepStrictEqual(await index.resolveName(alias), { userId: userB, isCanonical: false });
      }
      assert.strictEqual(await index.resolveName('ulrn-nobody-' + cuid().slice(-6)), undefined);
    } finally {
      await index.deleteAlias(alias, userB);
    }
  });
});
