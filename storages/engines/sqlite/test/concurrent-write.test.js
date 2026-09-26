/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */

import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const concurrentSafeWrite = require('storages/engines/sqlite/src/concurrentSafeWrite.ts');
const assert = require('node:assert');

describe('[UCSQ] userSQLite Storage concurent Writes', () => {
  before(async () => {
  });

  it('[69AH] should retry when SQLITE_BUSY', async () => {
    let callCount = 0;
    // function that throws at first call only
    function statement () {
      callCount++;
      if (callCount > 20) return true;
      throw mockBusyError();
    }
    await concurrentSafeWrite.execute(statement, 21);
    assert.strictEqual(callCount, 21);
  });

  it('[9H7P] should fail when max retries is reached when SQLITE_BUSY', async () => {
    let callCount = 0;
    // function that throws at first call only
    function statement () {
      callCount++;
      if (callCount > 20) return true;
      throw mockBusyError();
    }
    try {
      await concurrentSafeWrite.execute(statement, 5);
      assert.fail('should not be reached');
    } catch (err) {
      assert.strictEqual(err.message, 'Failed write action on SQLite after 5 retries');
    }
  });

  it('[UCS3] retries the extended busy codes too, and nothing else', async () => {
    let calls = 0;
    await concurrentSafeWrite.execute(() => {
      calls++;
      if (calls === 1) throw Object.assign(new Error(), { code: 'SQLITE_BUSY_SNAPSHOT' });
      return true;
    }, 3);
    assert.strictEqual(calls, 2);
    await assert.rejects(concurrentSafeWrite.execute(() => { throw Object.assign(new Error('x'), { code: 'SQLITE_CONSTRAINT' }); }, 3), /x/);
  });
});

function mockBusyError () {
  return Object.assign(new Error(), { code: 'SQLITE_BUSY' });
}
