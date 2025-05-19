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
/* global assert, cuid, config, initTests, audit, _ */
const os = require('os');

const SyslogWatch = require('storage/test/userSQLite/support/SyslogWatch');

describe('Syslog', function () {
  const userId = cuid();
  const createdBy = cuid();
  let syslogWatch;

  if (os.type() === 'Darwin') {
    console.log('** to fix - sylog monitoring not working anymore on OSX **');
    return;
  }

  before(async () => {
    await initTests();
    syslogWatch = new SyslogWatch(config.get('audit:syslog:options:app_name'));
  });

  async function send (event) {
    const e = _.merge({
      type: 'log/test',
      createdBy,
      streamIds: [':_audit:test'],
      content: {
        action: 'events.get',
        message: 'hello'
      }
    }, event);

    await audit.eventForUser(userId, e);
    return e;
  }

  describe('receive message and write them to syslog', () => {
    it('[F8SH] default message', function (done) {
      this.timeout(5000);
      const randomString = cuid();

      const logString = userId +
      ' log/unknown createdBy:' + createdBy +
      ' [":_audit:test"] ' + JSON.stringify({ action: 'events.get', message: randomString });

      syslogWatch(
        function () { // syslog Watch is ready
          send({ type: 'log/unknown', content: { message: randomString } });
        },
        function (err, res) { // string found or err
          assert.notExists(err);
          assert.include(res, logString);
          done(err);
        });
    });

    it('[9S6A] templated message', function (done) {
      this.timeout(5000);
      const randomString = cuid();

      const logString = userId +
      ' log/test createdBy:' + createdBy +
      ' streamIds:[":_audit:test"] ' + randomString;

      syslogWatch(
        function () { // syslog Watch is ready
          send({ content: { message: randomString } });
        },
        function (err, res) { // string found or err
          assert.notExists(err);
          assert.include(res, logString);
          done();
        });
    });

    it('[0PA7] plugin filtered message', function (done) {
      this.timeout(5000);
      const randomString = cuid();

      const logString = userId + ' TEST FILTERED ' + randomString;

      syslogWatch(
        function () { // syslog Watch is ready
          send({ type: 'log/test-filtered', content: { message: randomString } });
        },
        function (err, res) { // string found or err
          assert.notExists(err);
          assert.include(res, logString);
          done();
        });
    });

    it('[1D5S] plugin filtered message (SKIP)', function (done) {
      this.timeout(10000);
      const randomString = cuid();

      syslogWatch(
        function () { // syslog Watch is ready
          send({ type: 'log/test-filtered', content: { skip: true, message: randomString } });
        },
        function (err, res) { // string found or err
          assert.exists(err);
          assert.equal(err.message, 'Not Found');
          done();
        });
    });
  });
});
