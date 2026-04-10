/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */

/**
 * Tests for helpers.dynData() - dynamic test data generator
 * These tests verify that dynData creates isolated datasets with unique IDs
 */

/* global initTests, initCore, coreRequest, assert */

// NOTE: These tests require api-server infrastructure (initCore, coreRequest).
// Consider creating a separate test setup for test-helpers if needed.

const helpers = require('test-helpers');

describe('[DYND] dynData', function () {
  before(async function () {
    await initTests();
    await initCore();
  });

  describe('[DYN01] ID generation', function () {
    it('[DY01] must generate unique IDs for each instance', function () {
      const data1 = helpers.dynData({ prefix: 'test1' });
      const data2 = helpers.dynData({ prefix: 'test2' });

      // Prefixes should be different
      assert.notStrictEqual(data1.prefix, data2.prefix, 'prefixes should differ');

      // Users should have different IDs
      assert.notStrictEqual(data1.users[0].id, data2.users[0].id,
        `user IDs should differ: ${data1.users[0].id} vs ${data2.users[0].id}`);
      assert.notStrictEqual(data1.users[0].username, data2.users[0].username);

      // Accesses should have different IDs and tokens
      assert.notStrictEqual(data1.accesses[0].id, data2.accesses[0].id);
      assert.notStrictEqual(data1.accesses[0].token, data2.accesses[0].token);

      // Streams should have different IDs
      assert.notStrictEqual(data1.streams[0].id, data2.streams[0].id);

      // Events should have different IDs
      assert.notStrictEqual(data1.events[0].id, data2.events[0].id);
    });

    it('[DY02] must use provided prefix in IDs', function () {
      const data = helpers.dynData({ prefix: 'mytest' });

      assert.ok(data.users[0].id.includes('mytest'));
      assert.ok(data.accesses[0].token.includes('mytest'));
      assert.ok(data.streams[0].id.includes('mytest'));
    });

    it('[DY03] must preserve stream hierarchy with correct parent references', function () {
      const data = helpers.dynData();

      // Check that child streams reference correct dynamic parent IDs
      const stream0 = data.streams[0];
      const child00 = stream0.children[0];
      const child01 = stream0.children[1];

      assert.strictEqual(child00.parentId, stream0.id);
      assert.strictEqual(child01.parentId, stream0.id);
    });

    it('[DY04] must maintain access permissions with correct stream references', function () {
      const data = helpers.dynData();

      // accesses[1] has permissions referencing streams[0], streams[1], streams[2].children[0]
      const access = data.accesses[1];

      // All streamIds in permissions should be dynamic IDs (contain prefix)
      for (const perm of access.permissions) {
        if (perm.streamId !== '*') {
          assert.ok(perm.streamId.includes(data.prefix),
            `streamId ${perm.streamId} should contain prefix ${data.prefix}`);
        }
      }
    });

    it('[DY05] must preserve event streamIds with correct references', function () {
      const data = helpers.dynData();

      // Check that event streamIds reference dynamic IDs
      const event = data.events[0];
      assert.ok(event.streamIds, 'event should have streamIds');
      assert.ok(event.streamIds.length > 0, 'event should have at least one streamId');

      // Non-system streamIds should contain the prefix
      for (const sid of event.streamIds) {
        const isSystemStream = sid.startsWith('.');
        if (!isSystemStream) {
          assert.ok(sid.includes(data.prefix),
            `streamId ${sid} should contain prefix ${data.prefix}`);
        }
      }
    });
  });

  describe('[DYN02] Data structure', function () {
    it('[DY10] must have same number of items as static data', function () {
      const staticData = helpers.data;
      const dynData = helpers.dynData();

      assert.strictEqual(dynData.users.length, staticData.users.length);
      assert.strictEqual(dynData.accesses.length, staticData.accesses.length);
      assert.strictEqual(dynData.streams.length, staticData.streams.length);
      assert.strictEqual(dynData.events.length, staticData.events.length);
    });

    it('[DY11] must provide attachments (unchanged from static)', function () {
      const dynData = helpers.dynData();

      assert.ok(dynData.attachments);
      assert.ok(dynData.attachments.document);
      assert.ok(dynData.attachments.image);
      assert.ok(dynData.attachments.text);
      assert.ok(dynData.testsAttachmentsDirPath);
    });

    it('[DY12] must provide helper functions', function () {
      const dynData = helpers.dynData();

      assert.ok(typeof dynData.addCorrectAttachmentIds === 'function');
      assert.ok(typeof dynData.flattenStreams === 'function');
      assert.ok(typeof dynData.cleanup === 'function');
    });
  });

  describe('[DYN03] Reset functions', function () {
    let dynData;
    let username;

    before(function () {
      dynData = helpers.dynData();
      username = dynData.users[0].username;
    });

    after(async function () {
      // Cleanup
      await dynData.cleanup();
    });

    it('[DY20] must reset users without error', async function () {
      await dynData.resetUsers();
      // Verify user exists by attempting to access their data
      // (successful if no error thrown)
    });

    it('[DY21] must reset accesses without error', async function () {
      await dynData.resetAccesses();
    });

    it('[DY22] must reset profile without error', async function () {
      await dynData.resetProfile();
    });

    it('[DY23] must reset streams without error', async function () {
      await dynData.resetStreams();
    });

    it('[DY24] must reset events without error', async function () {
      await dynData.resetEvents();
    });

    it('[DY25] must allow API access with dynamic user', async function () {
      // Reset the user and create an access
      await dynData.resetUsers();
      await dynData.resetAccesses();

      // Use a non-personal access (shared access doesn't need session)
      // accesses[1] is a shared access with read permissions
      const token = dynData.accesses[1].token;
      const res = await coreRequest
        .get('/' + username + '/access-info')
        .set('Authorization', token);

      assert.strictEqual(res.status, 200);
      assert.ok(res.body.type);
    });
  });

  describe('[DYN04] Parallel isolation', function () {
    it('[DY30] must allow two instances to operate independently', async function () {
      const data1 = helpers.dynData({ prefix: 'inst1' });
      const data2 = helpers.dynData({ prefix: 'inst2' });

      // Reset users for both
      await data1.resetUsers();
      await data2.resetUsers();

      // Reset accesses for both
      await data1.resetAccesses();
      await data2.resetAccesses();

      // Both should be able to authenticate independently
      // Use shared access (index 1) which doesn't need a session
      const res1 = await coreRequest
        .get('/' + data1.users[0].username + '/access-info')
        .set('Authorization', data1.accesses[1].token);

      const res2 = await coreRequest
        .get('/' + data2.users[0].username + '/access-info')
        .set('Authorization', data2.accesses[1].token);

      assert.strictEqual(res1.status, 200);
      assert.strictEqual(res2.status, 200);

      // Cleanup
      await data1.cleanup();
      await data2.cleanup();
    });
  });
});
