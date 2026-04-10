/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */

/**
 * SeriesConnection interface.
 * Both InfluxConnection and PGSeriesConnection must implement these methods.
 */

const REQUIRED_METHODS = [
  'createDatabase',
  'dropDatabase',
  'writeMeasurement',
  'dropMeasurement',
  'writePoints',
  'query',
  'getDatabases'
];

/**
 * Validate that an instance implements all required SeriesConnection methods.
 * @param {Object} instance
 * @returns {Object} The instance itself
 */
function validateSeriesConnection (instance) {
  for (const method of REQUIRED_METHODS) {
    if (typeof instance[method] !== 'function') {
      throw new Error(`SeriesConnection implementation missing method: ${method}`);
    }
  }
  return instance;
}

module.exports = { validateSeriesConnection, REQUIRED_METHODS };
