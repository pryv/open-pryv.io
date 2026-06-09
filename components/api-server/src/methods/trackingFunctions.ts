/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const updateAccessUsageStats = require('./helpers/updateAccessUsageStats.ts').default;
const { ready } = require('@pryv/boiler');

/**
 * Call tracking functions, to be registered after all methods have been registered.
 *
 */
export default async function (api: { register: (...args: unknown[]) => void }) {
  const config = await ready();
  if (!config.get('accessTracking:isActive')) { return; }
  const updateAccessUsage = await updateAccessUsageStats();
  api.register('*', updateAccessUsage);
};
