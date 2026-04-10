/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */

const updateAccessUsageStats = require('./helpers/updateAccessUsageStats');
const { getConfig } = require('@pryv/boiler');

/**
 * Call tracking functions, to be registered after all methods have been registered.
 *
 * @param api
 */
module.exports = async function (api) {
  const config = await getConfig();
  if (!config.get('accessTracking:isActive')) { return; }
  const updateAccessUsage = await updateAccessUsageStats();
  api.register('*', updateAccessUsage);
};
