/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { fromCallback } = require('utils');
const timestamp = require('unix-timestamp');
const { sanitize } = require('storages/interfaces/backup/sanitize.ts');

/**
 * Orchestrates full backup using existing storage layer methods.
 * Reads from StorageLayer, UserAccountStorage, AuditStorage, EventFiles, PlatformDB
 * and writes to a BackupWriter implementation.
 *
 * ## Consistency model
 *
 * A snapshot timestamp (`snapshotBefore`) is recorded at backup start.
 * Only items with `modified <= snapshotBefore` (or `created <= snapshotBefore`
 * for entities without `modified`) are exported. Any concurrent writes that
 * happen during backup are excluded — they'll be captured by the next
 * incremental backup.
 *
 * This allows backing up without freezing user accounts or interrupting
 * the running system.
 *
 * ## Incremental mode
 *
 * When `options.incremental` is true and an existing manifest is provided
 * (via `options.previousManifest`), only items modified/deleted since the
 * per-user `backupTimestamp` from the previous backup are exported.
 * Profile and account data are always fully exported (no timestamps).
 */
class BackupOrchestrator {
  storageLayer: any;
  usersLocalIndex: any;
  userAccountStorage: any;
  eventFiles: any;
  platformDB: any;
  auditStorage: any;
  seriesConnection: any;
  logger: any;

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
    const { getEventFiles } = require('storage/src/eventFiles/getEventFiles.ts');
    const storages = require('storages');
    this.storageLayer = await getStorageLayer();
    this.usersLocalIndex = await getUsersLocalIndex();
    this.userAccountStorage = await getUserAccountStorage();
    this.eventFiles = await getEventFiles();
    this.platformDB = storages.platformDB;
    this.auditStorage = storages.auditStorage;
    this.seriesConnection = storages.seriesConnection;
    const { getLogger } = require('@pryv/boiler');
    this.logger = getLogger('backup');
    return this;
  }

  /**
   * Backup all users and platform data.
   * @param [options]
   * @param [options.incremental=false] - only export changes since previous backup
   * @param [options.previousManifest] - previous backup manifest (for incremental)
   * @param [options.includeEphemeral=false] - include sessions and password-reset-requests
   */
  async backupAllUsers (writer: any, options: any = {}) {
    const config = await this._getBackupConfig();
    const coreVersion = require('storage/package.json').version;
    const snapshotBefore = timestamp.now();
    const allUsers = await this.usersLocalIndex.getAllByUsername();
    const userManifests: any[] = [];
    const userCount = Object.keys(allUsers).length;

    // Build per-user "since" map from previous manifest
    const perUserSince: any = this._buildPerUserSince(options);

    const isIncremental = options.incremental && Object.keys(perUserSince).length > 0;
    this.logger.info(`Starting ${isIncremental ? 'incremental' : 'full'} backup of ${userCount} users (snapshot before ${snapshotBefore})`);

    for (const [username, userId] of Object.entries(allUsers) as Array<[string, string]>) {
      const since = perUserSince[userId] || null;
      this.logger.info(`Backing up user: ${username} (${userId})${since ? ' (incremental since ' + since + ')' : ''}`);
      const userManifest = await this._backupSingleUser(writer, userId, username, snapshotBefore, since, options);
      userManifests.push(userManifest);
    }

    await this._backupPlatform(writer);

    await writer.writeManifest({
      coreVersion,
      config,
      userManifests,
      backupType: isIncremental ? 'incremental' : 'full',
      snapshotBefore,
      backupTimestamp: Date.now()
    });

    this.logger.info(`Backup complete: ${userManifests.length} users`);
  }

  /**
   * Backup a single user.
   * @param [options]
   */
  async backupUser (userId: any, writer: any, options: any = {}) {
    const username = this.usersLocalIndex.getUsername(userId);
    const config = await this._getBackupConfig();
    const coreVersion = require('storage/package.json').version;
    const snapshotBefore = timestamp.now();

    const perUserSince: any = this._buildPerUserSince(options);
    const since = perUserSince[userId] || null;
    const isIncremental = options.incremental && since != null;

    this.logger.info(`Starting ${isIncremental ? 'incremental' : 'full'} single-user backup: ${username} (${userId})`);

    const userManifest = await this._backupSingleUser(writer, userId, username, snapshotBefore, since, options);

    await writer.writeManifest({
      coreVersion,
      config,
      userManifests: [userManifest],
      backupType: isIncremental ? 'incremental' : 'full',
      snapshotBefore,
      backupTimestamp: Date.now()
    });

    this.logger.info(`Single-user backup complete: ${username}`);
    return userManifest;
  }

  /**
   * Backup platform data only.
   */
  async backupPlatform (writer: any) {
    await this._backupPlatform(writer);
  }

  // -------------------------------------------------------------------------
  // Internal
  // -------------------------------------------------------------------------

  /**
   * Build a { userId: sinceTimestamp } map from the previous manifest.
   * Each user's "since" is their individual backupTimestamp from the last backup.
   */
  _buildPerUserSince (options: any) {
    const map: any = {};
    if (!options.incremental || !options.previousManifest) return map;
    const prev = options.previousManifest;
    if (prev.users && Array.isArray(prev.users)) {
      for (const u of prev.users) {
        if (u.userId && u.backupTimestamp) {
          // Convert ms timestamp to unix seconds for comparison with modified fields
          map[u.userId] = u.backupTimestamp / 1000;
        }
      }
    }
    return map;
  }

  /**
   * @param snapshotBefore - unix timestamp: only export items modified <= this
   * @param since - for incremental: only export items modified > this
   */
  async _backupSingleUser (writer: any, userId: any, username: any, snapshotBefore: any, since: any, options: any) {
    const userWriter = await writer.openUser(userId, username);
    const user = { id: userId };

    // Streams
    const rawStreams = await fromCallback(
      (cb: any) => this.storageLayer.streams.exportAll(user, cb)
    );
    const streams = this._filterByTimestamp(rawStreams, snapshotBefore, since, 'streams');
    await userWriter.writeStreams(streams.map(sanitize));

    // Accesses
    const rawAccesses = await fromCallback(
      (cb: any) => this.storageLayer.accesses.exportAll(user, cb)
    );
    const accesses = this._filterByTimestamp(rawAccesses, snapshotBefore, since, 'accesses');
    await userWriter.writeAccesses(accesses.map(sanitize));

    // Profile (no timestamps — always full export)
    const profile = await fromCallback(
      (cb: any) => this.storageLayer.profile.exportAll(user, cb)
    );
    this._assertArray(profile, 'profile', userId);
    await userWriter.writeProfile(profile.map(sanitize));

    // Webhooks
    const rawWebhooks = await fromCallback(
      (cb: any) => this.storageLayer.webhooks.exportAll(user, cb)
    );
    const webhooks = this._filterByTimestamp(rawWebhooks, snapshotBefore, since, 'webhooks');
    await userWriter.writeWebhooks(webhooks.map(sanitize));

    // Events
    const rawEvents = await this._exportEvents(userId);
    const events = this._filterByTimestamp(rawEvents, snapshotBefore, since, 'events');
    await userWriter.writeEvents(events.map(sanitize));

    // Attachments — only for events in this backup
    await this._backupAttachments(userWriter, userId, events);

    // Account data (no timestamps — always full export)
    const accountData = await this.userAccountStorage._exportAll(userId);
    await userWriter.writeAccountData(accountData);

    // Audit (optional)
    if (this.auditStorage) {
      try {
        const userAudit = this.auditStorage.forUser(userId);
        const auditEvents = await userAudit.exportAllEvents();
        const filteredAudit = this._filterByTimestamp(auditEvents, snapshotBefore, since, 'audit');
        await userWriter.writeAudit(filteredAudit.map(sanitize));
      } catch (e: any) {
        this.logger.warn(`Audit export failed for user ${userId}: ${e.message}`);
      }
    }

    // Series (optional — skip if no series engine configured)
    if (this.seriesConnection) {
      try {
        const seriesData = await this.seriesConnection.exportDatabase(userId);
        if (seriesData.measurements && seriesData.measurements.length > 0) {
          await userWriter.writeSeries(seriesData.measurements);
        }
      } catch (e: any) {
        this.logger.warn(`Series export failed for user ${userId}: ${e.message}`);
      }
    }

    return await userWriter.close();
  }

  /**
   * Filter items by snapshot and incremental timestamps.
   *
   * - `snapshotBefore`: exclude items modified after backup start (consistency)
   * - `since`: for incremental, only include items modified after the previous backup
   *
   * Items without `modified` or `created` fields are always included
   * (e.g. profile data, or items from engines that don't track timestamps).
   *
   * @param snapshotBefore - unix timestamp (seconds)
   * @param since - unix timestamp (seconds), null for full backup
   */
  _filterByTimestamp (items: any, snapshotBefore: any, since: any, source: string = 'items') {
    this._assertArray(items, source);
    return items.filter((item: any) => {
      const ts = item.modified || item.created || item.time;
      if (ts == null) return true; // no timestamp — always include
      // Exclude items modified after snapshot (consistency)
      if (ts > snapshotBefore) return false;
      // For incremental: exclude items not modified since last backup
      if (since != null && ts <= since) return false;
      return true;
    });
  }

  // Defensive check. Storage-layer export methods are typed to return arrays,
  // but a shape drift in any of the underlying `exportAll`/`exportAllEvents`
  // (e.g. a wrapper change returning `{rows}` or `{data}` instead of bare
  // array) used to surface as a cryptic "items.filter is not a function" with
  // no hint about which collection — see B-2026-05-20-1. Throw a clear,
  // localized message instead.
  _assertArray (items: any, source: string, userId?: string) {
    if (!Array.isArray(items)) {
      const ctx = userId ? ` (user ${userId})` : '';
      const got = items == null ? String(items) : `${typeof items}${typeof items === 'object' ? ` keys=[${Object.keys(items).slice(0, 5).join(',')}]` : ''}`;
      throw new Error(
        `Backup export shape mismatch: expected array from "${source}"${ctx}, got ${got}. ` +
        'Likely a storage-layer return-shape drift; check the engine\'s exportAll implementation.'
      );
    }
  }

  async _exportEvents (userId: any) {
    // Events live in a shared collection (Mongo/PG) or in the per-user
    // SQLite baseStorage file. Branch on the engine.
    const storages = require('storages');

    // SQLite: per-user file at <userLocalDirectory>/<userId>/baseStorage-*.sqlite.
    // Read directly from the events table — covers both active and deleted
    // rows (history kept via head_id semantics).
    const engine = storages.pluginLoader?.getEngineFor('baseStorage');
    if (engine === 'sqlite') {
      const { UserBaseStorageDb } = require('storages/engines/sqlite/src/userBaseStorage/UserBaseStorageDb.ts');
      const udb = await UserBaseStorageDb.forUser(userId);
      const rows = udb.db.prepare('SELECT * FROM events').all();
      return rows.map((row: any) => {
        const event: any = row.data ? JSON.parse(row.data) : {};
        event.id = row.id;
        if (row.head_id != null) event.headId = row.head_id;
        if (row.deleted != null) event.deleted = row.deleted;
        return event;
      });
    }

    // Mongo / PG: use the shared database connection.
    const database = storages.database || storages.databasePG;
    if (!database) return [];

    if (storages.database) {
      // MongoDB: query events collection filtered by userId
      return await fromCallback((cb: any) =>
        database.find({ name: 'events' }, { userId }, {}, cb)
      );
    }

    // PostgreSQL: use the events table. `database.query` returns a pg
    // QueryResult ({ command, rowCount, oid, rows, fields }); the caller
    // wants the rows array. Closes B-2026-05-26-F6 (diagnostic-only fix
    // landed earlier without the actual data-shape repair).
    if (storages.databasePG) {
      const res = await database.query(
        'SELECT * FROM events WHERE user_id = $1',
        [userId]
      );
      return res?.rows || [];
    }

    return [];
  }

  async _backupAttachments (userWriter: any, userId: any, events: any) {
    for (const event of events) {
      if (!event.attachments || !Array.isArray(event.attachments)) continue;
      for (const att of event.attachments) {
        const fileId = att.id;
        if (!fileId) continue;
        try {
          const stream = await this.eventFiles.getAttachmentStream(userId, event.id, fileId);
          await userWriter.writeAttachment(event.id, fileId, stream);
        } catch (e: any) {
          this.logger.warn(`Attachment backup failed: event=${event.id} file=${fileId}: ${e.message}`);
        }
      }
    }
  }

  async _backupPlatform (writer: any) {
    if (!this.platformDB) return;
    const platformData = await this.platformDB.exportAll();
    await writer.writePlatformData(platformData);
  }

  async _getBackupConfig () {
    const { getConfig } = require('@pryv/boiler');
    const config = await getConfig();
    return {
      engine: this.storageLayer.engine,
      domain: config.get('dnsLess:publicUrl') || config.get('service:domain') || 'unknown'
    };
  }
}

export default BackupOrchestrator;
export { BackupOrchestrator };