/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */
'use strict';
const morgan = require('morgan');
const { getLogger } = require('@pryv/boiler');
module.exports = function (express) {
  const logger = getLogger('request-trace');
  const morganLoggerStreamWrite = (msg) => logger.info(msg);
  return morgan('combined', {
    stream: {
      write: morganLoggerStreamWrite
    }
  });
};
