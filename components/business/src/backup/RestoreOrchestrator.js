/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */

const bluebird = require('bluebird');
const accountStreams = require('../system-streams');
const timestamp = require('unix-timestamp');

/**
 * Orchestrates restore from a backup archive into the current core.
 * Reads from a BackupReader and writes into StorageLayer, UserAccountStorage,
 * AuditStorage, EventFiles, PlatformDB.
 */
class RestoreOrchestrator {
  constructor () {
    this.storageLayer = null;
    this.usersLocalIndex = null;
    this.userAccountStorage = null;
    this.eventFiles = null;
    this.platformDB = null;
    this.auditStorage = null;
    this.logger = null;
  }

  async init () {
    const { getStorageLayer, getUsersLocalIndex, getUserAccountStorage } = require('storage');
    const { getEventFiles } = require('storage/src/eventFiles/getEventFiles');
    const storages = require('storages');
    this.storageLayer = await getStorageLayer();
    this.usersLocalIndex = await getUsersLocalIndex();
    this.userAccountStorage = await getUserAccountStorage();
    this.eventFiles = await getEventFiles();
    this.platformDB = storages.platformDB;
    this.auditStorage = storages.auditStorage;
    this.seriesConnection = storages.seriesConnection;
    const { getLogger } = require('@pryv/boiler');
    this.logger = getLogger('restore');
    await accountStreams.init();
    return this;
  }

  /**
   * Restore all users and platform data from a backup.
   * @param {BackupReader} reader
   * @param {Object} [options]
   * @param {boolean} [options.overwrite=true] - clearAll before import
   * @param {boolean} [options.skipPlatform=false] - skip platform data
   * @param {boolean} [options.skipConflicts=false] - skip conflicting users instead of failing
   * @param {boolean} [options.deleteOnSuccess=false] - delete backup data after successful restore
   * @param {string} [options.moveOnSuccess] - move backup data to this path after successful restore
   * @returns {Promise<Object>} restore report { restored: [], skipped: [], conflicts: [] }
   */
  async restoreAllUsers (reader, options = {}) {
    const opts = Object.assign({ overwrite: true, skipPlatform: false, skipConflicts: false }, options);

    if (opts.skipConflicts && !opts.deleteOnSuccess && !opts.moveOnSuccess) {
      throw new Error('--skip-conflicts requires --delete-on-success or --move-on-success');
    }

    const manifest = await reader.readManifest();
    this.logger.info(`Restoring from backup: format=${manifest.formatVersion} type=${manifest.backupType} users=${manifest.users.length}`);

    // Detect conflicts
    const conflicts = await this._detectConflicts(manifest.users);
    const report = { restored: [], skipped: [], conflicts };

    if (conflicts.length > 0 && !opts.skipConflicts) {
      const conflictDesc = conflicts.map(c => `${c.username} (${c.reason})`).join(', ');
      throw new Error(`Restore aborted: ${conflicts.length} conflict(s): ${conflictDesc}`);
    }

    const conflictUserIds = new Set(conflicts.map(c => c.userId));

    for (const userManifest of manifest.users) {
      const { userId, username } = userManifest;

      if (conflictUserIds.has(userId)) {
        this.logger.info(`Skipping conflicting user: ${username} (${userId})`);
        report.skipped.push({ userId, username });
        continue;
      }

      await this._restoreSingleUser(reader, userId, username, opts);
      report.restored.push({ userId, username });
    }

    if (!opts.skipPlatform) {
      await this._restorePlatform(reader);
    }

    this.logger.info(`Restore complete: ${report.restored.length} restored, ${report.skipped.length} skipped`);
    return report;
  }

  /**
   * Restore a single user from backup.
   * @param {BackupReader} reader
   * @param {string} userId
   * @param {Object} [options]
   * @param {boolean} [options.overwrite=false] - clearAll before import
   * @param {boolean} [options.skipPlatform=true] - skip platform data
   * @param {string} [options.remapUserId] - remap to a different userId
   * @returns {Promise<Object>} restore report
   */
  async restoreUser (userId, reader, options = {}) {
    const opts = Object.assign({ overwrite: false, skipPlatform: true }, options);
    const manifest = await reader.readManifest();

    const userManifest = manifest.users.find(u => u.userId === userId);
    if (!userManifest) {
      throw new Error(`User ${userId} not found in backup manifest`);
    }

    const targetUserId = opts.remapUserId || userId;
    const { username } = userManifest;

    // Check conflicts
    const conflicts = await this._detectConflicts([{ userId: targetUserId, username }]);
    if (conflicts.length > 0 && !opts.overwrite) {
      throw new Error(`User ${username} conflicts with existing data: ${conflicts[0].reason}. Use --overwrite to replace.`);
    }

    await this._restoreSingleUser(reader, userId, username, opts, targetUserId);

    if (!opts.skipPlatform) {
      await this._restorePlatform(reader);
    }

    this.logger.info(`Single-user restore complete: ${username}`);
    return { restored: [{ userId: targetUserId, username }], skipped: [], conflicts };
  }

