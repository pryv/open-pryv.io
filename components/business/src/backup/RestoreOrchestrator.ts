/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */
import { createRequire } from 'node:module';
import type { Logger } from '@pryv/boiler';
import type { PlatformDB, PlatformEntry } from '../../../../storages/interfaces/platformStorage/PlatformDB.ts';
const require = createRequire(import.meta.url);
const { fromCallback } = require('utils');
const accountStreams = require('../system-streams/index.ts');
const timestamp = require('unix-timestamp');
const { seriesNamespace } = require('../series/namespace.ts');
const { deletedUserMessage } = require('storages/interfaces/backup/chain.ts');

// A backup can come from storage the operator does not control: its user ids
// and usernames become local path segments (user directory, series file), so
// each must be one safe file name: letters, digits, `-` and `_`, no dot, no
// separator, 3 to 64 characters. Not the exact grammar of the ids and names
// this server issues: accounts migrated or created by older versions restore
// too, and the per-user paths are checked to stay inside their base anyway.
const SAFE_SEGMENT_RE = /^[A-Za-z0-9_-]{3,64}$/;

function isRestorableUser (entry: { userId?: unknown; username?: unknown } | null | undefined): boolean {
  return entry != null &&
    typeof entry.userId === 'string' && SAFE_SEGMENT_RE.test(entry.userId) &&
    typeof entry.username === 'string' && SAFE_SEGMENT_RE.test(entry.username);
}

/** Refuses the whole restore when any user id or username is not a safe path segment. */
function assertRestorableUsers (users: unknown): void {
  if (!Array.isArray(users)) throw new Error('Restore aborted: the backup manifest has no user list');
  const invalid = users.filter((u) => !isRestorableUser(u));
  if (invalid.length > 0) {
    const desc = invalid.map((u) => `${JSON.stringify(u?.username)} (${JSON.stringify(u?.userId)})`).join(', ');
    throw new Error(`Restore aborted: ${invalid.length} user entry(ies) of the backup manifest with an invalid user id or username: ${desc}. Nothing was restored.`);
  }
}

/**
 * Refuses the whole restore when a username the backup names (a manifest
 * entry, the owner of a platform row, a register server mapping) is not one
 * safe segment, or is a name this platform routes itself (`pryv...`, the
 * service hosts of its DNS, the paths it serves, hosted-site names): those
 * rows would route platform names to an account. `where` says which part of
 * the backup. Names that are only in the registration word list are restored
 * (see `_warnListedUsernames`).
 */
function assertRestorableUsernames (usernames: unknown[], isReserved: (name: string) => boolean, where: string): void {
  const invalid = usernames.filter((name) => typeof name !== 'string' || !SAFE_SEGMENT_RE.test(name) || isReserved(name));
  if (invalid.length > 0) {
    const desc = [...new Set(invalid.map((name) => JSON.stringify(name)))].join(', ');
    throw new Error(`Restore aborted: ${invalid.length} ${where} name an invalid or reserved username: ${desc}. Nothing was restored.`);
  }
}

/**
 * Orchestrates restore from a backup archive into the current core.
 * Reads from a BackupReaderLike and writes into StorageLayer, UserAccountStorage,
 * AuditStorage, EventFiles, PlatformDB.
 */
