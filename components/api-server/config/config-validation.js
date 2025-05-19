/**
 * @license
 * Copyright (C) 2020–2025 Pryv S.A. https://pryv.com
 *
 * This file is part of Open-Pryv.io and released under BSD-Clause-3 License
 *
 * Redistribution and use in source and binary forms, with or without
 * modification, are permitted provided that the following conditions are met:
 *
 * 1. Redistributions of source code must retain the above copyright notice,
 *   this list of conditions and the following disclaimer.
 *
 * 2. Redistributions in binary form must reproduce the above copyright notice,
 *   this list of conditions and the following disclaimer in the documentation
 *   and/or other materials provided with the distribution.
 *
 * 3. Neither the name of the copyright holder nor the names of its contributors
 *   may be used to endorse or promote products derived from this software
 *   without specific prior written permission.
 *
 * THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS "AS IS"
 * AND ANY EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT LIMITED TO, THE
 * IMPLIED WARRANTIES OF MERCHANTABILITY AND FITNESS FOR A PARTICULAR PURPOSE ARE
 * DISCLAIMED. IN NO EVENT SHALL THE COPYRIGHT HOLDER OR CONTRIBUTORS BE LIABLE
 * FOR ANY DIRECT, INDIRECT, INCIDENTAL, SPECIAL, EXEMPLARY, OR CONSEQUENTIAL
 * DAMAGES (INCLUDING, BUT NOT LIMITED TO, PROCUREMENT OF SUBSTITUTE GOODS OR
 * SERVICES; LOSS OF USE, DATA, OR PROFITS; OR BUSINESS INTERRUPTION) HOWEVER
 * CAUSED AND ON ANY THEORY OF LIABILITY, WHETHER IN CONTRACT, STRICT LIABILITY,
 * OR TORT (INCLUDING NEGLIGENCE OR OTHERWISE) ARISING IN ANY WAY OUT OF THE USE
 * OF THIS SOFTWARE, EVEN IF ADVISED OF THE POSSIBILITY OF SUCH DAMAGE.
 *
 * SPDX-License-Identifier: BSD-3-Clause
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