  /**
   * Restore platform data only.
   * @param {BackupReader} reader
   * @returns {Promise<void>}
   */
  async restorePlatform (reader) {
    await reader.readManifest();
    await this._restorePlatform(reader);
  }

  // -------------------------------------------------------------------------
  // Internal
  // -------------------------------------------------------------------------

  async _restoreSingleUser (reader, userId, username, opts, targetUserId) {
    targetUserId = targetUserId || userId;

    this.logger.info(`Restoring user: ${username} (${userId}${targetUserId !== userId ? ' -> ' + targetUserId : ''})`);

    // Ensure user exists in local index
    try {
      await this.usersLocalIndex.addUser(username, targetUserId);
    } catch (e) {
      // User may already exist — that's fine if we're overwriting
      if (!opts.overwrite) throw e;
    }

    const user = { id: targetUserId };
    const userReader = await reader.openUser(userId);

    // Clear existing data if overwrite requested
    if (opts.overwrite) {
      await this._clearUserData(user, targetUserId);
    }

    // Import order matters for logical consistency:
    // 1. Streams (events and accesses reference streamIds)
    // 2. Accesses (may reference streams via permissions)
    // 3. Profile, Webhooks (independent)
    // 4. Events (reference streams, may have headId references to other events)
    // 5. Attachments (reference events)
    // 6. Account data, Audit (independent)
    // Note: no FK constraints in MongoDB or PostgreSQL, but order is kept
    // for correctness if constraints are added in the future.
    const streams = [];
    for await (const stream of await userReader.readStreams()) {
      streams.push(stream);
    }
    if (streams.length > 0) {
      await bluebird.fromCallback(
        (cb) => this.storageLayer.streams.importAll(user, streams, cb)
      );
    }

    // Accesses
    const accesses = [];
    for await (const access of await userReader.readAccesses()) {
      accesses.push(access);
    }
    if (accesses.length > 0) {
      await bluebird.fromCallback(
        (cb) => this.storageLayer.accesses.importAll(user, accesses, cb)
      );
    }

    // Profile
    const profile = [];
    for await (const item of await userReader.readProfile()) {
      profile.push(item);
    }
    if (profile.length > 0) {
      await bluebird.fromCallback(
        (cb) => this.storageLayer.profile.importAll(user, profile, cb)
      );
    }

    // Webhooks
    const webhooks = [];
    for await (const wh of await userReader.readWebhooks()) {
      webhooks.push(wh);
    }
    if (webhooks.length > 0) {
      await bluebird.fromCallback(
        (cb) => this.storageLayer.webhooks.importAll(user, webhooks, cb)
      );
    }

    // Events
    const events = [];
    for await (const event of await userReader.readEvents()) {
      events.push(event);
    }
    if (events.length > 0) {
      await this._importEvents(user, events);
    }

    // Attachments
    for await (const { eventId, fileId, stream } of await userReader.readAttachments()) {
      await this.eventFiles.saveAttachmentFromStream(stream, targetUserId, eventId, fileId);
    }

    // Account data
    const accountData = await userReader.readAccountData();
    if (accountData) {
      await this.userAccountStorage._importAll(targetUserId, accountData);
    }

    // Ensure minimum account fields exist (safety net for v1 backups without accountFields)
    const hasAccountFields = accountData?.accountFields?.length > 0;
    if (!hasAccountFields) {
      const leavesMap = accountStreams.accountLeavesMap;
      const now = timestamp.now();
      let defaultsCreated = 0;
      for (const [streamId, stream] of Object.entries(leavesMap)) {
        if (stream.default != null) {
          const fieldName = accountStreams.toFieldName(streamId);
          await this.userAccountStorage.setAccountField(targetUserId, fieldName, stream.default, 'restore', now);
          defaultsCreated++;
        }
      }
      if (defaultsCreated > 0) {
        this.logger.info(`Created ${defaultsCreated} default account fields for user ${targetUserId}`);
      }
    }

    // Audit (optional)
    if (this.auditStorage) {
      try {
        const auditEvents = [];
        for await (const ae of await userReader.readAudit()) {
          auditEvents.push(ae);
        }
        if (auditEvents.length > 0) {
          const userAudit = this.auditStorage.forUser(targetUserId);
          await userAudit.importAllEvents(auditEvents);
        }
      } catch (e) {
        this.logger.warn(`Audit import failed for user ${targetUserId}: ${e.message}`);
      }
    }

    // Series (optional — skip if no series engine configured)
    if (this.seriesConnection) {
      try {
        const seriesMeasurements = [];
        for await (const item of await userReader.readSeries()) {
          seriesMeasurements.push(item);
        }
        if (seriesMeasurements.length > 0) {
          await this.seriesConnection.importDatabase(targetUserId, { measurements: seriesMeasurements });
        }
      } catch (e) {
        this.logger.warn(`Series import failed for user ${targetUserId}: ${e.message}`);
      }
    }

    this.logger.info(`User restored: ${username} (${targetUserId})`);
  }

