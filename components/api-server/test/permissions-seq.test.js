/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */

/**
 * Access permissions - sequential tests
 * Only contains AP04 (custom auth step) which requires file I/O + server.restart.
 * AP01, AP02, and YE49 moved to permissions.test.js (Pattern C, parallel-safe).
 */

const async = require('async');
const fs = require('fs');
const path = require('path');
const assert = require('node:assert');

require('./test-helpers');
const helpers = require('./helpers');
const server = helpers.dependencies.instanceManager;
const validation = helpers.validation;
const testData = helpers.dynData({ prefix: 'perm' });

describe('[ACCP] Access permissions (sequential)', function () {
  const user = structuredClone(testData.users[0]);
  let request = null;

  function token (testAccessIndex) {
    return testData.accesses[testAccessIndex].token;
  }

  before(function (done) {
    async.series([
      testData.resetUsers,
      testData.resetAccesses,
      testData.resetStreams,
      server.ensureStarted.bind(server, helpers.dependencies.settings),
      function (stepDone) { request = helpers.request(server.url); stepDone(); }
    ], done);
  });

  after(async function () {
    await testData.cleanup();
  });

  describe('[AP03] Auth and change tracking', function () {
    beforeEach(testData.resetEvents);

    const basePath = '/' + user.username + '/events';
    const sharedAccessIndex = 1;
    const callerId = 'test-caller-id';
    const auth = token(sharedAccessIndex) + ' ' + callerId;
    const newEventData = {
      type: 'test/test',
      streamIds: [testData.streams[1].id]
    };

    describe('[AP04] custom auth step (e.g. to validate/parse caller id)', function () {
      const fileName = 'customAuthStepFn.js';
      const srcPath = path.join(__dirname, 'permissions.fixtures', fileName);
      const destPath = path.join(__dirname, '../../../custom-extensions', fileName);

      before(function (done) {
        async.series([
          function setupCustomAuthStep (stepDone) {
            fs.readFile(srcPath, function (err, data) {
              if (err) { return stepDone(err); }

              fs.writeFile(destPath, data, stepDone);
            });
          },
          server.restart.bind(server)
        ], function (err) {
          if (err) done(err);

          if (!fs.existsSync(destPath)) { throw new Error('Failed creating :' + destPath); }

          done();
        });
      });

      after(function (done) {
        async.series([
          function teardownCustomAuthStep (stepDone) {
            fs.unlink(destPath, stepDone);
          },
          server.restart.bind(server)
        ], done);
      });

      it('[IA9K] must be supported and deny access when failing', function (done) {
        request.post(basePath, auth).send(newEventData).end(function (res) {
          validation.checkErrorInvalidAccess(res, done);
        });
      });

      it('[H58R] must allow access when successful', function (done) {
        const successAuth = token(sharedAccessIndex) + ' Georges (unparsed)';
        request.post(basePath, successAuth).send(newEventData).end(function (res) {
          assert.strictEqual(res.statusCode, 201);
          const event = res.body.event;
          const expectedAuthor = testData.accesses[sharedAccessIndex].id + ' Georges (parsed)';
          assert.strictEqual(event.createdBy, expectedAuthor);
          assert.strictEqual(event.modifiedBy, expectedAuthor);
          done();
        });
      });

      it('[H58Z] must allow access whith "callerid" headers', function (done) {
        const successAuth = token(sharedAccessIndex);
        request.post(basePath, successAuth)
          .set('callerid', 'Georges (unparsed)')
          .send(newEventData).end(function (err, res) {
            assert.ok(err == null);
            assert.strictEqual(res.statusCode, 201);
            const event = res.body.event;
            const expectedAuthor = testData.accesses[sharedAccessIndex].id + ' Georges (parsed)';
            assert.strictEqual(event.createdBy, expectedAuthor);
            assert.strictEqual(event.modifiedBy, expectedAuthor);
            done();
          });
      });

      it('[ISE4] must fail properly (i.e. not granting access) when the custom function crashes', function (done) {
        const crashAuth = token(sharedAccessIndex) + ' Please Crash';
        request.post(basePath, crashAuth).send(newEventData).end(function (res) {
          assert.strictEqual(res.statusCode, 500);
          done();
        });
      });

      it('[P4OM] must validate the custom function at startup time', async () => {
        const srcPath = path.join(__dirname, 'permissions.fixtures', 'customAuthStepFn.invalid.js');
        fs.writeFileSync(destPath, fs.readFileSync(srcPath)); // Copy content of srcPath file to destPath
        try {
          await server.restartAsync();
        } catch (error) {
          assert.ok(error != null);
          assert.ok(error.message != null);
          assert.ok(/Server failed/.test(error.message));
        }
      });
    });
  });
});
