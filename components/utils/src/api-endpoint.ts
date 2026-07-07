/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */

import { getConfigSync } from '@pryv/boiler';

let defaultApiFormat: string | undefined;
/**
 * @param [apiFormat] - (default the one of config "service:api") https://{username}.domain/ or https://hostname/{username}/
 */
function build (username: string, token: string | undefined, apiFormat?: string) {
  if (!defaultApiFormat) { defaultApiFormat = getConfigSync().get('service:api') as string; }
  apiFormat = apiFormat || defaultApiFormat;
  let apiEndpoint = apiFormat!.replace('{username}', username);
  if (token) {
    const endpointElements = apiEndpoint.split('//');
    endpointElements[1] = `${token}@${endpointElements[1]}`;
    apiEndpoint = endpointElements.join('//');
  }
  return apiEndpoint;
}

/**
 * Build the API endpoint a client should use for a given access: prefer the
 * access alias (de-identifying / changed-username demotion) over the real
 * username, so the real username never leaks for aliased accesses.
 */
function buildForAccess (access: { alias?: string | null; token?: string }, username: string, apiFormat?: string) {
  return build((access && access.alias) || username, access != null ? access.token : undefined, apiFormat);
}

export { build, buildForAccess };
