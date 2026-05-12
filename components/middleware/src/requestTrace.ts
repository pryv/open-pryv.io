/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);

const morgan = require('morgan');
const { getLogger } = require('@pryv/boiler');
export default function (express: any) {
  const logger = getLogger('request-trace');
  const morganLoggerStreamWrite = (msg: any) => logger.info(msg);
  return morgan('combined', {
    stream: {
      write: morganLoggerStreamWrite
    }
  });
};
