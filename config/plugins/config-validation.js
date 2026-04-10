/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */

/**
 * Plugin to run at the end of the config loading.
 * Should validate (or not) the configuration and display appropriate messages
 */

const { getLogger } = require('@pryv/boiler');
let logger; // initalized at load();

async function validate (config) {
  // check for incomplete settings
  checkIncompleteFields(config.get(), false, []);

  /**
   * Parse all string fields and fail if "REPLACE" is found
   * stops if an "active: false" field is found in path
   * @param {*} obj The object to inspect
   * @param {Array<string>|false} finalPath is !== false the path to access the value (set when passing thru first Array)
   * @param {Array<string} parentPath path to display in case of error. If in array the index of the array is happened to the path
   * @param {string} key the key to construct the path
   */
  function checkIncompleteFields (obj, finalPath, parentPath, key) {
    const path = key ? parentPath.concat(key) : parentPath;
    if (typeof obj === 'undefined' || obj === null) return;
    if (typeof obj === 'string') {
      if (obj.includes('REPLACE')) {
        // get source info
        const queryPath = finalPath || parentPath;
        const res = config.getScopeAndValue(queryPath.join(':'));
        failWith('field content should be replaced', path, res);
      }
    }
    if (typeof obj === 'object') {
      if (obj.active && !obj.active) return; // skip non active fields
      if (Array.isArray(obj)) {
        for (let i = 0; i < obj.length; i++) {
          checkIncompleteFields(obj[i], finalPath || parentPath, path, i);
        }
      } else {
        for (const k of Object.keys(obj)) {
          checkIncompleteFields(obj[k], finalPath, path, k);
        }
      }
    }
  }
}

/**
 * Throw an error with the necessary information
 * @param {string} message
 * @param {Array<string>}
 * @param {*} payload
 */
function failWith (message, path, payload) {
  path = path || [];
  const error = new Error('Configuration is invalid at [' + path.join(':') + '] ' + message);
  error.payload = payload;
  throw (error);
}

module.exports = {
  load: async function (store) {
    logger = getLogger('validate-config');
    try {
      await validate(store);
    } catch (e) {
      logger.error(e.message, e.payload);
      process.exit(1);
    }
  }
};
