/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */
const _internals = require('../_internals');
const defaultOptions = {
  readPreference: 'primary',
  readConcern: { level: 'local' },
  writeConcern: { w: 'majority' }
};
/**
 * Per-user events data
 */
class LocalTransaction {
  transactionSession;

  transactionOptions;
  constructor (transactionOptions) {
    this.transactionOptions = transactionOptions || defaultOptions;
  }

  /**
   * @returns {Promise<void>}
   */
  async init () {
    this.transactionSession = await _internals.database.startSession();
  }

  /**
   *
   * @param {Function} func  undefined
   * @returns {Promise<void>}
   */
  async exec (func) {
    await this.transactionSession.withTransaction(func, this.transactionOptions);
  }
}
module.exports = LocalTransaction;
