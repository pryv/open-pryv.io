/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */
import { createRequire } from 'node:module';
import type { Logger } from '@pryv/boiler';
import type { PlatformDB } from '../../../../storages/interfaces/platformStorage/PlatformDB.ts';
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
  // Storage handles, modelled by the `*Like` structural interfaces below
  // (the methods this orchestrator actually calls). All set in `init()`.
  storageLayer!: StorageLayerLike;
  usersLocalIndex!: UsersLocalIndexLike;
  userAccountStorage!: UserAccountStorageLike;
  eventFiles!: EventFilesLike;
  platformDB!: PlatformDB;
  auditStorage: AuditStorageLike | null = null;
  seriesConnection: SeriesConnectionLike | null = null;
  logger!: Logger;

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
  async backupAllUsers (writer: BackupWriter, options: BackupOptions = {}) {
    const config = await this._getBackupConfig();
    const coreVersion = require('storage/package.json').version;
    const snapshotBefore = timestamp.now();
    const allUsers = await this.usersLocalIndex.getAllByUsername();
    const userManifests: unknown[] = [];
    const userCount = Object.keys(allUsers).length;

    // Build per-user "since" map from previous manifest
    const perUserSince = this._buildPerUserSince(options);

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
  async backupUser (userId: string, writer: BackupWriter, options: BackupOptions = {}) {
    const username = await this.usersLocalIndex.getUsername(userId);
    if (username == null) throw new Error(`User ${userId} not found in local index`);
    const config = await this._getBackupConfig();
    const coreVersion = require('storage/package.json').version;
    const snapshotBefore = timestamp.now();

    const perUserSince = this._buildPerUserSince(options);
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
  async backupPlatform (writer: BackupWriter) {
    await this._backupPlatform(writer);
  }

  // -------------------------------------------------------------------------
  // Internal
  // -------------------------------------------------------------------------

  /**
   * Build a { userId: sinceTimestamp } map from the previous manifest.
   * Each user's "since" is their individual backupTimestamp from the last backup.
   */
  _buildPerUserSince (options: BackupOptions): Record<string, number> {
    const map: Record<string, number> = {};
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
  async _backupSingleUser (writer: BackupWriter, userId: string, username: string, snapshotBefore: number, since: number | null, options: BackupOptions) {
    const userWriter = await writer.openUser(userId, username);
    const user = { id: userId };

    // Streams
    const rawStreams = await fromCallback(
      (cb: NodeCallback) => this.storageLayer.streams.exportAll(user, cb)
    );
    const streams = this._filterByTimestamp(rawStreams, snapshotBefore, since, 'streams');
    await userWriter.writeStreams(streams.map(sanitize));

    // Accesses
    const rawAccesses = await fromCallback(
      (cb: NodeCallback) => this.storageLayer.accesses.exportAll(user, cb)
    );
    const accesses = this._filterByTimestamp(rawAccesses, snapshotBefore, since, 'accesses');
    await userWriter.writeAccesses(accesses.map(sanitize));

    // Profile (no timestamps — always full export)
    const profile = await fromCallback(
      (cb: NodeCallback) => this.storageLayer.profile.exportAll(user, cb)
    );
    this._assertArray(profile, 'profile', userId);
    await userWriter.writeProfile(profile.map(sanitize));

    // Webhooks
    const rawWebhooks = await fromCallback(
      (cb: NodeCallback) => this.storageLayer.webhooks.exportAll(user, cb)
    );
    const webhooks = this._filterByTimestamp(rawWebhooks, snapshotBefore, since, 'webhooks');
    await userWriter.writeWebhooks(webhooks.map(sanitize));

    // Events
    const rawEvents = await this._exportEvents(userId);
    const events = this._filterByTimestamp(rawEvents, snapshotBefore, since, 'events');
    await userWriter.writeEvents(events.map(sanitize));

    // Attachments — only for events in this backup
    await this._backupAttachments(userWriter, userId, events as Array<{ id: string; attachments?: Array<{ id?: string }> }>);

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
      } catch (e: unknown) {
        this.logger.warn(`Audit export failed for user ${userId}: ${(e as Error).message}`);
      }
    }

    // Series (optional — skip if no series engine configured)
    if (this.seriesConnection) {
      try {
        const seriesData = await this.seriesConnection.exportDatabase(userId);
        if (seriesData.measurements && seriesData.measurements.length > 0) {
          await userWriter.writeSeries(seriesData.measurements);
        }
      } catch (e: unknown) {
        this.logger.warn(`Series export failed for user ${userId}: ${(e as Error).message}`);
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
  _filterByTimestamp (items: unknown, snapshotBefore: number, since: number | null, source: string = 'items') {
    this._assertArray(items, source);
    return (items as Array<{ modified?: number; created?: number; time?: number }>).filter((item) => {
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
  _assertArray (items: unknown, source: string, userId?: string): asserts items is unknown[] {
    if (!Array.isArray(items)) {
      const ctx = userId ? ` (user ${userId})` : '';
      const got = items == null ? String(items) : `${typeof items}${typeof items === 'object' ? ` keys=[${Object.keys(items).slice(0, 5).join(',')}]` : ''}`;
      throw new Error(
        `Backup export shape mismatch: expected array from "${source}"${ctx}, got ${got}. ` +
        'Likely a storage-layer return-shape drift; check the engine\'s exportAll implementation.'
      );
    }
  }

  async _exportEvents (userId: string) {
    // Events are in a shared collection, filtered by userId.
    // Use the database directly with BaseStorage-style query.
    const storages = require('storages');
    const database = storages.database || storages.databasePG;
    if (!database) return [];

    if (storages.database) {
      // MongoDB: query events collection filtered by userId
      return await fromCallback((cb: NodeCallback) =>
        database.find({ name: 'events' }, { userId }, {}, cb)
      );
    }

    // PostgreSQL: use the events table
    if (storages.databasePG) {
      const rows = await database.query(
        'SELECT * FROM events WHERE user_id = $1',
        [userId]
      );
      return rows || [];
    }

    return [];
  }

  async _backupAttachments (userWriter: UserWriter, userId: string, events: Array<{ id: string; attachments?: Array<{ id?: string }> }>) {
    for (const event of events) {
      if (!event.attachments || !Array.isArray(event.attachments)) continue;
      for (const att of event.attachments) {
        const fileId = att.id;
        if (!fileId) continue;
        try {
          const stream = await this.eventFiles.getAttachmentStream(userId, event.id, fileId);
          await userWriter.writeAttachment(event.id, fileId, stream);
        } catch (e: unknown) {
          this.logger.warn(`Attachment backup failed: event=${event.id} file=${fileId}: ${(e as Error).message}`);
        }
      }
    }
  }

  async _backupPlatform (writer: BackupWriter) {
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

// Local type aliases mirroring RestoreOrchestrator's shapes. The BackupWriter
// is a structural interface — concrete writers (BackupWriterTar / Dir / ...)
// live alongside and don't formally implement an interface yet.
type UserRef = { id: string };

// Structural slices of the storage handles — the methods this orchestrator
// calls. Tighten further if/when these stores expose formal interfaces.
type ExportStore = { exportAll (user: UserRef, cb: NodeCallback): void };
type StorageLayerLike = {
  streams: ExportStore;
  accesses: ExportStore;
  profile: ExportStore;
  webhooks: ExportStore;
  engine: string;
};
type UsersLocalIndexLike = {
  getAllByUsername (): Promise<Record<string, string>>;
  getUsername (userId: string): Promise<string | undefined>;
};
type UserAccountStorageLike = {
  _exportAll (userId: string): Promise<unknown>;
};
type EventFilesLike = {
  getAttachmentStream (userId: string, eventId: string, fileId: string): Promise<unknown>;
};
type AuditStorageLike = {
  forUser (userId: string): { exportAllEvents (): Promise<unknown> };
};
type SeriesConnectionLike = {
  exportDatabase (userId: string): Promise<{ measurements?: unknown[] }>;
};
type Manifest = {
  users: Array<{ userId: string; backupTimestamp?: number }>;
};
type BackupOptions = {
  incremental?: boolean;
  previousManifest?: Manifest;
  includeEphemeral?: boolean;
};
type UserWriter = {
  writeStreams (items: unknown[]): Promise<void>;
  writeAccesses (items: unknown[]): Promise<void>;
  writeProfile (items: unknown[]): Promise<void>;
  writeWebhooks (items: unknown[]): Promise<void>;
  writeEvents (items: unknown[]): Promise<void>;
  writeAttachment (eventId: string, fileId: string, stream: unknown): Promise<void>;
  writeAccountData (data: unknown): Promise<void>;
  writeAudit (items: unknown[]): Promise<void>;
  writeSeries (items: unknown[]): Promise<void>;
  close (): Promise<unknown>;
};
type BackupWriter = {
  openUser (userId: string, username: string): Promise<UserWriter>;
  writePlatformData (data: unknown): Promise<void>;
  writeManifest (manifest: unknown): Promise<void>;
};
type NodeCallback<T = unknown> = (err: Error | null | undefined, value?: T) => void;