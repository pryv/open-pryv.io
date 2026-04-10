/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */

const assert = require('assert');
const { sanitize } = require('storages/interfaces/backup/sanitize');

describe('backup/sanitize', function () {
  it('strips _id, __v, userId, user_id', function () {
    const doc = { _id: 'abc', __v: 0, userId: 'u1', user_id: 'u1', name: 'test', type: 'note' };
    const clean = sanitize(doc);
    assert.strictEqual(clean.name, 'test');
    assert.strictEqual(clean.type, 'note');
    assert.strictEqual(clean._id, undefined);
    assert.strictEqual(clean.__v, undefined);
    assert.strictEqual(clean.userId, undefined);
    assert.strictEqual(clean.user_id, undefined);
  });

  it('promotes _id to id for events (no existing id field)', function () {
    const doc = { _id: 'evt123', streamIds: ['s1'], type: 'note/txt' };
    const clean = sanitize(doc);
    assert.strictEqual(clean.id, 'evt123');
    assert.strictEqual(clean._id, undefined);
  });

  it('promotes _id to id for accesses', function () {
    const doc = { _id: 'acc123', token: 'tok', type: 'personal' };
    const clean = sanitize(doc);
    assert.strictEqual(clean.id, 'acc123');
  });

  it('renames streamId to id (engine-agnostic backup format)', function () {
    const doc = { _id: '67890bcd', streamId: 'my-stream', name: 'My Stream' };
    const clean = sanitize(doc);
    assert.strictEqual(clean.id, 'my-stream');
    assert.strictEqual(clean.streamId, undefined);
    assert.strictEqual(clean.name, 'My Stream');
  });

  it('preserves existing id field without overwriting', function () {
    const doc = { _id: 'mongo-id', id: 'app-id', name: 'test' };
    const clean = sanitize(doc);
    assert.strictEqual(clean.id, 'app-id');
  });

  it('handles ObjectId-like objects by calling toString()', function () {
    const fakeObjectId = { toString () { return '507f1f77bcf86cd799439011'; } };
    const doc = { _id: fakeObjectId, type: 'note/txt' };
    const clean = sanitize(doc);
    assert.strictEqual(clean.id, '507f1f77bcf86cd799439011');
  });

  it('returns null/undefined as-is', function () {
    assert.strictEqual(sanitize(null), null);
    assert.strictEqual(sanitize(undefined), undefined);
  });

  it('returns empty object for doc with only internal fields', function () {
    const doc = { _id: 'x', userId: 'u' };
    const clean = sanitize(doc);
    assert.strictEqual(clean.id, 'x');
    assert.deepStrictEqual(Object.keys(clean), ['id']);
  });
});
