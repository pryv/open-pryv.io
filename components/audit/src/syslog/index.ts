/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);

const Syslog = require('./Syslog').default;
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

export { getSyslog };
