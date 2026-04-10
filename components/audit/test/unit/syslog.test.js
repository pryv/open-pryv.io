/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */
/* global assert, cuid, config, initTests, audit, _ */
const os = require('os');

const SyslogWatch = require('storages/engines/sqlite/test/support/SyslogWatch');

describe('[SYSL] Syslog', function () {
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

  describe('[SY01] receive message and write them to syslog', () => {
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
          assert.ok(err == null);
          assert.ok(res.includes(logString));
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
          assert.ok(err == null);
          assert.ok(res.includes(logString));
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
          assert.ok(err == null);
          assert.ok(res.includes(logString));
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
          assert.ok(err != null);
          assert.strictEqual(err.message, 'Not Found');
          done();
        });
    });
  });
});
