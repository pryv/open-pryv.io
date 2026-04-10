/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */

const bluebird = require('bluebird');

/**
 * Per-user and system-wide integrity verification.
 * Recomputes hashes on events and accesses and compares against stored values.
 */
class IntegrityCheck {
  constructor () {
    this.storageLayer = null;
    this.integrity = null;
    this.logger = null;
  }

  async init () {
    const { getStorageLayer } = require('storage');
    this.storageLayer = await getStorageLayer();
    this.integrity = require('business/src/integrity');
    const { getLogger } = require('@pryv/boiler');
    this.logger = getLogger('integrity-check');
    return this;
  }

  /**
   * Run integrity check on a single user.
   * @param {string} userId
   * @returns {Promise<IntegrityReport>}
   */
  async checkUser (userId) {
    const report = {
      userId,
      events: { checked: 0, errors: [] },
      accesses: { checked: 0, errors: [] },
      ok: true
    };

    if (this.integrity.events.isActive) {
      await this._checkUserEvents(userId, report);
    }

    if (this.integrity.accesses.isActive) {
      await this._checkUserAccesses(userId, report);
    }

    report.ok = report.events.errors.length === 0 && report.accesses.errors.length === 0;
    return report;
  }

  /**
   * Run integrity check on all users.
   * @param {Function} [onUserComplete] - callback(userId, report) after each user
   * @returns {Promise<IntegrityReport[]>}
   */
  async checkAllUsers (onUserComplete) {
    const { getUsersLocalIndex } = require('storage');
    const usersIndex = await getUsersLocalIndex();
    const allUsers = await usersIndex.getAllByUsername();
    const reports = [];

    for (const [username, userId] of Object.entries(allUsers)) {
      this.logger.info(`Checking integrity for user: ${username} (${userId})`);
      const report = await this.checkUser(userId);
      report.username = username;
      reports.push(report);
      if (onUserComplete) onUserComplete(userId, report);
    }

    return reports;
  }

  // -------------------------------------------------------------------------
  // Events
  // -------------------------------------------------------------------------

  async _checkUserEvents (userId, report) {
    const storages = require('storages');
    const database = storages.database || storages.databasePG;
    if (!database) return;

    let events;
    if (storages.database) {
      events = await bluebird.fromCallback((cb) =>
        database.find({ name: 'events' }, { userId }, {}, cb)
      );
    } else {
      // PostgreSQL path
      events = await database.query(
        'SELECT * FROM events WHERE user_id = $1',
        [userId]
      );
    }

    if (!events) return;

    for (const event of events) {
      // Normalize _id -> id for MongoDB raw docs
      if (event._id != null && event.id == null) {
        event.id = typeof event._id === 'object' ? event._id.toString() : event._id;
      }

      // Skip history entries without integrity
      if (event.headId != null) {
        if (!event.integrity) continue;
        // For integrity computation, history uses headId as id
        const originalId = event.id;
        event.id = event.headId;
        delete event.headId;
        report.events.checked++;
        this._verifyEventIntegrity(event, report, originalId);
        continue;
      }

      report.events.checked++;
      this._verifyEventIntegrity(event, report);
    }
  }

  _verifyEventIntegrity (event, report, originalId) {
    if (event.integrity === undefined) {
      report.events.errors.push({
        eventId: originalId || event.id,
        error: 'missing integrity property'
      });
      return;
    }

    // Strip internal fields before computing
    const clean = Object.assign({}, event);
    delete clean._id;
    delete clean.__v;
    delete clean.userId;
    delete clean.user_id;

    const computed = this.integrity.events.compute(clean);
    if (computed.integrity !== event.integrity) {
      report.events.errors.push({
        eventId: originalId || event.id,
        error: 'integrity mismatch',
        expected: computed.integrity,
        actual: event.integrity
      });
    }
  }

  // -------------------------------------------------------------------------
  // Accesses
  // -------------------------------------------------------------------------

  async _checkUserAccesses (userId, report) {
    const user = { id: userId };
    const accesses = await bluebird.fromCallback((cb) =>
      this.storageLayer.accesses.exportAll(user, cb)
    );

    if (!accesses) return;

    for (const access of accesses) {
      // Normalize _id -> id for MongoDB raw docs
      if (access._id != null && access.id == null) {
        access.id = typeof access._id === 'object' ? access._id.toString() : access._id;
      }

      report.accesses.checked++;

      if (access.integrity === undefined) {
        report.accesses.errors.push({
          accessId: access.id,
          error: 'missing integrity property'
        });
        continue;
      }

      const clean = Object.assign({}, access);
      delete clean._id;
      delete clean.__v;
      delete clean.userId;
      delete clean.user_id;

      const computed = this.integrity.accesses.compute(clean);
      if (computed.integrity !== access.integrity) {
        report.accesses.errors.push({
          accessId: access.id,
          error: 'integrity mismatch',
          expected: computed.integrity,
          actual: access.integrity
        });
      }
    }
  }
}

module.exports = IntegrityCheck;

/**
 * @typedef {Object} IntegrityReport
 * @property {string} userId
 * @property {string} [username]
 * @property {boolean} ok
 * @property {{checked: number, errors: Array}} events
 * @property {{checked: number, errors: Array}} accesses
 */
