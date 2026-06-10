/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);

const Syslog = require('./Syslog.ts').default;
const { getConfig } = require('@pryv/boiler');

import type SyslogType from './Syslog.ts';

let syslog: SyslogType | undefined;

async function getSyslog () {
  if (!syslog) {
    const config = await getConfig();
    if (config.get('audit:syslog:active') === false) return null;
    const newSyslog: SyslogType = new Syslog();
    syslog = newSyslog;
    await newSyslog.init();
  }
  return syslog;
}

export { getSyslog };
