/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */

import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
/* global initTests, initCore, coreRequest, getNewFixture, assert, cuid */

// A unique account field written through the events API: the platform index
// claims the new value, releases the previous one once the event is written,
// and undoes the claim when the write fails. The test configuration has no
// editable unique custom field (email is refused here), so `insurancenumber`
// is made unique in-process for this file.
describe('[EVUF] events API on a unique account field', function () {
  this.timeout(30000);
  const accountStreams = require('business/src/system-streams/index.ts');
  let fixtures, mall, streamId, systemStream, savedIsUnique, savedIntegrityFlag;
  let one, two;

  async function account () {
    const username = cuid();
    const user = await fixtures.user(username);
    const token = cuid();
    await user.access({ type: 'personal', token });
    await user.session(token);
    return { username, token };
  }

  function createValue (who, value) {
    return coreRequest.post('/' + who.username + '/events').set('Authorization', who.token)
      .send({ streamIds: [streamId], type: 'string/pryv', content: value });
  }

  before(async function () {
    await initTests();
    await initCore();
    streamId = accountStreams.toStreamId('insurancenumber');
    systemStream = accountStreams.accountMap[streamId];
    savedIsUnique = systemStream.isUnique;
    systemStream.isUnique = true;
    // The final integrity check compares the index with the configuration,
    // which says not unique once restored.
    savedIntegrityFlag = process.env.DISABLE_INTEGRITY_CHECK;
    process.env.DISABLE_INTEGRITY_CHECK = '1';
    mall = await require('mall').getMall();
    fixtures = getNewFixture();
    one = await account();
    two = await account();
  });

  after(async function () {
    await fixtures.clean();
    systemStream.isUnique = savedIsUnique;
    if (savedIntegrityFlag == null) delete process.env.DISABLE_INTEGRITY_CHECK;
    else process.env.DISABLE_INTEGRITY_CHECK = savedIntegrityFlag;
  });

  it('[EVUF1] a value held by another account is refused', async function () {
    const value = String(Date.now()).slice(-9) + '1';
    assert.strictEqual((await createValue(one, value)).status, 201);
    const res = await createValue(two, value);
    assert.strictEqual(res.status, 409, JSON.stringify(res.body));
  });

  it('[EVUF2] creating a new value releases the previous one', async function () {
    const first = String(Date.now()).slice(-9) + '2';
    const second = String(Date.now()).slice(-9) + '3';
    assert.strictEqual((await createValue(one, first)).status, 201);
    assert.strictEqual((await createValue(one, second)).status, 201);
    assert.strictEqual((await createValue(two, first)).status, 201, 'the previous value is free again');
    assert.strictEqual((await createValue(two, second)).status, 409, 'the new value is held');
  });

  it('[EVUF3] updating the value releases the previous one', async function () {
    const first = String(Date.now()).slice(-9) + '4';
    const second = String(Date.now()).slice(-9) + '5';
    const created = await createValue(one, first);
    assert.strictEqual(created.status, 201);
    const upd = await coreRequest.put('/' + one.username + '/events/' + created.body.event.id)
      .set('Authorization', one.token).send({ content: second });
    assert.strictEqual(upd.status, 200, JSON.stringify(upd.body));
    assert.strictEqual((await createValue(two, first)).status, 201, 'the previous value is free again');
    assert.strictEqual((await createValue(two, second)).status, 409);
  });

  it('[EVUF4] a failed write undoes the claim and keeps the previous value', async function () {
    const kept = String(Date.now()).slice(-9) + '6';
    const failed = String(Date.now()).slice(-9) + '7';
    assert.strictEqual((await createValue(one, kept)).status, 201);
    const original = mall.events.create;
    mall.events.create = async function () {
      mall.events.create = original;
      throw new Error('injected write failure');
    };
    try {
      const res = await createValue(one, failed);
      assert.strictEqual(res.status, 500, JSON.stringify(res.body));
    } finally {
      mall.events.create = original;
    }
    assert.strictEqual((await createValue(two, failed)).status, 201, 'the claim of the failed write is undone');
    assert.strictEqual((await createValue(two, kept)).status, 409, 'the previous value is still held');
  });
});
