/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */

import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
const require = createRequire(import.meta.url);
const path = require('node:path');
const assert = require('node:assert');
const { execFileSync } = require('node:child_process');
const cuid = require('cuid');
const { produceStorageConnection, produceSeriesConnection } = require('./test-helpers');
const { databaseFixture, childStorageEngineEnv } = require('test-helpers');
const business = require('business');
const { DataMatrix } = require('business/src/series/data_matrix.ts');
const { seriesNamespace } = require('business/src/series/namespace.ts');

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../../');

/**
 * [HFGS] bin/gather-former-series.js: the series an account renamed by an
 * earlier release left under a former username are moved under its current
 * username, merged; a dry run moves
 * nothing; a second run finds nothing; an access alias gets no namespace.
 */
describe('[HFGS] gather-former-series tool', function () {
  this.timeout(120_000);
  let pryv, conn, usersIndex, username, formerName, accessAlias;
  const eventA = 'event.' + cuid();
  const eventB = 'event.' + cuid();

  async function append (name, measurement, rows) {
    const repo = new business.series.Repository(conn);
    const series = await repo.get(seriesNamespace(name), measurement);
    await series.append(new DataMatrix(['deltaTime', 'value'], rows));
  }

  // { measurement: [value, ...] in time order } of a namespace.
  async function contentOf (name) {
    const out = {};
    for (const { measurement, points } of (await conn.exportDatabase(seriesNamespace(name))).measurements) {
      out[measurement] = [...points].sort((a, b) => Number(a.time) - Number(b.time)).map((p) => p.value);
    }
    return out;
  }

  function runTool (...args) {
    return execFileSync(process.execPath, ['bin/gather-former-series.js', '--user', username, ...args], {
      cwd: repoRoot,
      env: { ...process.env, NODE_ENV: process.env.NODE_ENV || 'test', ...childStorageEngineEnv() },
      encoding: 'utf8'
    });
  }

  before(async function () {
    pryv = databaseFixture(await produceStorageConnection());
    conn = await produceSeriesConnection();
    usersIndex = await require('storage').getUsersLocalIndex();
    username = cuid();
    formerName = 'hfgs' + cuid.slug().toLowerCase();
    accessAlias = 'r-' + cuid.slug().toLowerCase().slice(0, 8);
    await pryv.user(username, {});
    // An account renamed by an earlier release: its former username is an
    // alias, its series stayed under it.
    await usersIndex.addAlias(formerName, username);
    await usersIndex.addAlias(accessAlias, username);
    await append(formerName, eventA, [[1, 1], [2, 2]]);
    await append(formerName, eventB, [[1, 3]]);
    await append(username, eventA, [[2, 20], [3, 30]]);
  });

  after(async function () {
    for (const name of [username, formerName, accessAlias]) await conn.dropDatabase(seriesNamespace(name));
    for (const name of [formerName, accessAlias]) await usersIndex.deleteAlias(name, username);
    await pryv.clean();
  });

  it('[HFGS1] a dry run reports the former namespace and moves nothing', async function () {
    const out = runTool('--dry-run');
    assert.match(out, /former namespaces with series\s+1 \(would be moved\)/);
    assert.match(out, new RegExp('"' + formerName + '" -> "' + username + '": 2 series, 3 points'));
    assert.deepStrictEqual(await contentOf(formerName), { [eventA]: [1, 2], [eventB]: [3] });
    assert.deepStrictEqual(await contentOf(username), { [eventA]: [20, 30] });
  });

  // On a clash (same series, same time) PostgreSQL and SQLite keep the point
  // already under the current username; InfluxDB's server-side copy keeps the
  // moved one.
  const clash = () => process.env.storages__series__engine === 'influxdb' ? 2 : 20;

  it('[HFGS2] the run moves them under the current username, merged', async function () {
    const out = runTool();
    assert.match(out, /former namespaces with series\s+1 \(moved\)/);
    assert.match(out, /failed, left as is\s+0\b/);
    assert.deepStrictEqual(await contentOf(username), { [eventA]: [1, clash(), 30], [eventB]: [3] });
    assert.deepStrictEqual(await contentOf(formerName), {}, 'nothing left under the former username');
    assert.ok(!(await conn.getDatabases()).includes(seriesNamespace(accessAlias)), 'no namespace for the access alias');
  });

  it('[HFGS3] a second run finds nothing to move', async function () {
    const out = runTool();
    assert.match(out, /former namespaces with series\s+0 \(moved\)/);
    assert.deepStrictEqual(await contentOf(username), { [eventA]: [1, clash(), 30], [eventB]: [3] });
  });
});
