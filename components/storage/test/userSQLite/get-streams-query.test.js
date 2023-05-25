/**
 * @license
 * Copyright (C) 2020–2023 Pryv S.A. https://pryv.com
 *
 * This file is part of Open-Pryv.io and released under BSD-Clause-3 License
 *
 * Redistribution and use in source and binary forms, with or without
 * modification, are permitted provided that the following conditions are met:
 *
 * 1. Redistributions of source code must retain the above copyright notice,
 *   this list of conditions and the following disclaimer.
 *
 * 2. Redistributions in binary form must reproduce the above copyright notice,
 *   this list of conditions and the following disclaimer in the documentation
 *   and/or other materials provided with the distribution.
 *
 * 3. Neither the name of the copyright holder nor the names of its contributors
 *   may be used to endorse or promote products derived from this software
 *   without specific prior written permission.
 *
 * THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS "AS IS"
 * AND ANY EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT LIMITED TO, THE
 * IMPLIED WARRANTIES OF MERCHANTABILITY AND FITNESS FOR A PARTICULAR PURPOSE ARE
 * DISCLAIMED. IN NO EVENT SHALL THE COPYRIGHT HOLDER OR CONTRIBUTORS BE LIABLE
 * FOR ANY DIRECT, INDIRECT, INCIDENTAL, SPECIAL, EXEMPLARY, OR CONSEQUENTIAL
 * DAMAGES (INCLUDING, BUT NOT LIMITED TO, PROCUREMENT OF SUBSTITUTE GOODS OR
 * SERVICES; LOSS OF USE, DATA, OR PROFITS; OR BUSINESS INTERRUPTION) HOWEVER
 * CAUSED AND ON ANY THEORY OF LIABILITY, WHETHER IN CONTRACT, STRICT LIABILITY,
 * OR TORT (INCLUDING NEGLIGENCE OR OTHERWISE) ARISING IN ANY WAY OUT OF THE USE
 * OF THIS SOFTWARE, EVEN IF ADVISED OF THE POSSIBILITY OF SUCH DAMAGE.
 *
 * SPDX-License-Identifier: BSD-3-Clause
 */

const { assert } = require('chai');

const { toSQLiteQuery } = require('../../src/userSQLite/sqLiteStreamQueryUtils');

describe('[USQL] userSQLite toSqliteQuery()', function () {
  it('[YS6Y] must convert to SQLite including expansion', async function () {
    const clean = [[{ any: ['A', 'B', 'C'] }]];
    const sqllite = toSQLiteQuery(clean);
    assert.deepEqual(sqllite, '("A" OR "B" OR "C")');
  });

  it('[R8I5] must convert to SQLite including with "ALL"', async function () {
    const clean = [[{ any: ['B'] }]];
    const sqllite = toSQLiteQuery(clean);
    assert.deepEqual(sqllite, '"B"');
  });

  it('[SGO5] must convert to SQLite  streams query property "all" to "and: [{any..}, {any..}]) with each containing expanded streamIds', async function () {
    const clean = [[{ any: ['A'] }, { any: ['D'] }]];
    const sqllite = toSQLiteQuery(clean);
    assert.deepEqual(sqllite, '"A" AND "D"');
  });

  it('[RPGX] must convert to SQLite  streams query property "all" to "and: [{any..}, {any..}]) with each containing expanded streamIds', async function () {
    const clean = [[{ any: ['A'] }, { any: ['D', 'E'] }]];
    const sqllite = toSQLiteQuery(clean);
    assert.deepEqual(sqllite, '"A" AND ("D" OR "E")');
  });

  it('[EWLK] must convert to SQLite  streams query property "all" to "and: [{any..}, {any..}]) with each containing expanded streamIds', async function () {
    const clean = [[{ any: ['A'] }, { any: ['D'] }, { any: ['F'] }]];
    const sqllite = toSQLiteQuery(clean);
    assert.deepEqual(sqllite, '"A" AND "D" AND "F"');
  });

  it('[1FYY] must convert to SQLite including expansion with "NOT"', async function () {
    const clean = [[{ any: ['A', 'B'] }, { not: ['E'] }]];
    const sqllite = toSQLiteQuery(clean);
    assert.deepEqual(sqllite, '("A" OR "B") NOT "E"');
  });

  it('[4QSG] must convert to SQLite including expansion with "AND" and "NOT"', async function () {
    const clean = [[
      { any: ['A', 'B', 'C'] },
      { any: ['F'] },
      { not: ['D', 'E', 'F'] },
      { not: ['E'] }
    ]];
    const sqllite = toSQLiteQuery(clean);
    assert.deepEqual(sqllite, '("A" OR "B" OR "C") AND "F" NOT "D" NOT "E" NOT "F" NOT "E"');
  });

  it('[3TTK] must convert to SQLite including expansion with "ALL" and "NOT"', async function () {
    const clean = [[{ any: ['A', 'E'] }, { any: ['D'] }, { any: ['C'] }, { not: ['D', 'F'] }]];
    const sqllite = toSQLiteQuery(clean);
    assert.deepEqual(sqllite, '("A" OR "E") AND "D" AND "C" NOT "D" NOT "F"');
  });

  it('[1ZJU] must handle array of queries', async function () {
    const clean = [[{ any: ['B'] }], [{ any: ['D'] }, { not: ['E'] }]];
    const sqllite = toSQLiteQuery(clean);
    assert.deepEqual(sqllite, '("B") OR ("D" NOT "E")');
  });
});
