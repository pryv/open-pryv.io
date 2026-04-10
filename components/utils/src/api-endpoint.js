/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */
const { getConfigUnsafe } = require('@pryv/boiler');

let defaultApiFormat;
/**
 * @param {string} username
 * @param {string} token
 * @param {string} [apiFormat] - (default the one of config "service:api") https://{username}.domain/ or https://hostname/{username}/
 */
function build (username, token, apiFormat) {
  if (!defaultApiFormat) { defaultApiFormat = getConfigUnsafe().get('service:api'); }
  apiFormat = apiFormat || defaultApiFormat;
  let apiEndpoint = apiFormat.replace('{username}', username);
  if (token) {
    const endpointElements = apiEndpoint.split('//');
    endpointElements[1] = `${token}@${endpointElements[1]}`;
    apiEndpoint = endpointElements.join('//');
  }
  return apiEndpoint;
}

module.exports = {
  build
};
