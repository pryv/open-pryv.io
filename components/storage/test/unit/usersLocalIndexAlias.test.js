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
