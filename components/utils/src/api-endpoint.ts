/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */

import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);

const { getConfigSync } = require('@pryv/boiler');

let defaultApiFormat: string | undefined;
/**
 * @param [apiFormat] - (default the one of config "service:api") https://{username}.domain/ or https://hostname/{username}/
 */
function build (username: string, token: string | undefined, apiFormat?: string) {
  if (!defaultApiFormat) { defaultApiFormat = getConfigSync().get('service:api'); }
  apiFormat = apiFormat || defaultApiFormat;
  let apiEndpoint = apiFormat!.replace('{username}', username);
  if (token) {
    const endpointElements = apiEndpoint.split('//');
    endpointElements[1] = `${token}@${endpointElements[1]}`;
    apiEndpoint = endpointElements.join('//');
  }
  return apiEndpoint;
}

export { build };
