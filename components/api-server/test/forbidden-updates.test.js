/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */

const commonFns = require('../src/methods/helpers/commonFunctions');
const streamSchema = require('../src/schema/stream');
const eventsSchema = require('../src/schema/event');
const accessesSchema = require('../src/schema/access');
const assert = require('node:assert');
const async = require('async');

describe('[FRBD] methods/helpers/commonFunctions.js: catchForbiddenUpdate(schema)', function () {
  describe('[FB01] with streams schema', function () {
    const protectedFields = ['id', 'children', 'created', 'createdBy', 'modified', 'modifiedBy'];

    it('[DMGV] must throw a forbidden error if "ignoreProtectedFieldUpdates" is null', function (done) {
      testForbiddenUpdate(streamSchema, protectedFields, null, done);
    });

    it('[Z51K] must throw a forbidden error if "ignoreProtectedFieldUpdates" is false', function (done) {
      testForbiddenUpdate(streamSchema, protectedFields, false, done);
    });

    it('[EUKL] must not throw any error if "ignoreProtectedFieldUpdates" is true but print a warn log', function (done) {
      testForbiddenUpdate(streamSchema, protectedFields, true, done);
    });
  });

  describe('[FB02] with events schema', function () {
    const protectedFields = ['id', 'attachments', 'created', 'createdBy', 'modified', 'modifiedBy'];

    it('[0RQM] must throw a forbidden error if "ignoreProtectedFieldUpdates" is null', function (done) {
      testForbiddenUpdate(eventsSchema, protectedFields, null, done);
    });

    it('[6TK9] must throw a forbidden error if "ignoreProtectedFieldUpdates" is false', function (done) {
      testForbiddenUpdate(eventsSchema, protectedFields, false, done);
    });

    it('[IJ4M] must not throw any error if "ignoreProtectedFieldUpdates" is true but print a warn log', function (done) {
      testForbiddenUpdate(eventsSchema, protectedFields, true, done);
    });
  });

  describe('[FB03] with accesses schema', function () {
    const protectedFields = ['id', 'token', 'type', 'lastUsed', 'created', 'createdBy', 'modified', 'modifiedBy'];

    it('[GP6C] must throw a forbidden error if "ignoreProtectedFieldUpdates" is null', function (done) {
      testForbiddenUpdate(accessesSchema, protectedFields, null, done);
    });

    it('[MUC0] must throw a forbidden error if "ignoreProtectedFieldUpdates" is false', function (done) {
      testForbiddenUpdate(accessesSchema, protectedFields, false, done);
    });

    it('[QGDA] must not throw any error if "ignoreProtectedFieldUpdates" is true but print a warn log', function (done) {
      testForbiddenUpdate(accessesSchema, protectedFields, true, done);
    });
  });

  function testForbiddenUpdate (schema, protectedFields, ignoreProtectedFieldUpdates, done) {
    async.eachSeries(
      protectedFields,
      function testForbiddenUpdateForEachField (protectedField, stepDone) {
        // Here we fake a logger to test that a warning is logged in non-strict mode
        let warningLogged = false;
        const logger = {
          warn: function (msg) {
            assert.strictEqual(ignoreProtectedFieldUpdates, true);
            assert.ok(msg.indexOf('Forbidden update was attempted on the following protected field(s)') >= 0);
            assert.ok(msg.indexOf('Server has "ignoreProtectedFieldUpdates" turned on: Fields are not updated, but no error is thrown.') >= 0);
            assert.ok(msg.indexOf(protectedField) >= 0);

            warningLogged = true;
          }
        };
        const catchForbiddenUpdate = commonFns.catchForbiddenUpdate(schema('update'), ignoreProtectedFieldUpdates, logger);
        const forbiddenUpdate = { update: {} };
        forbiddenUpdate.update[protectedField] = 'forbidden';
        catchForbiddenUpdate(null, forbiddenUpdate, null, function (err) {
          // Strict mode: we expect a forbidden error
          if (!ignoreProtectedFieldUpdates) {
            assert.ok(err != null);
            assert.strictEqual(err.id, 'forbidden');
            assert.strictEqual(err.httpStatus, 403);
            stepDone();
          } else { // Non-strict mode: we do not expect an error but a warning log
            if (err != null) return stepDone(err);

            // From here we expect a warning log to be triggered (see logger above).
            // We throw an explicit error if this is not the case
            assert.strictEqual(warningLogged, true, 'Warning was not logged.');

            return stepDone();
          }
        });
      },
      done
    );
  }
});
