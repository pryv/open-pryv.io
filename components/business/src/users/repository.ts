/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */
import { createRequire } from 'node:module';
import type { usersLocalIndex } from 'storage/src/usersLocalIndex.ts';
const require = createRequire(import.meta.url);
const { fromCallback } = require('utils');
const timestamp = require('unix-timestamp');
const { setTimeout } = require('timers/promises');

const User = require('./User.ts').default;
const UserRepositoryOptions = require('./UserRepositoryOptions.ts');
const accountStreams = require('business/src/system-streams/index.ts');
const encryption = require('utils').encryption;
const errors = require('errors').factory;
const { getMall } = require('mall');
import type { Mall } from 'mall/src/types.ts';
import type { Platform } from 'platform/src/Platform.ts';
import type { Sessions } from 'storages/interfaces/baseStorage/Sessions.ts';
import type { UserStorage } from 'storages/interfaces/baseStorage/UserStorage.ts';
import type { UserAccountStorage } from 'storages/interfaces/baseStorage/UserAccountStorage.ts';
import type { StoredAccess } from 'storages/interfaces/_shared/domain.ts';
const { getPlatform } = require('platform');
// Breach-scope reverse-index: a personal access is created with the user at
// registration (a distinct site from accesses.create + login), so index it too;
// and a user's index rows are cleaned up (Art.17) when the account is erased.
const { reindexAccessNonFatal, cleanupUserAccessIndexNonFatal } = require('platform/src/accessIndex.ts');
const cache = require('cache').default;
const cmc = require('cmc');
const { getLogger, getConfig } = require('@pryv/boiler');
const cmcLogger = getLogger('cmc:provisioning');
const logger = getLogger('users:repository');

const crypto = require('crypto');

export { getUsersRepository };

// Alias = 'r-' + 8 chars from an unambiguous lowercase-alnum alphabet
// (no 0/o/1/l/i). Length 10 satisfies the username regexp + min length, so
// aliases route through the subdomain/username path unchanged.
// Per-user account field tracking how many times the username has been changed.
const USERNAME_CHANGE_COUNT_FIELD = 'usernameChangeCount';

const ALIAS_ALPHABET = 'abcdefghjkmnpqrstuvwxyz23456789';
function generateRandomAlias (): string {
  let suffix = '';
  for (let i = 0; i < 8; i++) {
    suffix += ALIAS_ALPHABET[crypto.randomInt(ALIAS_ALPHABET.length)];
  }
  return 'r-' + suffix;
}

/**
 * Repository of the users
 */
type UserData = { id: string; username: string; password?: string; [k: string]: unknown };
type Operation = import('platform/src/Platform.ts').PlatformOperation;

class UsersRepository {
  // Storage-layer plumbing, typed with the storage contracts. All set by
  // init() before any use (definite assignment).
  storageLayer!: { sessions: Sessions; accesses: UserStorage<StoredAccess>; [k: string]: unknown };
  sessionsStorage!: Sessions;
  accessStorage!: UserStorage<StoredAccess>;
  mall!: Mall;
  platform!: Platform;
  userAccountStorage!: UserAccountStorage;
  usersIndex!: typeof usersLocalIndex; // set by init()

  async init () {
    this.mall = await getMall();
    this.platform = await getPlatform();
    const storage = require('storage');
    this.storageLayer = await storage.getStorageLayer();
    this.sessionsStorage = this.storageLayer.sessions;
    this.accessStorage = this.storageLayer.accesses;
    this.usersIndex = await storage.getUsersLocalIndex();
    this.userAccountStorage = await storage.getUserAccountStorage();
  }

  /**
   * only for testing and built-in register
   */
  async getAll () {
    const usersMap = await this.usersIndex.getAllByUsername();
    const users: UserData[] = [];
    for (const [username, userId] of Object.entries(usersMap)) {
      const user = await this.getUserById(userId);
      if (user == null) {
        throw new Error(`Repository inconsistency: user index lists user with id: "${userId}" and username: "${username}", but cannot get it with getUserById()`);
      }
      users.push(user);
    }
    return users;
  }

  /**
   * only for test data to reset all users Dbs.
   */
  async deleteAll () {
    const usersMap = await this.usersIndex.getAllByUsername();
    for (const [, userId] of Object.entries(usersMap)) {
      await this.mall.deleteUser(userId);
    }
    await this.usersIndex.deleteAll();
    await this.platform.deleteAll();
  }

