/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
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
    // inject test notifier to allow passing data back to test process via IPC
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
