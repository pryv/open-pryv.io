/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */

/**
 * The streams engine must invalidate the cache AFTER the write completes, not
 * before: a bust that fires before the write leaves a window where a concurrent
 * read commits a stale tree into the cache with a valid epoch that no later bust
 * removes. These probes drive StreamsPG with a fake db that logs read/write
 * ordering against a recording cache; the bust must always follow the write.
 */

import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
/* global it, describe, beforeEach, afterEach */

const assert = require('node:assert');
const { StreamsPG } = require('../src/user/StreamsPG.ts');
const { _internals } = require('../src/_internals.ts');

// Fake db: records 'read' for SELECT (the _computePath lookup) and 'write' for
// INSERT/UPDATE, and resolves so super.* invokes the callback.
function makeFakeDb (log, opts = {}) {
  return {
    query: (sql) => {
      const verb = String(sql).trim().split(/\s+/)[0].toUpperCase();
      if (verb === 'SELECT') {
        log.push('read');
        return Promise.resolve({ rows: [{ path: 'parent/' }] });
      }
      log.push('write');
      if (opts.failWrite) return Promise.reject(new Error('write failed'));
      return Promise.resolve({ rows: [{}], rowCount: 1 });
    }
  };
}

function callAsync (fn) {
  return new Promise((resolve) => {
    fn((err, res) => resolve({ err, res }));
  });
}

describe('[SBUS] StreamsPG busts the cache after the write', function () {
  let log, savedCache;
  beforeEach(function () {
    log = [];
    savedCache = _internals.cache;
    _internals.set('cache', {
      unsetUserData: () => log.push('bust:unsetUserData'),
      unsetStreams: () => log.push('bust:unsetStreams')
    });
  });
  afterEach(function () {
    _internals.set('cache', savedCache);
  });

  it('[SB01] insertOne (path preset) busts after the INSERT', async function () {
    const s = new StreamsPG(makeFakeDb(log));
    await callAsync((cb) => s.insertOne('u1', { id: 'a', name: 'n', path: 'a/' }, cb));
    assert.ok(log.indexOf('bust:unsetUserData') > log.indexOf('write'), `order: ${log}`);
  });

  it('[SB02] insertOne (computePath branch) busts after the INSERT, not the SELECT', async function () {
    const s = new StreamsPG(makeFakeDb(log));
    await callAsync((cb) => s.insertOne('u1', { id: 'a', name: 'n', parentId: 'root' }, cb));
    assert.ok(log.includes('read'), `expected a computePath SELECT: ${log}`);
    assert.ok(log.indexOf('bust:unsetUserData') > log.lastIndexOf('write'), `bust must follow the INSERT: ${log}`);
  });

  it('[SB03] updateOne with parentId busts unsetUserData after the UPDATE', async function () {
    const s = new StreamsPG(makeFakeDb(log));
    await callAsync((cb) => s.updateOne('u1', { id: 'a' }, { parentId: 'root' }, cb));
    assert.ok(log.indexOf('bust:unsetUserData') > log.indexOf('write'), `order: ${log}`);
    assert.strictEqual(log.indexOf('bust:unsetStreams'), -1, 'parentId change must use unsetUserData');
  });

  it('[SB04] updateOne without parentId busts unsetStreams after the UPDATE', async function () {
    const s = new StreamsPG(makeFakeDb(log));
    await callAsync((cb) => s.updateOne('u1', { id: 'a' }, { name: 'renamed' }, cb));
    assert.ok(log.indexOf('bust:unsetStreams') > log.indexOf('write'), `order: ${log}`);
    assert.strictEqual(log.indexOf('bust:unsetUserData'), -1, 'non-parentId change must use unsetStreams');
  });

  it('[SB05] delete busts after the soft-delete UPDATE', async function () {
    const s = new StreamsPG(makeFakeDb(log));
    await callAsync((cb) => s.delete('u1', { id: 'a' }, cb));
    assert.ok(log.indexOf('bust:unsetUserData') > log.indexOf('write'), `order: ${log}`);
  });

  it('[SB06] insertOne busts exactly once, after the write attempt, on write failure', async function () {
    const s = new StreamsPG(makeFakeDb(log, { failWrite: true }));
    const { err } = await callAsync((cb) => s.insertOne('u1', { id: 'a', name: 'n', path: 'a/' }, cb));
    assert.ok(err != null, 'the write error propagates to the callback');
    const busts = log.filter((e) => e === 'bust:unsetUserData');
    assert.strictEqual(busts.length, 1, `exactly one bust (ambiguous-failure safety): ${log}`);
    assert.ok(log.indexOf('bust:unsetUserData') > log.indexOf('write'), `bust follows the write attempt: ${log}`);
  });
});
