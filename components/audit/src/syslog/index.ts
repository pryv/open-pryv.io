/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */
import type {} from 'node:fs';

const Syslog = require('./Syslog');
const { getConfig } = require('@pryv/boiler');

let syslog;

/**
 *@returns {Syslog|null}
 */
async function getSyslog () {
  if (!syslog) {
    const config = await getConfig();
    if (config.get('audit:syslog:active') === false) return null;
    syslog = new Syslog();
    await syslog.init();
  }
  return syslog;
}

module.exports = {
  getSyslog
};