class RestoreOrchestrator {
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
  /** Replaces the platform's routing-name check when set (tests). */
  isReservedUsername: ((name: string) => boolean) | null = null;
  /** Replaces the platform's word-list check when set (tests). */
  isListedUsername: ((name: string) => boolean) | null = null;

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
    this.logger = getLogger('restore');
    await accountStreams.init();
    return this;
  }

  /**
   * Restore all users and platform data from a backup.
   * @param [options]
   * @param [options.overwrite=true] - clearAll before import
   * @param [options.skipPlatform=false] - skip platform data
   * @param [options.skipConflicts=false] - skip conflicting users instead of failing
   * @param [options.deleteOnSuccess=false] - delete backup data after successful restore
   * @param [options.moveOnSuccess] - move backup data to this path after successful restore
   */
  async restoreAllUsers (reader: BackupReaderLike, options: RestoreOptions = {}) {
    const opts: RestoreOptions = Object.assign({ overwrite: true, skipPlatform: false, skipConflicts: false }, options);

    if (opts.skipConflicts && !opts.deleteOnSuccess && !opts.moveOnSuccess) {
      throw new Error('--skip-conflicts requires --delete-on-success or --move-on-success');
    }

    const manifest = await reader.readManifest();
    assertRestorableUsers(manifest.users);
    const isReserved = await this._reservedUsernameCheck();
    assertRestorableUsernames(manifest.users.map((u: UserManifest) => u.username), isReserved, 'user entry(ies) of the backup manifest');
    await this._warnListedUsernames(manifest.users.map((u: UserManifest) => u.username));
    // Platform rows are read and checked before any user is restored, and
    // written after them.
    const platformRead = opts.skipPlatform ? null : await this._readPlatform(reader, isReserved);
    const runs = Array.isArray(manifest.runs) ? manifest.runs : null;
    this.logger.info(`Restoring from backup: format=${manifest.formatVersion} type=${manifest.backupType} users=${manifest.users.length}` +
      (runs != null ? ` runs=${runs.length} (${runs.map((r) => r.runId).join(', ')})` : ''));
    // Accounts deleted along the chain are restored nowhere: say so, by name.
    const deleted = Array.isArray(manifest.deletedUsers) ? manifest.deletedUsers : [];
    for (const d of deleted) this.logger.info(deletedUserMessage(d));

    // Detect conflicts
    const conflicts = await this._detectConflicts(manifest.users);
    const report: { restored: UserManifest[], skipped: UserManifest[], conflicts: ConflictRef[], deleted: DeletedUserRef[] } = { restored: [], skipped: [], conflicts, deleted };

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

    if (platformRead != null) {
      await this._writePlatform(platformRead);
    }

    this.logger.info(`Restore complete: ${report.restored.length} restored, ${report.skipped.length} skipped`);
    return report;
  }

  /**
   * Restore a single user from backup.
   * @param [options]
   * @param [options.overwrite=false] - clearAll before import
   * @param [options.skipPlatform=true] - skip platform data
   * @param [options.remapUserId] - remap to a different userId
   */
  async restoreUser (userId: string, reader: BackupReaderLike, options: RestoreOptions = {}) {
    const opts: RestoreOptions = Object.assign({ overwrite: false, skipPlatform: true }, options);
    const manifest = await reader.readManifest();

    const deleted = (Array.isArray(manifest.deletedUsers) ? manifest.deletedUsers : []).find((d) => d.userId === userId);
    if (deleted != null) throw new Error(deletedUserMessage(deleted));
    const userManifest = manifest.users.find((u: UserManifest) => u.userId === userId);
    if (!userManifest) {
      throw new Error(`User ${userId} not found in backup manifest`);
    }

    const targetUserId = opts.remapUserId || userId;
    const { username } = userManifest;
    assertRestorableUsers([userManifest, { userId: targetUserId, username }]);
    const isReserved = await this._reservedUsernameCheck();
    assertRestorableUsernames([username], isReserved, 'user entry(ies) of the backup manifest');
    await this._warnListedUsernames([username]);

    // Check conflicts
    const conflicts = await this._detectConflicts([{ userId: targetUserId, username }]);
    // The username now belongs to another account: overwriting would mix the
    // backed-up account into that one (its data cleared, the backup's
    // imported over it). Never, even with --overwrite.
    const nameTaken = conflicts.find((c) => c.kind === 'username-taken');
    if (nameTaken != null) {
      throw new Error(`User ${username} cannot be restored: ${nameTaken.reason}. Nothing was restored.`);
    }
    if (conflicts.length > 0 && !opts.overwrite) {
      throw new Error(`User ${username} conflicts with existing data: ${conflicts[0].reason}. Use --overwrite to replace.`);
    }
    const platformRead = opts.skipPlatform ? null : await this._readPlatform(reader, isReserved);

    await this._restoreSingleUser(reader, userId, username, opts, targetUserId);

    if (platformRead != null) {
      await this._writePlatform(platformRead);
    }

    this.logger.info(`Single-user restore complete: ${username}`);
    return { restored: [{ userId: targetUserId, username }], skipped: [], conflicts };
  }

  /**
   * Restore platform data only.
   */
  async restorePlatform (reader: BackupReaderLike) {
    await reader.readManifest();
    await this._restorePlatform(reader);
  }

  /**
   * The reserved-name check that refuses a restore: the names the platform
   * routes itself (hosted-site names re-read first), or `isReservedUsername`
   * when set. The registration word list is not part of it: an account
   * registered before a word was listed, or on another platform, restores.
   */
  async _reservedUsernameCheck (): Promise<(name: string) => boolean> {
    if (this.isReservedUsername != null) return this.isReservedUsername;
    const { getPlatform } = require('platform');
    const platform = await getPlatform();
    await platform.refreshPlatformNames();
    return (name: string) => platform.isUsernameRoutingReserved(name);
  }

  /**
   * Log a warning for each restored username that the registration word list
   * would refuse today (it restores; a new account could not take the name).
   */
  async _warnListedUsernames (usernames: string[]): Promise<void> {
    let isListed = this.isListedUsername;
    if (isListed == null) {
      const { getPlatform } = require('platform');
      const platform = await getPlatform();
      isListed = (name: string) => platform.isUsernameInReservedList(name);
    }
    for (const name of new Set(usernames)) {
      if (isListed(name)) this.logger.warn(`Restoring username "${name}": a reserved word for new registrations (restored as is).`);
    }
  }

  // -------------------------------------------------------------------------
  // Internal
  // -------------------------------------------------------------------------

  async _restoreSingleUser (reader: BackupReaderLike, userId: string, username: string, opts: RestoreOptions, targetUserId?: string) {
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
      await this._clearUserData(user, targetUserId, username);
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
    const streams: unknown[] = [];
    for await (const stream of await userReader.readStreams()) {
      streams.push(stream);
    }
    if (streams.length > 0) {
      await fromCallback(
        (cb: NodeCallback) => this.storageLayer.streams.importAll(user, streams, cb)
      );
    }

    // Accesses
    const accesses: unknown[] = [];
    for await (const access of await userReader.readAccesses()) {
      accesses.push(access);
    }
    if (accesses.length > 0) {
      await fromCallback(
        (cb: NodeCallback) => this.storageLayer.accesses.importAll(user, accesses, cb)
      );
    }

    // Profile
    const profile: unknown[] = [];
    for await (const item of await userReader.readProfile()) {
      profile.push(item);
    }
    if (profile.length > 0) {
      await fromCallback(
        (cb: NodeCallback) => this.storageLayer.profile.importAll(user, profile, cb)
      );
    }

    // Webhooks
    const webhooks: unknown[] = [];
    for await (const wh of await userReader.readWebhooks()) {
      webhooks.push(wh);
    }
    if (webhooks.length > 0) {
      await fromCallback(
        (cb: NodeCallback) => this.storageLayer.webhooks.importAll(user, webhooks, cb)
      );
    }

    // Events
    const events: unknown[] = [];
    for await (const event of await userReader.readEvents()) {
      events.push(event);
    }
    if (events.length > 0) {
      await this._importEvents(user, events);
    }

    // Attachments (a file no restored event references is not restored)
    let unreferencedAttachments = 0;
    for await (const { eventId, fileId, stream } of await userReader.readAttachments()) {
      if (eventId == null) {
        (stream as { destroy?: () => void } | null)?.destroy?.();
        unreferencedAttachments++;
        continue;
      }
      await this.eventFiles.saveAttachmentFromStream(stream, targetUserId, eventId, fileId);
    }
    if (unreferencedAttachments > 0) {
      this.logger.warn(`${unreferencedAttachments} attachment file(s) of user ${targetUserId} referenced by no event of the backup: not restored`);
    }

    // Account data
    const accountData = await userReader.readAccountData();
    if (accountData) {
      await this.userAccountStorage._importAll(targetUserId, accountData);
    }

    // Ensure minimum account fields exist (safety net for v1 backups without accountFields)
    const hasAccountFields = (accountData?.accountFields?.length ?? 0) > 0;
    if (!hasAccountFields) {
      const leavesMap = accountStreams.accountLeavesMap;
      const now = timestamp.now();
      let defaultsCreated = 0;
      for (const [streamId, stream] of Object.entries(leavesMap) as Array<[string, { default?: unknown }]>) {
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
        const auditEvents: unknown[] = [];
        for await (const ae of await userReader.readAudit()) {
          auditEvents.push(ae);
        }
        await this._restoreAudit(targetUserId, auditEvents);
      } catch (e: unknown) {
        this.logger.warn(`Audit import failed for user ${targetUserId}: ${(e as Error).message}`);
      }
    }

    // Series (optional — skip if no series engine configured)
    if (this.seriesConnection) {
      try {
        const seriesMeasurements: unknown[] = [];
        for await (const item of await userReader.readSeries()) {
          seriesMeasurements.push(item);
        }
        if (seriesMeasurements.length > 0) {
          await this.seriesConnection.importDatabase(seriesNamespace(username), { measurements: seriesMeasurements });
        }
      } catch (e: unknown) {
        this.logger.warn(`Series import failed for user ${targetUserId}: ${(e as Error).message}`);
      }
    }

    this.logger.info(`User restored: ${username} (${targetUserId})`);
  }

  async _importEvents (user: UserRef, events: unknown[]) {
    // Use BaseStorage importAll via callback (same path as existing migration)
    // The storageLayer doesn't expose events directly, but the engine's
    // local data store does via the events collection.
    // For now, we use iterateAllEvents' sibling — the events store on storageLayer.
    // If not available, fall back to inserting via the data store module.
    const eventsStore = this.storageLayer.events;
    if (eventsStore && typeof eventsStore.importAll === 'function') {
      await fromCallback(
        (cb: NodeCallback) => eventsStore.importAll(user, events, cb)
      );
    }
  }

  async _restoreAudit (targetUserId: string, auditEvents: unknown[]) {
    // `AuditStorage.forUser` is async (returns Promise<UserAuditDatabase>). The
    // backup/export path awaits it; this restore path must do the same. Without
    // the await, `forUser(...)` stayed a pending Promise whose `.importAllEvents`
    // was undefined, so the audit trail was silently dropped on restore.
    if (this.auditStorage == null || auditEvents.length === 0) return;
    const userAudit = await this.auditStorage.forUser(targetUserId);
    await userAudit.importAllEvents(auditEvents);
  }

  async _clearUserData (user: UserRef, userId: string, username: string) {
    // Clear all user-scoped stores
    const collections = ['streams', 'accesses', 'profile', 'webhooks'];
    for (const coll of collections) {
      const store = this.storageLayer[coll];
      if (store && typeof store.clearAll === 'function') {
        await fromCallback(
          (cb: NodeCallback) => store.clearAll(user, cb)
        );
      }
    }

    // Clear events
    const eventsStore = this.storageLayer.events;
    if (eventsStore && typeof eventsStore.clearAll === 'function') {
      await fromCallback(
        (cb: NodeCallback) => eventsStore.clearAll(user, cb)
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
      } catch (e: unknown) {
        this.logger.warn(`Audit clear failed for user ${userId}: ${(e as Error).message}`);
      }
    }

    // Clear series
    if (this.seriesConnection) {
      try {
        await this.seriesConnection.dropDatabase(seriesNamespace(username));
      } catch (e: unknown) {
        this.logger.warn(`Series clear failed for user ${userId}: ${(e as Error).message}`);
      }
    }
  }

  async _detectConflicts (users: UserManifest[]): Promise<ConflictRef[]> {
    const conflicts: ConflictRef[] = [];
    for (const { userId, username } of users) {
      // Check if username already exists with a different userId
      try {
        const existingId = await this.usersLocalIndex.getUserId(username);
        if (existingId && existingId !== userId) {
          conflicts.push({
            userId,
            username,
            kind: 'username-taken',
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
            kind: 'userid-renamed',
            reason: `userId "${userId}" already registered as "${existingUsername}"`
          });
        }
      } catch (e) {
        // Not found — no conflict
      }
    }
    return conflicts;
  }

  async _restorePlatform (reader: BackupReaderLike) {
    const platformRead = await this._readPlatform(reader, await this._reservedUsernameCheck());
    await this._writePlatform(platformRead);
  }

  /**
   * Read the platform rows and the register server mappings of a backup, and
   * refuse the restore (nothing written) when one names an invalid or
   * reserved username, as for the manifest.
   */
  async _readPlatform (reader: BackupReaderLike, isReserved: (name: string) => boolean): Promise<PlatformRead> {
    const read: PlatformRead = { data: [], skipped: 0, mappingUsernames: [], defaultCoreId: null };
    if (!this.platformDB) return read;
    const data = read.data;
    for await (const item of await reader.readPlatformData()) {
      // v1 backups (and old v2 exports) write raw `{key, value}` entries straight from
      // the SQLite/MongoDB platform-wide store. v2 platformDB.importAll expects the
      // parsed shape `{username, field, value, isUnique}` (matching exportAll output).
      // Bridge both shapes here so v1→v2 migrations restore platform data correctly.
      if (item.username == null && typeof item.key === 'string') {
        const parsed = parseRawPlatformEntry(item as { key: string; value: string });
        if (parsed) data.push(parsed);
        else read.skipped++;
      } else {
        data.push(item as PlatformEntry);
      }
    }
    // In hashed PII mode a row names its owner by a 64-hex token: one safe
    // segment, never a reserved name.
    assertRestorableUsernames(data.map((entry) => entry.username), isReserved, 'platform row(s) of the backup');

    // v1 enterprise register mappings → v2 user-core rows.
    //
    // The v1 register's `{username}:server` Redis entries are exported to
    // `register/servers.jsonl.gz` by `dev-migrate-v1-v2 export-register.js`.
    // On a v2 multi-core destination each username must have a corresponding
    // `user-core/<username>` row in PlatformDB so the embedded DNS knows
    // which core to route `{username}.{domain}` to. Without this the poll /
    // user-lookup flow returns NXDOMAIN for every restored user.
    //
    // Mapping: the v1 server value is a hostname (e.g. "co1.pryv.me") that
    // no longer exists in v2. We fall back to the single registered core
    // on the destination — this is the common case for a single-core
    // restore (e.g. 14 users on me-dns1 → all land on core-use1).
    // Multi-core destinations that want a specific core mapping can be
    // supported later via an options.coreMap callback.
    try {
      const cores = typeof this.platformDB.getAllCoreInfos === 'function'
        ? await this.platformDB.getAllCoreInfos()
        : [];
      const availableCores = cores.filter((c) => c.available !== false);
      read.defaultCoreId = availableCores.length === 1 ? availableCores[0].id : null;
      if (read.defaultCoreId != null) {
        for await (const mapping of await reader.readServerMappings()) {
          if (typeof mapping.username !== 'string') continue;
          read.mappingUsernames.push(mapping.username);
        }
      }
    } catch (err: unknown) {
      // readServerMappings is optional (default impl is a no-op) — any
      // error here should not fail the whole restore.
      this.logger.warn('Restoring register/ server mappings failed: ' + (err as Error).message);
      read.mappingUsernames = [];
    }
    assertRestorableUsernames(read.mappingUsernames, isReserved, 'register server mapping(s) of the backup');
    return read;
  }

  /** Write what `_readPlatform` read and checked. */
  async _writePlatform (read: PlatformRead) {
    if (!this.platformDB) return;
    if (read.data.length > 0) {
      await this.platformDB.importAll(read.data);
    }
    this.logger.info(`Platform data restored: ${read.data.length} records${read.skipped ? ` (${read.skipped} unsupported keys skipped)` : ''}`);
    let serverMappingsCount = 0;
    if (read.defaultCoreId != null && read.mappingUsernames.length > 0) {
      try {
        // Write through the Platform hashing layer (not the raw engine) so
        // the user-core key is the HMAC token in hashed mode — otherwise a
        // restored mapping is stored cleartext and `platform.getUserCore`
        // (which hashes the lookup) never finds it.
        const { getPlatform } = require('platform');
        const platform = await getPlatform();
        for (const username of read.mappingUsernames) {
          await platform.setUserCore(username, read.defaultCoreId);
          serverMappingsCount++;
        }
      } catch (err: unknown) {
        this.logger.warn('Restoring register/ server mappings failed: ' + (err as Error).message);
      }
    }
    if (serverMappingsCount > 0) {
      this.logger.info(`Register server mappings restored: ${serverMappingsCount} user-core rows written`);
    }
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
function parseRawPlatformEntry (entry: { key: string; value: string }) {
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

export default RestoreOrchestrator;
export { RestoreOrchestrator };

// Local type aliases for the shapes this orchestrator threads through.
// BackupReaderLike is a structural interface — the concrete reader implementations
// live alongside (BackupReaderTar, BackupReaderDir, ...) and don't formally
// implement an interface yet.
type UserRef = { id: string };

// Structural slices of the storage handles — the methods this orchestrator
// calls. Tighten further if/when these stores expose formal interfaces.
type CollectionStore = {
  importAll (user: UserRef, items: unknown[], cb: NodeCallback): void;
  clearAll (user: UserRef, cb: NodeCallback): void;
};
type StorageLayerLike = {
  streams: CollectionStore;
  accesses: CollectionStore;
  profile: CollectionStore;
  webhooks: CollectionStore;
  events?: CollectionStore;
  [collection: string]: CollectionStore | undefined;
};
type UsersLocalIndexLike = {
  addUser (username: string, userId: string): Promise<unknown>;
  getUserId (username: string): Promise<string>;
  getUsername (userId: string): Promise<string>;
};
type UserAccountStorageLike = {
  _importAll (userId: string, data: unknown): Promise<unknown>;
  setAccountField (userId: string, field: string, value: unknown, source: string, time: number): Promise<unknown>;
  _clearAll (userId: string): Promise<unknown>;
};
type EventFilesLike = {
  saveAttachmentFromStream (stream: unknown, userId: string, eventId: string, fileId: string): Promise<unknown>;
  removeAllForUser (userId: string): Promise<unknown>;
};
type AuditStorageLike = {
  forUser (userId: string): Promise<{ importAllEvents (events: unknown[]): Promise<unknown> }>;
  deleteUser (userId: string): Promise<unknown>;
};
type SeriesConnectionLike = {
  importDatabase (namespace: string, data: { measurements: unknown[] }): Promise<unknown>;
  dropDatabase (namespace: string): Promise<unknown>;
};
type UserManifest = { userId: string; username: string };
/** An account deleted along a backup chain: not restored. */
type DeletedUserRef = { userId: string; username: string | null; lastRunId: string; deletedBeforeRunId: string };
/**
 * `runs`: the runs of a backup chain the reader merged (absent for one run);
 * `deletedUsers`: the accounts deleted along them, not in `users`.
 */
type Manifest = { formatVersion: string; backupType: string; users: UserManifest[]; runs?: Array<{ runId: string }>; deletedUsers?: DeletedUserRef[] };
type ConflictRef = { userId: string; username: string; kind: 'username-taken' | 'userid-renamed'; reason: string };
/** The platform part of a backup, read and checked before anything is written. */
type PlatformRead = { data: PlatformEntry[]; skipped: number; mappingUsernames: string[]; defaultCoreId: string | null };
type UserReader = {
  readStreams (): AsyncIterable<unknown>;
  readAccesses (): AsyncIterable<unknown>;
  readProfile (): AsyncIterable<unknown>;
  readWebhooks (): AsyncIterable<unknown>;
  readEvents (): AsyncIterable<unknown>;
  readAttachments (): AsyncIterable<{ eventId: string | null; fileId: string; stream: unknown }>;
  readAccountData (): Promise<{ accountFields?: unknown[] } | null>;
  readAudit (): AsyncIterable<unknown>;
  readSeries (): AsyncIterable<unknown>;
};
type BackupReaderLike = {
  readManifest (): Promise<Manifest>;
  openUser (userId: string): Promise<UserReader>;
  readPlatformData (): AsyncIterable<{ username?: string; field?: string; value?: string; isUnique?: boolean; key?: string }>;
  readServerMappings (): AsyncIterable<{ username: string; server?: string }>;
};
type RestoreOptions = {
  overwrite?: boolean;
  skipPlatform?: boolean;
  skipConflicts?: boolean;
  deleteOnSuccess?: boolean;
  moveOnSuccess?: string;
  remapUserId?: string;
};
type NodeCallback<T = unknown> = (err: Error | null | undefined, value?: T) => void;