/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */

import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);

const { getConfigSync } = require('@pryv/boiler');

let defaultApiFormat: any;
/**
 * @param [apiFormat] - (default the one of config "service:api") https://{username}.domain/ or https://hostname/{username}/
 */
function build (username: any, token: any, apiFormat: any) {
  if (!defaultApiFormat) { defaultApiFormat = getConfigSync().get('service:api'); }
  apiFormat = apiFormat || defaultApiFormat;
  let apiEndpoint = apiFormat.replace('{username}', username);
  if (token) {
    const endpointElements = apiEndpoint.split('//');
    endpointElements[1] = `${token}@${endpointElements[1]}`;
    apiEndpoint = endpointElements.join('//');
  }
  return apiEndpoint;
}

export { build };
