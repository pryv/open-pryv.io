/**
 * @license
 * Copyright (C) 2020–2025 Pryv S.A. https://pryv.com
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

const commonFns = require('../src/methods/helpers/commonFunctions');
const streamSchema = require('../src/schema/stream');
const eventsSchema = require('../src/schema/event');
const accessesSchema = require('../src/schema/access');
const should = require('should');
const async = require('async');

const chai = require('chai');
const assert = chai.assert;

describe('methods/helpers/commonFunctions.js: catchForbiddenUpdate(schema)', function () {
  describe('with streams schema', function () {
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

  describe('with events schema', function () {
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

  describe('with accesses schema', function () {
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
            should(ignoreProtectedFieldUpdates).be.true();
            should(msg.indexOf('Forbidden update was attempted on the following protected field(s)') >= 0).be.true();
            should(msg.indexOf('Server has "ignoreProtectedFieldUpdates" turned on: Fields are not updated, but no error is thrown.') >= 0).be.true();
            should(msg.indexOf(protectedField) >= 0).be.true();

            warningLogged = true;
          }
        };
        const catchForbiddenUpdate = commonFns.catchForbiddenUpdate(schema('update'), ignoreProtectedFieldUpdates, logger);
        const forbiddenUpdate = { update: {} };
        forbiddenUpdate.update[protectedField] = 'forbidden';
        catchForbiddenUpdate(null, forbiddenUpdate, null, function (err) {
          // Strict mode: we expect a forbidden error
          if (!ignoreProtectedFieldUpdates) {
            should.exist(err);
            should(err.id).be.equal('forbidden');
            should(err.httpStatus).be.equal(403);
            stepDone();
          } else { // Non-strict mode: we do not expect an error but a warning log
            if (err != null) return stepDone(err);

            // From here we expect a warning log to be triggered (see logger above).
            // We throw an explicit error if this is not the case
            assert.isTrue(warningLogged, 'Warning was not logged.');

            return stepDone();
          }
        });
      },
      done
    );
  }
});
