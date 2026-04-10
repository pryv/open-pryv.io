/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */
const { getLogger } = require('@pryv/boiler');

/**
 * v1.9.3:
 * - nothing to do
 */
module.exports = async function (context, callback) {
  const logger = getLogger('migration-1.9.3');
  logger.info('V1.9.2 => v1.9.3 Migration started');
  logger.info('V1.9.2 => v1.9.3 Migration finished');
  callback();
};