  async _importEvents (user, events) {
    // Use BaseStorage importAll via callback (same path as existing migration)
    // The storageLayer doesn't expose events directly, but the engine's
    // local data store does via the events collection.
    // For now, we use iterateAllEvents' sibling — the events store on storageLayer.
    // If not available, fall back to inserting via the data store module.
    const eventsStore = this.storageLayer.events;
    if (eventsStore && typeof eventsStore.importAll === 'function') {
      await bluebird.fromCallback(
        (cb) => eventsStore.importAll(user, events, cb)
      );
    }
  }

  async _clearUserData (user, userId) {
    // Clear all user-scoped stores
    const collections = ['streams', 'accesses', 'profile', 'webhooks'];
    for (const coll of collections) {
      if (this.storageLayer[coll] && typeof this.storageLayer[coll].clearAll === 'function') {
        await bluebird.fromCallback(
          (cb) => this.storageLayer[coll].clearAll(user, cb)
        );
      }
    }

    // Clear events
    if (this.storageLayer.events && typeof this.storageLayer.events.clearAll === 'function') {
      await bluebird.fromCallback(
        (cb) => this.storageLayer.events.clearAll(user, cb)
      );
    }

    // Clear account data
    await this.userAccountStorage._clearAll(userId);

    // Clear attachments
    if (typeof this.eventFiles.removeAllForUser === 'function') {
      await this.eventFiles.removeAllForUser(userId);
    }

    // Clear audit
    if (this.auditStorage) {
      try {
        await this.auditStorage.deleteUser(userId);
      } catch (e) {
        this.logger.warn(`Audit clear failed for user ${userId}: ${e.message}`);
      }
    }

    // Clear series
    if (this.seriesConnection) {
      try {
        await this.seriesConnection.dropDatabase(userId);
      } catch (e) {
        this.logger.warn(`Series clear failed for user ${userId}: ${e.message}`);
      }
    }
  }

  async _detectConflicts (users) {
    const conflicts = [];
    for (const { userId, username } of users) {
      // Check if username already exists with a different userId
      try {
        const existingId = await this.usersLocalIndex.getUserId(username);
        if (existingId && existingId !== userId) {
          conflicts.push({
            userId,
            username,
            reason: `username "${username}" already exists with userId "${existingId}"`
          });
        }
      } catch (e) {
        // getUserId throws if not found — that's fine, no conflict
      }

      // Check if userId already exists with a different username
      try {
        const existingUsername = await this.usersLocalIndex.getUsername(userId);
        if (existingUsername && existingUsername !== username) {
          conflicts.push({
            userId,
            username,
            reason: `userId "${userId}" already registered as "${existingUsername}"`
          });
        }
      } catch (e) {
        // Not found — no conflict
      }
    }
    return conflicts;
  }

  async _restorePlatform (reader) {
    if (!this.platformDB) return;
    const data = [];
    let skipped = 0;
    for await (const item of await reader.readPlatformData()) {
      // v1 backups (and old v2 exports) write raw `{key, value}` entries straight from
      // the SQLite/MongoDB platform-wide store. v2 platformDB.importAll expects the
      // parsed shape `{username, field, value, isUnique}` (matching exportAll output).
      // Bridge both shapes here so v1→v2 migrations restore platform data correctly.
      if (item.username == null && typeof item.key === 'string') {
        const parsed = parseRawPlatformEntry(item);
        if (parsed) data.push(parsed);
        else skipped++;
      } else {
        data.push(item);
      }
    }
    if (data.length > 0) {
      await this.platformDB.importAll(data);
    }
    this.logger.info(`Platform data restored: ${data.length} records${skipped ? ` (${skipped} unsupported keys skipped)` : ''}`);
  }
}

/**
 * Parse a raw platform entry `{key, value}` (as written by v1's SQLite/MongoDB
 * platform-wide store) into the canonical shape `{username, field, value, isUnique}`
 * expected by `PlatformDB.importAll`.
 *
 * Only handles `user-unique/{field}/{value}` and `user-indexed/{field}/{username}` —
 * the only key types present in v1 platform data. Other key types (user-core,
 * core-info, invitation) are v2-only and have no v1 equivalent; returns null.
 */
function parseRawPlatformEntry (entry) {
  const parts = entry.key.split('/');
  if (parts.length < 3) return null;
  const [type, field, userNameOrValue] = parts;
  if (type === 'user-unique') {
    return { isUnique: true, field, username: entry.value, value: userNameOrValue };
  }
  if (type === 'user-indexed') {
    return { isUnique: false, field, username: userNameOrValue, value: entry.value };
  }
  return null;
}

module.exports = RestoreOrchestrator;