  /**
   * Used only by webhooks could be refactored
   */
  async getAllUsersIdAndName () {
    const usersMap = await this.usersIndex.getAllByUsername();
    const users: UserData[] = [];
    for (const [username, userId] of Object.entries(usersMap)) {
      users.push({ id: userId, username });
    }
    return users;
  }

  async getUserIdForUsername (username: string) {
    return await this.usersIndex.getUserId(username);
  }

  /** Canonical (primary) username for a userId — never an alias. */
  async getUsernameForUserId (userId: string) {
    return await this.usersIndex.getUsername(userId);
  }

  /**
   * Reserve a routable alias for a user. Three coordinated writes:
   *  1. platform unique-field `alias` — atomic cross-core uniqueness claim;
   *  2. local alias index — on-core alias→userId resolution (`getUserId`);
   *  3. name→core mapping (multi-core only) — so `alias.domain` routes to the
   *     owning core exactly like the username does.
   * Generates an `r-` prefixed alias and retries on collision.
   * @returns the reserved alias string.
   */
  async mintAlias (ownerUsername: string, ownerUserId: string): Promise<string> {
    const MAX_TRIES = 8;
    const coreId = await this.#aliasOwnerCoreId(ownerUsername);
    for (let i = 0; i < MAX_TRIES; i++) {
      const alias = generateRandomAlias();
      const reserved = await this.platform.setUserUniqueFieldIfNotExists(ownerUsername, 'alias', alias);
      if (!reserved) { continue; } // collision — try another
      await this.#bindAlias(alias, ownerUserId, coreId);
      return alias;
    }
    throw errors.unexpectedError(new Error('Could not allocate a unique alias after ' + MAX_TRIES + ' attempts.'));
  }

  /**
   * Reserve a SPECIFIC alias value (used by the change-username flow to keep
   * the superseded username routable). Returns true if reserved, false if the
   * value is already taken by another user.
   */
  async reserveSpecificAlias (ownerUsername: string, ownerUserId: string, aliasValue: string): Promise<boolean> {
    const coreId = await this.#aliasOwnerCoreId(ownerUsername);
    const reserved = await this.platform.setUserUniqueFieldIfNotExists(ownerUsername, 'alias', aliasValue);
    if (!reserved) { return false; }
    await this.#bindAlias(aliasValue, ownerUserId, coreId);
    return true;
  }

