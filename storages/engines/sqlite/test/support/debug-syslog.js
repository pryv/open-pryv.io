/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */

import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
require('test-helpers/src/api-server-tests-config.ts');
const { getConfig } = require('@pryv/boiler');

const syslogWatch = require('./SyslogWatch').default;
const { getSyslog } = require('audit/src/syslog/index.ts');

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
