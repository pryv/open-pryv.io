/**
 * @license
 * Copyright (C) 2020–2023 Pryv S.A. https://pryv.com
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
 * Helper functions for serializing/deserializing setup instructions for tests.
 * Added to support injecting mocks in server instance (separate process) from
 * tests.
 */
module.exports = {
  set,
  clear,
  execute
};

const logger = require('@pryv/boiler').getLogger('instance-test-setup');

/**
 * @param {Object} settings The main configuration settings
 * @param {Object} setup Must have method `execute()` and be self-contained (i.e. no reference
 *                       to outside scope, except for possible module dependencies e.g. mocking
 *                       lib which must then be declared in the current module's package).
 *                       Possible context must be passed via property `context`.
 *                       A `messagingSocket` property will be injected into `context` at execution
 *                       time to allow passing messages back to the test process.
 */
function set (settings, setup) {
  if (!settings || !setup) {
    throw new Error('Expected config and setup object arguments');
  }
  settings.instanceTestSetup = stringify(setup);
}

function clear (settings) {
  delete settings.instanceTestSetup;
}

/**
 * @throws Any error encountered deserializing or calling the setup function
 */
function execute (testSetup, testNotifier) {
  const obj = parse(testSetup);
  if (obj.context != null) {
    // inject TCP axonMessaging socket to allow passing data back to test process
    obj.context.testNotifier = testNotifier;
  }
  try {
    const result = obj.execute();
    logger.debug('executeResult', result);
  } catch (error) {
    logger.error('executeResult Error', error);
    throw error;
  }
}

/**
 * @returns {string}
 */
function stringify (obj) {
  return JSON.stringify(obj, function (key, value) {
    // stringify functions with their source, converting CRLF.
    //
    // NOTE If you strip CRLF here, any comment in the serialized function will
    // comment out the rest of the line.
    //
    return typeof value === 'function'
      ? value.toString().replace(/\r?\n|\n/g, '\n')
      : value;
  });
}

/**
 * @returns {any}
 */
function parse (str) {
  try {
    return JSON.parse(str, function (key, value) {
      logger.debug('eval', value);
      if (typeof value !== 'string') {
        return value;
      }
      // eslint-disable-next-line no-eval
      const evalValue = value.substring(0, 8) === 'function' ? eval('(' + value + ')') : value;
      logger.debug('evalValue', value);
      return evalValue;
    });
  } catch (e) {
    logger.debug('Failed parsing string:', str);
    throw e;
  }
}