  async #aliasOwnerCoreId (ownerUsername: string): Promise<string | null> {
    if (this.platform.isSingleCore) { return null; }
    return await this.platform.getUserCore(ownerUsername);
  }

  async #bindAlias (alias: string, ownerUserId: string, coreId: string | null): Promise<void> {
    await this.usersIndex.addAlias(alias, ownerUserId);
    if (coreId != null) { await this.platform.setUserCore(alias, coreId); }
  }

  /**
   * Release an alias previously reserved with {@link mintAlias} — reverses all
   * three writes. No-op-safe for missing rows.
   */
  async releaseAlias (alias: string): Promise<void> {
    await this.platform.deleteUserUniqueField('alias', alias);
    await this.usersIndex.deleteAlias(alias);
    if (!this.platform.isSingleCore) { await this.platform.deleteUserCore(alias); }
  }

  /**
   * Change a user's canonical username from `oldUsername` to `newUsername`,
   * keeping every access issued under the old name working by demoting the old
   * name to a (non-`r-`) alias.
   *
   * Atomic-ish, ordered to minimise harm on partial failure (mirrors the
   * registration write order — cross-store transactions aren't available):
   *  1. platform `username` unique-field swap (collision gate — throws if taken);
   *  2. re-own the user's OTHER platform unique-field rows (email, existing
   *     aliases) under the new username (their stored owner is the old-username
   *     token, otherwise future self-updates would mis-detect collisions);
   *  3. name→core map for the new name (multi-core);
   *  4. local users index rename (aliases untouched);
   *  5. System-Streams `username` account event;
   *  6. demote the old username to a routable alias;
   *  7. bump the change counter.
   * Caller is responsible for limit + format + reserved-word validation.
   */
  async changeUsername (userId: string, oldUsername: string, newUsername: string, accessId: string): Promise<void> {
    const coreId = await this.#aliasOwnerCoreId(oldUsername);

    // 1. Claim the new name for this core FIRST, atomically, as the real
    //    cross-core collision gate: renameUser below OVERWRITES platform rows
    //    and cannot reject, and the caller's availability check is not atomic,
    //    so without this a rename to a name hosted on another core would
    //    silently repoint the victim's routing (the change-username variant of
    //    the registration hijack). Multi-core only — single-core has no
    //    user-core rows to claim (`#aliasOwnerCoreId` returns null) and relies
    //    on the local index + username unique-field for uniqueness. On a lost
    //    claim nothing has been written yet, so simply reject.
    if (coreId != null) {
      const claimed = await this.platform.setUserCoreIfNotExists(newUsername, coreId);
      if (!claimed) { throw errors.itemAlreadyExists('user', { username: newUsername }); }
    }

    // 2. re-key ALL PlatformDB rows old→new (username self-row, email + alias
    //    unique fields re-owned, indexed fields moved). Caller verified the
    //    new name is free; the claim above made it atomic.
    await this.platform.renameUser(oldUsername, newUsername);

    // 3. local index rename (leaves the alias index intact)
    await this.usersIndex.renameUser(oldUsername, newUsername);

    // 4. System-Streams username account field (mirrors registration's write;
    //    `username` is not in the editable-field map used by updateOne).
    await this.userAccountStorage.setAccountField(userId, 'username', newUsername, accessId);

    // 5. keep the old username routable as an alias (re-holds the freed name)
    await this.reserveSpecificAlias(newUsername, userId, oldUsername);

    // 6. record the change
    const count = Number(await this.userAccountStorage.getAccountField(userId, USERNAME_CHANGE_COUNT_FIELD)) || 0;
    await this.userAccountStorage.setAccountField(userId, USERNAME_CHANGE_COUNT_FIELD, count + 1, accessId);
  }

  /** Number of username changes already performed (0 if never). */
  async getUsernameChangeCount (userId: string): Promise<number> {
    return Number(await this.userAccountStorage.getAccountField(userId, USERNAME_CHANGE_COUNT_FIELD)) || 0;
  }

  async getUserById (userId: string) {
    const userAccountStreamsIds = Object.keys(accountStreams.accountMap);
    const query = {
      state: 'all',
      streams: [
        {
          any: userAccountStreamsIds
        }
      ]
    };
    const userAccountEvents = await this.mall.events.get(userId, query);
    const username = await this.usersIndex.getUsername(userId);
    // convert events to the account info structure
    if (userAccountEvents.length === 0) {
      return null;
    }
    if (username == null) {
      // Transient state: index entry already deleted (deleteOne removes it
      // first) but mall data not yet removed.  Return null — the deletion
      // will finish momentarily.
      // Note: a truly stalled partial deletion would leave orphan events
      // with no index entry.  These can be detected by scanning mall user
      // collections that have no matching usersIndex entry (an admin task,
      // not something getUserById should enforce).
      return null;
    }
    const user = new User({
      id: userId,
      username,
      events: userAccountEvents
    });
    return user;
  }

  async usernameExists (username: string) {
    return await this.usersIndex.usernameExists(username);
  }

  /**
   * Platform-wide username existence: true when the name is held on THIS core
   * (local index, aliases included) OR, on a multi-core platform, on ANY other
   * core (via the shared `user-core/` mapping). Single-core reduces to the
   * local check by construction (the platform arm is gated on `!isSingleCore`),
   * so single-core behaviour is byte-identical to {@link usernameExists}.
   *
   * Use this for "is this name free to register anywhere on the platform"
   * questions (check_username, registration validation, the reservation
   * endpoint, change-username availability). Keep {@link usernameExists} for
   * local-data questions ("does THIS core host the user"): notably
   * {@link insertOne}'s guard MUST stay per-core, because registration has
   * already claimed this name's `user-core/` row by the time insertOne runs, so
   * a platform-wide check there would reject every legitimate registration.
   */
  async usernameExistsOnPlatform (username: string): Promise<boolean> {
    if (await this.usersIndex.usernameExists(username)) return true;
    if (this.platform.isSingleCore) return false;
    return (await this.platform.getUserCore(username)) != null;
  }

  async getUserByUsername (username: string) {
    const userId = await this.getUserIdForUsername(username);
    if (userId) {
      const user = await this.getUserById(userId);
      return user;
    }
    return null;
  }

  async getStorageUsedByUserId (userId: string) {
    return {
      dbDocuments: (await this.getOnePropertyValue(userId, 'dbDocuments')) || 0,
      attachedFiles: (await this.getOnePropertyValue(userId, 'attachedFiles')) || 0
    };
  }

  async getOnePropertyValue (userId: string, propertyKey: string) {
    const query = {
      limit: 1,
      state: 'all',
      streams: [
        {
          any: [
            accountStreams.toStreamId(propertyKey)
          ]
        }
      ]
    };
    const userAccountEvents = await this.mall.events.get(userId, query);
    if (!userAccountEvents || !userAccountEvents[0]) { return null; }
    return userAccountEvents[0].content;
  }

  async createSessionForUser (username: string, appId: string, transactionSession: unknown) {
    return await fromCallback((cb: (err: Error | null, value?: unknown) => void) => this.sessionsStorage.generate({ username, appId }, { transactionSession }, cb));
  }

  async createPersonalAccessForUser (userId: string, token: string, appId: string, transactionSession: unknown) {
    const accessData = {
      token,
      name: appId,
      type: UserRepositoryOptions.ACCESS_TYPE_PERSONAL,
      created: timestamp.now(),
      createdBy: UserRepositoryOptions.SYSTEM_USER_ACCESS_ID,
      modified: timestamp.now(),
      modifiedBy: UserRepositoryOptions.SYSTEM_USER_ACCESS_ID
    };
    // NOTE: the former 4th `{ transactionSession }` argument was a mongo-era
    // vestige — no baseStorage engine ever read it after the mongo removal.
    return await fromCallback((cb: (err: Error | null, value?: unknown) => void) => this.accessStorage.insertOne({ id: userId }, accessData, cb));
  }

  validateAllStorageObjectsInitialized () {
    if (this.accessStorage == null || this.sessionsStorage == null) {
      throw new Error('Please initialize the user repository with all dependencies.');
    }
    return true;
  }

  async insertOne (user: UserData, withSession = false) {
    // Create the User at a Platform Level
    const operations: Operation[] = [];
    for (const key of accountStreams.indexedFieldNames) {
      // use default value is null;
      const value = user[key] != null
        ? user[key]
        : accountStreams.accountMap[':_system:' + key]?.default;
      if (value != null) {
        operations.push({
          action: 'create',
          key,
          // Indexed account-field values are strings (system-streams config).
          value: value as string,
          isUnique: accountStreams.uniqueFieldNames.includes(key),
          isActive: true
        });
      }
    }
    // check locally for username. MUST stay per-core (usersIndex, not the
    // platform-wide check): validateRegistration has already claimed this
    // name's `user-core/` row for this core by the time insertOne runs, so a
    // platform-wide check here would reject every legitimate registration.
    if (await this.usersIndex.usernameExists(user.username)) {
      // gather eventual other uniqueness conflicts
      const eventualPlatformUniquenessErrors = await this.platform.checkUpdateOperationUniqueness(user.username, operations);
      const uniquenessError = errors.itemAlreadyExists('user', eventualPlatformUniquenessErrors);
      uniquenessError.data.username = user.username;
      throw uniquenessError;
    }
    // could throw uniqueness errors
    await this.platform.updateUser(user.username, operations);
    try {
      await this.createLocalUserData(user, withSession);
    } catch (err) {
      // Compensation: the platform reservation (unique/indexed fields) was
      // written first — cross-core uniqueness requires it — so a failure on
      // the local side must take it back, along with any partially-created
      // local data. Orphaned platform rows block re-registration of the
      // same unique values and desync platform vs repository.
      await this.compensateFailedInsert(user);
      throw err;
    }
    // TODO(B-2026-05-27-5, 2026-05-27): re-enable CMC reserved-parent
    // auto-provisioning here. Lazy creation at first :_cmc:* write
    // keeps the operational impact contained for now.
    if (cmc != null && cmcLogger != null) { /* placeholder */ }
    return user;
  }

  /** @private — local (single-core) part of insertOne */
  async createLocalUserData (user: UserData, withSession: boolean) {
    const mallTransaction = await this.mall.newTransaction();
    // Invariant: the local store always provides a transaction.
    const localTransaction = (await mallTransaction.getStoreTransaction('local'))!;
    let createdAccess: { id?: unknown; type?: unknown; created?: unknown; modified?: unknown } | null = null;
    await localTransaction.exec(async () => {
      let accessId = UserRepositoryOptions.SYSTEM_USER_ACCESS_ID;
      if (withSession &&
                this.validateAllStorageObjectsInitialized() &&
                user.appId != null) {
        const token = await this.createSessionForUser(user.username, user.appId as string, localTransaction.transactionSession) as string;
        const access = await this.createPersonalAccessForUser(user.id, token, user.appId as string, localTransaction.transactionSession) as { id: string; token: string };
        accessId = access?.id;
        user.token = access.token;
        createdAccess = access;
      }
      user.accessId = accessId;
      // add the user to local index
      await this.usersIndex.addUser(user.username, user.id);
      // Store account fields directly in userAccountStorage (Platform already called above)
      const accountData = (user.getFullAccount as () => Record<string, unknown>)();
      const accountLeavesMap = accountStreams.accountLeavesMap;
      const now = timestamp.now();
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- system-streams map entries; typed in the interface-IO follow-up
      for (const [streamId, stream] of Object.entries(accountLeavesMap) as Array<[string, any]>) {
        const fieldName = accountStreams.toFieldName(streamId);
        const value = accountData[fieldName] != null
          ? accountData[fieldName]
          : stream.default;
        if (value != null) {
          await this.userAccountStorage.setAccountField(user.id, fieldName, value, accessId, now);
        }
      }
      // set user password
      if (user.passwordHash) {
        // if passwordHash was provided directly (via system.createUser)
        await this.userAccountStorage.addPasswordHash(user.id, user.passwordHash as string, user.accessId as string);
      } else {
        // regular user creation
        await this.setUserPassword(user.id, user.password!, user.accessId as string);
      }
    });
    // Populate the breach-scope reverse-index AFTER the local transaction
    // commits (so a rollback can't orphan an index row). Non-fatal.
    if (createdAccess != null) {
      await reindexAccessNonFatal(user.username, createdAccess);
    }
  }

  /**
   * @private — best-effort removal of everything insertOne may have
   * persisted before failing (mirrors deleteOne's order). Cleanup errors
   * are logged, not thrown: the original failure must surface.
   */
  async compensateFailedInsert (user: UserData) {
    const cleanups: Array<[string, () => Promise<unknown>]> = [
      ['usersIndex', async () => { await this.usersIndex.init(); await this.usersIndex.deleteById(user.id); }],
      ['cache', async () => cache.unsetUser(user.username)],
      ['platform', async () => await this.platform.deleteUser(user.username, user)],
      // Free the name→core claim validateRegistration made for this name, but
      // ONLY if no local user now owns it (B3): a concurrent same-name winner
      // reached the local index, so its routing row must survive. Runs after
      // the usersIndex cleanup above, so this failed registration's own index
      // row (if any) is already gone and the guard reflects the winner alone.
      ['user-core', async () => {
        if (!(await this.usersIndex.usernameExists(user.username))) {
          await this.platform.deleteUserCore(user.username);
        }
      }],
      ['mall', async () => await this.mall.deleteUser(user.id)]
    ];
    for (const [what, cleanup] of cleanups) {
      try {
        await cleanup();
      } catch (cleanupErr) {
        logger.warn(`user creation rollback: ${what} cleanup failed for "${user.username}"`, cleanupErr);
      }
    }
  }

  async updateOne (user: UserData, update: Partial<UserData>, accessId: string) {
    // change password into hash if it exists
    if (update.password) {
      await this.setUserPassword(user.id, update.password, accessId);
    }
    delete update.password;
    // Start a transaction session
    const mallTransaction = await this.mall.newTransaction();
    // Invariant: the local store always provides a transaction.
    const localTransaction = (await mallTransaction.getStoreTransaction('local'))!;
    const modifiedTime = timestamp.now();
    await localTransaction.exec(async () => {
      // update all account streams and don't allow additional properties
      for (const [streamIdWithoutPrefix, content] of Object.entries(update)) {
        const query = {
          streams: [
            {
              any: [
                accountStreams.toStreamId(streamIdWithoutPrefix)
              ]
            }
          ]
        };
        const updateFields = {
          content,
          modified: modifiedTime,
          modifiedBy: accessId
        };
        await this.mall.events.updateMany(user.id, query, { fieldsToSet: updateFields }, null, mallTransaction);
      }
    });
  }

  async deleteOne (userId: string, username: string) {
    // Fetch user object BEFORE any deletions — platform.deleteUser needs it
    // for unique field cleanup (e.g. email).
    const user = await this.getUserById(userId);
    if (username == null) {
      username = user?.username;
    }
    // Delete index FIRST so that getAll() never lists a user whose data is
    // being deleted.  The reverse race (index gone but events still exist)
    // is handled by getUserById() returning null when username is null.
    await this.usersIndex.init();
    // Enumerate aliases BEFORE deleteById wipes the alias index — needed to
    // release each alias's name→core routing row + evict its cache entry.
    const aliases = await this.usersIndex.getAliasesForId(userId);
    await this.usersIndex.deleteById(userId);
    if (username != null) {
      cache.unsetUser(username);
      await this.platform.deleteUser(username, user);
      // Free the name→core routing rows so the released name (and each alias)
      // reports available again on EVERY core. platform.deleteUser leaves these
      // behind: it matches rows by username, but `user-core/` rows carry no
      // username. Ungated on single-core (registration writes the canonical
      // row there too); no B3 guard needed since the index entry is already
      // gone above.
      await this.platform.deleteUserCore(username);
      for (const alias of aliases) {
        await this.platform.deleteUserCore(alias);
        cache.unsetUser(alias);
      }
      // Breach-scope reverse-index cleanup (Art.17). The index is keyed by
      // accessId, so it is not covered by platform.deleteUser (keyed by user);
      // clean it explicitly. Default deletes the user's rows; `keep` mode
      // tombstones them (strip username) so a late breach can still confirm the
      // accessId belonged to a since-erased account. Non-fatal.
      const keepMode = ((await getConfig()).get('audit:onUserDelete') as string) === 'keep';
      await cleanupUserAccessIndexNonFatal(this.platform, username, keepMode);
    }
    await this.mall.deleteUser(userId);
  }

  async count () {
    const users = await this.usersIndex.getAllByUsername();
    return Object.keys(users).length;
  }

  /**
   * Reconcile THIS core's slice of the shared name→core (`user-core/`) map with
   * its local user index. Multi-core maintenance that heals the two drift
   * states the platform-wide username check is sensitive to:
   *  - STALE self-row (points at THIS core but no local user/alias owns the
   *    name) → delete, so a deleted/never-created name reports free again and
   *    stops falsely reserving itself platform-wide;
   *  - MISSING self-row (a local user/alias has no routing row) → recreate it
   *    (claim-or-confirm), so the live name cannot be hijacked by another core
   *    and stays routable.
   * Rows pointing at OTHER cores are NEVER touched — each core owns only its own
   * slice. Single-core is a no-op (the platform-wide check ignores the map).
   * Works in both piiModes: local names are hashed to the storage-form token
   * via `platform.hashFor` for comparison, exactly as user-core keys are stored.
   * Idempotent; safe to run repeatedly and concurrently with live traffic
   * (healing uses the atomic claim; stale deletion is guarded on ownership).
   *
   * @param dryRun when true, computes the summary without writing.
   * @returns { deleted, healed, conflicts, scanned, skippedOtherCore } —
   *   `deleted`/`healed` are the affected name TOKENS (storage form; opaque HMAC
   *   in hashed mode). `conflicts` names each local user/alias whose routing row
   *   points at ANOTHER core (owned locally but claimed elsewhere): the tool will
   *   NOT clobber it, so the operator must resolve it by hand. Reported in both
   *   dry-run and apply so the two agree (a conflict is never counted as a heal).
   */
  async reconcileUserCoreMap (dryRun = false): Promise<{ deleted: string[]; healed: string[]; conflicts: Array<{ username: string; coreId: string }>; scanned: number; skippedOtherCore: number }> {
    const summary = { deleted: [] as string[], healed: [] as string[], conflicts: [] as Array<{ username: string; coreId: string }>, scanned: 0, skippedOtherCore: 0 };
    if (this.platform.isSingleCore) return summary;
    const selfCoreId = this.platform.coreId;

    // Build this core's owned name tokens (canonical usernames + aliases) in the
    // SAME storage form as `user-core/` keys (HMAC token in hashed mode).
    const byUsername = await this.usersIndex.getAllByUsername(); // { username: userId }
    const ownedTokens = new Set<string>();
    for (const username of Object.keys(byUsername)) {
      ownedTokens.add(this.platform.hashFor('username', username));
    }
    for (const userId of Object.values(byUsername)) {
      for (const alias of await this.usersIndex.getAliasesForId(userId)) {
        ownedTokens.add(this.platform.hashFor('username', alias));
      }
    }

    // (i) delete stale self-rows; heal missing self-rows in one pass over the map.
    const allMappings = await this.platform.getAllUserCores(); // { username: token, coreId }
    const presentSelfTokens = new Set<string>();
    const tokenToCore = new Map<string, string>(); // token -> owning coreId (any core)
    for (const { username: token, coreId } of allMappings) {
      tokenToCore.set(token, coreId);
      summary.scanned++;
      if (coreId !== selfCoreId) { summary.skippedOtherCore++; continue; }
      presentSelfTokens.add(token);
      if (!ownedTokens.has(token)) {
        if (!dryRun) await this.platform.deleteUserCoreByPreHashedUsername(token);
        summary.deleted.push(token);
      }
    }

    // (ii) recreate missing self-rows for every owned name (claim-or-confirm, so
    //      a name a DIFFERENT core legitimately holds is left alone — a name
    //      genuinely owned locally but claimed elsewhere is a conflict the
    //      operator must resolve, not something to silently overwrite).
    for (const username of Object.keys(byUsername)) {
      const token = this.platform.hashFor('username', username);
      if (presentSelfTokens.has(token)) continue;
      const mappedCore = tokenToCore.get(token);
      if (mappedCore != null && mappedCore !== selfCoreId) {
        // Owned locally but the map routes it elsewhere — a genuine conflict the
        // operator must resolve. Never clobber another core's claim.
        summary.conflicts.push({ username, coreId: mappedCore });
        continue;
      }
      if (!dryRun) {
        const claimed = await this.platform.setUserCoreIfNotExists(username, selfCoreId);
        if (!claimed) {
          // Raced: another core claimed the name between the scan and the claim.
          summary.conflicts.push({ username, coreId: (await this.platform.getUserCore(username)) ?? 'unknown' });
          continue;
        }
      }
      summary.healed.push(token);
    }
    for (const userId of Object.values(byUsername)) {
      for (const alias of await this.usersIndex.getAliasesForId(userId)) {
        const token = this.platform.hashFor('username', alias);
        if (presentSelfTokens.has(token)) continue;
        const mappedCore = tokenToCore.get(token);
        if (mappedCore != null && mappedCore !== selfCoreId) {
          summary.conflicts.push({ username: alias, coreId: mappedCore });
          continue;
        }
        if (!dryRun) {
          const claimed = await this.platform.setUserCoreIfNotExists(alias, selfCoreId);
          if (!claimed) {
            summary.conflicts.push({ username: alias, coreId: (await this.platform.getUserCore(alias)) ?? 'unknown' });
            continue;
          }
        }
        summary.healed.push(token);
      }
    }
    return summary;
  }

  // -------------------- Password Management ------------------- //

  async checkUserPassword (userId: string, password: string) {
    const currentPass = await this.userAccountStorage.getPasswordHash(userId);
    let isValid = false;
    if (currentPass != null) {
      isValid = await encryption.compare(password, currentPass);
    }
    return isValid;
  }

  /**
   * @param userId  undefined
   * @param password  undefined
   */
  async setUserPassword (userId: string, password: string, accessId = 'system', modifiedTime?: number) {
    const passwordHash = await encryption.hash(password);
    await this.userAccountStorage.addPasswordHash(userId, passwordHash, accessId, modifiedTime);
  }
}

let usersRepository: UsersRepository | null = null;
let usersRepositoryInitializing = false;

async function getUsersRepository () {
  // eslint-disable-next-line no-unmodified-loop-condition
  while (usersRepositoryInitializing) {
    await setTimeout(100);
  }
  if (!usersRepository) {
    await accountStreams.init();
    usersRepositoryInitializing = true;
    usersRepository = new UsersRepository();
    await usersRepository.init();
    usersRepositoryInitializing = false;
  }
  return usersRepository;
}
