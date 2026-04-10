/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */
require('test-helpers/src/api-server-tests-config');
const { getConfig } = require('@pryv/boiler');

const syslogWatch = require('./SyslogWatch');
const { getSyslog } = require('audit/src/syslog');

function lookFor (str) {
  syslogWatch(str)(
    function read () {
      console.log('Ready');
    }, function (err) {
      console.log('done', err);
    });
}

(async () => {
  await getConfig();
  const syslog = await getSyslog();
  lookFor('toto');
  syslog.syslogger.log('info', 'toto');
})();
