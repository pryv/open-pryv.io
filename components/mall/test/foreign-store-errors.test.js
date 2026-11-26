/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */

import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { APIError } = require('errors');
const Mall = require('../src/Mall.ts').default;

/**
 * [XDSE] A data store that resolves its own copy of `@pryv/datastore` (its
 * own node_modules) throws errors of that copy, not API errors: the core
 * still answers the id they carry, as with its own copy.
 */
describe('[XDSE] errors of a data store built with another copy of @pryv/datastore', function () {
  let tmp, foreign;

  before(function () {
    // A second copy of the package, loaded from another path: its factories
    // are not the ones the core replaced.
    const pkgDir = path.dirname(require.resolve('@pryv/datastore/package.json'));
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'xdse-'));
    fs.cpSync(path.join(pkgDir, 'src'), path.join(tmp, 'src'), { recursive: true });
    foreign = require(path.join(tmp, 'src', 'index.js'));
    assert.notStrictEqual(foreign.errors, require('@pryv/datastore').errors, 'a separate copy');
    assert.ok(!(foreign.errors.unknownResource('user', 'u1') instanceof APIError), 'its errors are not API errors');
  });

  after(function () {
    if (tmp != null) fs.rmSync(tmp, { recursive: true, force: true });
  });

  function mallWith (throwing) {
    const store = foreign.createDataStore({
      async init () { return this; },
      async deleteUser () { throw throwing(); },
      async getUserStorageInfos () { throw throwing(); }
    });
    const mall = new Mall();
    mall.addStore(store, { id: 'ext', name: 'Ext' });
    return mall;
  }

  async function rejection (promise) {
    try {
      await promise;
    } catch (err) {
      return err;
    }
    assert.fail('expected a rejection');
  }

  it('[XDSE1] the error ids of another copy are kept, with their status', async function () {
    const cases = [
      [() => foreign.errors.unknownResource('user', 'u1'), 'unknown-resource', 404],
      [() => foreign.errors.itemAlreadyExists('event', { id: 'e1' }), 'item-already-exists', 409],
      [() => foreign.errors.invalidItemId('bad id'), 'invalid-item-id', 400],
      [() => foreign.errors.invalidRequestStructure('bad request', { a: 1 }), 'invalid-request-structure', 400]
    ];
    for (const [throwing, id, status] of cases) {
      const err = await rejection(mallWith(throwing).deleteUser('u1'));
      assert.ok(err instanceof APIError, id);
      assert.strictEqual(err.id, id);
      assert.strictEqual(err.httpStatus, status, id);
      // a message even from a copy that never set one
      assert.match(err.message, /^Error from data store "ext": \S/, id);
    }
    const infos = await rejection(mallWith(cases[0][0]).getUserStorageInfos('u1'));
    assert.strictEqual(infos.id, 'unknown-resource');
  });

  it('[XDSE2] an unsupported operation of another copy is answered as with the core\'s copy', async function () {
    const own = require('@pryv/datastore').errors.unsupportedOperation('nope');
    const err = await rejection(mallWith(() => foreign.errors.unsupportedOperation('nope')).deleteUser('u1'));
    assert.strictEqual(err.id, own.id);
    assert.strictEqual(err.httpStatus, own.httpStatus);
  });

  it('[XDSE3] an error marked by a copy of the package is recognised by its mark', async function () {
    const marked = Object.assign(new Error('gone'), { id: 'unknown-resource', data: { resourceType: 'stream', id: 's1' } });
    marked[Symbol.for('@pryv/datastore:error')] = true;
    const err = await rejection(mallWith(() => marked).deleteUser('u1'));
    assert.strictEqual(err.id, 'unknown-resource');
    assert.strictEqual(err.httpStatus, 404);
  });

  it('[XDSE4] an unexpected error, an unknown id or an unmarked error stays unexpected', async function () {
    const unknownId = Object.assign(new Error('x'), { id: 'not-an-id' });
    unknownId[Symbol.for('@pryv/datastore:error')] = true;
    for (const throwing of [
      () => foreign.errors.unexpectedError('boom'),
      () => unknownId,
      () => Object.assign(new Error('plain'), { id: 'unknown-resource' })
    ]) {
      const err = await rejection(mallWith(throwing).deleteUser('u1'));
      assert.strictEqual(err.id, 'unexpected-error');
      assert.strictEqual(err.httpStatus, 500);
    }
    // An API error is never re-mapped, marked or not.
    const { factory } = require('errors');
    const api = new APIError('unknown-resource', 'x', { httpStatus: 404 });
    api[Symbol.for('@pryv/datastore:error')] = true;
    assert.strictEqual(factory.unexpectedError(api).id, 'unexpected-error');
  });
});
