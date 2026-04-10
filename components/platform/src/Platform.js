/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */

const crypto = require('crypto');

const { getLogger, getConfig } = require('@pryv/boiler');
const logger = getLogger('platform');

const errors = require('errors').factory;
const ErrorIds = require('errors/src/ErrorIds');
const ErrorMessages = require('errors/src/ErrorMessages');

const accountStreams = require('business/src/system-streams');

const getPlatformDB = require('./getPlatformDB');

const platformCheckIntegrity = require('./platformCheckIntegrity');

const reservedWords = new Set(require('./reserved-words.json').list);

/**
 * @class Platform
 * @property {Users} users
 */
class Platform {
  #initialized;
  #db;
  #config;
  // Plan 27 Phase 2: in-memory cache of coreId → public URL.
  // Populated by `_refreshCoreUrlCache()` from PlatformDB on init() and refreshed
  // periodically. Lets `coreIdToUrl()` stay synchronous while honoring explicit
  // `core.url` overrides set by other cores in DNSless multi-core deployments.
  #coreUrlCache;

  constructor () {
    this.#initialized = false;
    this.#coreUrlCache = new Map();
  }

  async init () {
    if (this.#initialized) {
      logger.warn('Platform already initialized, skipping');
      return this;
    }

    this.initialized = true; // intentionally public — see original code note
    this.#config = await getConfig();
    this.#db = await getPlatformDB();

    // Register this core in PlatformDB so other cores can discover it
    await this.registerSelf();

    // Plan 27 Phase 2: load all known core URLs into the in-memory cache so
    // `coreIdToUrl()` can answer synchronously even when explicit `core.url`
    // overrides are in play (DNSless multi-core).
    await this._refreshCoreUrlCache();

    // Seed invitation tokens from config into PlatformDB (if not already present)
    await this.#seedInvitationTokens();

    return this;
  }

  async checkIntegrity () {
    return await platformCheckIntegrity(this.#db);
  }

  // for tests only - called by repository
  async deleteAll () {
    await this.#db.deleteAll();
  }

  /**
   * Get if value exists for this unique key
   */
  async getUsersUniqueField (field, value) {
    return await this.#db.getUsersUniqueField(field, value);
  }

  /**
   * Check uniqueness of operations against PlatformDB.
   * Used by repository.insertOne to gather all conflicts before throwing.
   */
  async checkUpdateOperationUniqueness (username, operations) {
    const uniquenessErrors = {};
    for (const op of operations) {
      if (op.action !== 'delete' && op.isUnique) {
        const value = await this.#db.getUsersUniqueField(op.key, op.value);
        if (value != null && value !== username) uniquenessErrors[op.key] = op.value;
      }
    }
    return uniquenessErrors;
  }

  /**
   * Update user fields in PlatformDB (unique + indexed).
   * @param {string} username
   * @param {Array} operations
   */
  async updateUser (username, operations) {
    const uniquenessErrors = await this.checkUpdateOperationUniqueness(username, operations);
    if (Object.keys(uniquenessErrors).length > 0) {
      throw (errors.itemAlreadyExists('user', uniquenessErrors));
    }
    await this.#applyOperations(username, operations);
  }

  /**
   * Apply operations to PlatformDB.
   * @param {string} username
   * @param {Array} operations
   */
  async #applyOperations (username, operations) {
    for (const op of operations) {
      switch (op.action) {
        case 'create':
          if (op.isUnique) {
            if (!op.isActive) break;
            const potentialCollisionUsername = await this.#db.getUsersUniqueField(op.key, op.value);
            if (potentialCollisionUsername !== null && potentialCollisionUsername !== username) {
              throw (errors.itemAlreadyExists('user', { [op.key]: op.value }));
            }
            await this.#db.setUserUniqueField(username, op.key, op.value);
          } else {
            await this.#db.setUserIndexedField(username, op.key, op.value);
          }
          break;

        case 'update':
          if (!op.isActive) break;
          if (op.isUnique) {
            const existingUsernameValue = await this.#db.getUsersUniqueField(op.key, op.previousValue);
            if (existingUsernameValue !== null && existingUsernameValue === username) {
              await this.#db.deleteUserUniqueField(op.key, op.previousValue);
            }

            const potentialCollisionUsername = await this.#db.getUsersUniqueField(op.key, op.value);
            if (potentialCollisionUsername !== null && potentialCollisionUsername !== username) {
              throw (errors.itemAlreadyExists('user', { [op.key]: op.value }));
            }
            await this.#db.setUserUniqueField(username, op.key, op.value);
          } else {
            await this.#db.setUserIndexedField(username, op.key, op.value);
          }
          break;

        case 'delete':
          if (op.isUnique) {
            const existingValue = await this.#db.getUsersUniqueField(op.key, op.value);
            if (existingValue !== null && existingValue !== username) {
              throw (errors.forbidden('unique field ' + op.key + ' with value ' + op.value + ' is associated to another user'));
            }
            if (existingValue != null) {
              await this.#db.deleteUserUniqueField(op.key, op.value);
            }
          } else {
            await this.#db.deleteUserIndexedField(username, op.key);
          }
          break;

        default:
          throw new Error('Unknown action');
      }
    }
  }

  /**
   * Fully delete a user from PlatformDB.
   * @param {string} username
   * @param {User|null} user
   */
  async deleteUser (username, user) {
    const operations = [];
    for (const field of accountStreams.uniqueFieldNames) {
      // Get value from user object if available, otherwise look it up in PlatformDB
      let value = user?.[field];
      if (value == null) {
        value = await this.#db.getUserIndexedField(username, field);
      }
      if (value != null) {
        operations.push({ action: 'delete', key: field, value, isUnique: true });
      }
    }

    for (const field of accountStreams.indexedFieldNames) {
      operations.push({ action: 'delete', key: field, isUnique: false });
    }

    await this.#applyOperations(username, operations);
  }

  // ----------------  Core identity (multi-core)  ----------------

  /**
   * @returns {string} This core's ID.
   */
  get coreId () {
    return this.#config.get('core:id') || 'single';
  }

  /**
   * @returns {string|null} This core's public URL.
   */
  get coreUrl () {
    return this.#config.get('core:url') || null;
  }

  /**
   * @returns {boolean} True when in dnsLess / single-core mode.
   */
  get isSingleCore () {
    return this.#config.get('core:isSingleCore') !== false;
  }

  /**
   * @returns {string|null} The primary domain (dns:domain).
   */
  get domain () {
    return this.#config.get('dns:domain') || null;
  }

  /**
   * Build the public URL for a core given its ID.
   *
   * Resolution order:
   *  1. In-memory cache populated from PlatformDB core info (`url` field) — set
   *     by other cores via `registerSelf()` when they have an explicit `core.url`.
   *  2. Derivation from `core.id + dns.domain` (legacy multi-core).
   *  3. Self URL (single-core / fallback).
   *
   * Stays synchronous so existing call sites (~10 across api-server) don't need
   * a cascade rewrite. The cache is refreshed on `init()` and via
   * `_refreshCoreUrlCache()` (called from this core after `registerSelf()`).
   *
   * @param {string} coreId
   * @returns {string}
   */
  coreIdToUrl (coreId) {
    if (this.#coreUrlCache.has(coreId)) {
      return this.#coreUrlCache.get(coreId);
    }
    const domain = this.domain;
    if (domain != null) {
      return 'https://' + coreId + '.' + domain;
    }
    // dnsLess fallback: return own URL
    return this.coreUrl;
  }

  /**
   * Reload the coreId → URL cache from PlatformDB. Idempotent.
   * Adds an entry only when a core info row carries an explicit `url` —
   * empty url means "fall through to derivation" so a core with neither an
   * override nor a domain doesn't poison the cache with `null`.
   */
  async _refreshCoreUrlCache () {
    const cores = await this.#db.getAllCoreInfos();
    const fresh = new Map();
    for (const info of cores) {
      if (info && info.id && info.url) {
        fresh.set(info.id, info.url);
      }
    }
    this.#coreUrlCache = fresh;
  }

  /**
   * Register this core in PlatformDB on startup.
   * Other cores will discover it via getAllCoreInfos().
   * Includes `url` so DNSless multi-core deployments can advertise an
   * explicit core URL that other cores resolve via the in-memory cache.
   */
  async registerSelf () {
    const info = {
      id: this.coreId,
      url: this.coreUrl || null, // Plan 27 Phase 2: advertise explicit URL
      ip: this.#config.get('core:ip') || null,
      ipv6: this.#config.get('core:ipv6') || null,
      cname: this.#config.get('core:cname') || null,
      hosting: this.#config.get('core:hosting') || null,
      available: this.#config.get('core:available') !== false
    };
    await this.#db.setCoreInfo(this.coreId, info);
    // Refresh the in-memory coreId→URL cache so this core's own entry is
    // visible immediately. NOTE: cache stays cold for changes made by OTHER
    // cores until the next init() — periodic refresh for dynamic cluster
    // membership is tracked in PLATFORM-WIDE-CONFIG-MIGRATION.md follow-up.
    await this._refreshCoreUrlCache();

    // Plan 27 Phase 2b: log this core's observed values for known platform-wide
    // config keys so operators can compare across cores and detect drift. A full
    // PlatformDB-backed `platform_config` table with live drift warnings is
    // targeted as a Plan 27 follow-up — see
    // `_plans/27-pre-open-pryv-merge-atwork/CONFIG-SEPARATION.md`.
    const platformWideSnapshot = {
      'dns.domain': this.#config.get('dns:domain') || null,
      'integrity.algorithm': this.#config.get('integrity:algorithm') || null,
      'versioning.deletionMode': this.#config.get('versioning:deletionMode') || null,
      'uploads.maxSizeMb': this.#config.get('uploads:maxSizeMb') || null
    };
    // `auth.adminAccessKey` is a secret and stays YAML-only (bootstrap category).
    // We log only a SHA-256 hash so operators can compare hashes across cores to
    // detect drift without the secret ever appearing in logs.
    const adminKey = this.#config.get('auth:adminAccessKey');
    const adminKeyHash = adminKey
      ? crypto.createHash('sha256').update(String(adminKey)).digest('hex').slice(0, 16)
      : null;
    platformWideSnapshot['auth.adminAccessKey.sha256'] = adminKeyHash;
    logger.info('[platform-config-snapshot] coreId=' + this.coreId + ' ' +
      JSON.stringify(platformWideSnapshot) +
      ' — these values MUST be identical across cores in a multi-core deployment. ' +
      'Compare hashes across core logs to detect drift. See CONFIG-SEPARATION.md.');
  }

  /**
   * Get which core hosts a user.
   * @param {string} username
   * @returns {Promise<string|null>} core ID
   */
  async getUserCore (username) {
    return await this.#db.getUserCore(username);
  }

  /**
   * Set which core hosts a user.
   * @param {string} username
   * @param {string} coreId
   */
  async setUserCore (username, coreId) {
    await this.#db.setUserCore(username, coreId);
  }

  /**
   * Get all user-to-core mappings.
   * @returns {Promise<Array<{username: string, coreId: string}>>}
   */
  async getAllUserCores () {
    return await this.#db.getAllUserCores();
  }

  /**
   * Get info for a specific core.
   * @param {string} coreId
   * @returns {Promise<Object|null>}
   */
  async getCoreInfo (coreId) {
    return await this.#db.getCoreInfo(coreId);
  }

  /**
   * Get all registered cores.
   * @returns {Promise<Array<Object>>}
   */
  async getAllCoreInfos () {
    return await this.#db.getAllCoreInfos();
  }

  // --- Persistent DNS records (Plan 27 Phase 1) --- //

  /**
   * Set a persistent DNS record. Runtime-managed entries like ACME challenges.
   * Static infrastructure records stay in YAML config; admin MUST NOT shadow them.
   * @param {string} subdomain
   * @param {Object} records
   */
  async setDnsRecord (subdomain, records) {
    await this.#db.setDnsRecord(subdomain, records);
  }

  /**
   * @param {string} subdomain
   * @returns {Promise<Object|null>}
   */
  async getDnsRecord (subdomain) {
    return await this.#db.getDnsRecord(subdomain);
  }

  /**
   * @returns {Promise<Array<{subdomain: string, records: Object}>>}
   */
  async getAllDnsRecords () {
    return await this.#db.getAllDnsRecords();
  }

  /**
   * @param {string} subdomain
   */
  async deleteDnsRecord (subdomain) {
    await this.#db.deleteDnsRecord(subdomain);
  }

  /**
   * Update this core's availability in PlatformDB.
   * @param {boolean} available
   */
  async setAvailable (available) {
    const info = await this.#db.getCoreInfo(this.coreId);
    if (info != null) {
      info.available = available;
      await this.#db.setCoreInfo(this.coreId, info);
    }
  }

  /**
   * Select a core for a new registration.
   * Single-core: returns self. Multi-core: least-users among available cores in the given hosting.
   * @param {string|null} [hosting] - hosting key (null = any)
   * @returns {Promise<string>} core ID
   */
  async selectCoreForRegistration (hosting) {
    if (this.isSingleCore) return this.coreId;

    // Get all registered cores, filter by hosting + availability
    const allCores = await this.#db.getAllCoreInfos();
    let candidates = allCores.filter(c => c.available !== false);
    if (hosting != null) {
      candidates = candidates.filter(c => c.hosting === hosting);
    }
    if (candidates.length === 0) return this.coreId; // fallback to self
    if (candidates.length === 1) return candidates[0].id;

    // Count users per core
    const allMappings = await this.#db.getAllUserCores();
    const counts = {};
    for (const core of candidates) {
      counts[core.id] = 0;
    }
    for (const mapping of allMappings) {
      if (mapping.coreId && counts[mapping.coreId] != null) {
        counts[mapping.coreId]++;
      }
    }
    // Return core with fewest users
    let minCore = candidates[0].id;
    let minCount = Infinity;
    for (const [id, count] of Object.entries(counts)) {
      if (count < minCount) {
        minCount = count;
        minCore = id;
      }
    }
    return minCore;
  }

  // ----------------  Registration  ----------------

  /**
   * Validate a registration request locally:
   * - Check invitation token
   * - Check reserved usernames
   * - Check username existence
   * - Atomically reserve unique fields
   * - Assign user to core (multi-core: may redirect)
   *
   * @param {string} username
   * @param {string|undefined} invitationToken
   * @param {Object} uniqueFields - e.g. { username: 'bob', email: 'bob@example.com' }
   * @returns {Promise<{redirect?: string}>} redirect URL if registration should happen elsewhere
   */
  async validateRegistration (username, invitationToken, uniqueFields) {
    // 1. Check invitation token
    await this.#checkInvitationToken(invitationToken);

    // 2. Check reserved usernames
    if (this.#isUsernameReserved(username)) {
      throw errors.itemAlreadyExists('user', { username });
    }

    // 3. Check username existence (lazy require to avoid circular dependency)
    const { getUsersRepository } = require('business/src/users');
    const usersRepository = await getUsersRepository();
    if (await usersRepository.usernameExists(username)) {
      // Gather other eventual uniqueness conflicts for a complete error
      const allConflicts = { username };
      for (const [field, value] of Object.entries(uniqueFields)) {
        if (field === 'username') continue;
        const existingUsername = await this.#db.getUsersUniqueField(field, value);
        if (existingUsername != null) {
          allConflicts[field] = value;
        }
      }
      throw errors.itemAlreadyExists('user', allConflicts);
    }

    // 4. Atomically reserve unique fields (except username, handled by usersIndex)
    const conflicts = {};
    for (const [field, value] of Object.entries(uniqueFields)) {
      if (field === 'username') continue;
      if (value == null) continue;
      const success = await this.#db.setUserUniqueFieldIfNotExists(username, field, value);
      if (!success) {
        conflicts[field] = value;
      }
    }
    if (Object.keys(conflicts).length > 0) {
      throw errors.itemAlreadyExists('user', conflicts);
    }

    // 5. Assign user to a core
    const selectedCoreId = await this.selectCoreForRegistration();
    if (selectedCoreId != null) {
      await this.#db.setUserCore(username, selectedCoreId);
    }

    // 6. If selected core is not self, return redirect
    if (!this.isSingleCore && selectedCoreId !== this.coreId) {
      return { redirect: this.coreIdToUrl(selectedCoreId) };
    }
    return {};
  }

  /**
   * Check invitation token against PlatformDB.
   * - No tokens in PlatformDB AND null config → allow all (no check)
   * - Token exists and not consumed → valid
   * - Token missing or already consumed → invalid
   */
  async #checkInvitationToken (invitationToken) {
    const allTokens = await this.#db.getAllInvitationTokens();

    // No tokens in PlatformDB → check config fallback
    if (allTokens.length === 0) {
      const configTokens = this.#config.get('invitationTokens');
      // null/undefined config → allow all registrations
      if (configTokens == null) return;
      // empty array → block all
      if (Array.isArray(configTokens) && configTokens.length === 0) {
        throw errors.invalidOperation(ErrorMessages[ErrorIds.InvalidInvitationToken]);
      }
      // check token against static config list
      if (!Array.isArray(configTokens) || !configTokens.includes(invitationToken)) {
        throw errors.invalidOperation(ErrorMessages[ErrorIds.InvalidInvitationToken]);
      }
      return;
    }

    // PlatformDB has tokens — check against them
    const tokenInfo = await this.#db.getInvitationToken(invitationToken);
    if (tokenInfo == null || tokenInfo.consumedBy != null) {
      throw errors.invalidOperation(ErrorMessages[ErrorIds.InvalidInvitationToken]);
    }
  }

  /**
   * Consume an invitation token (mark as used).
   * @param {string} token
   * @param {string} username - the user who consumed it
   */
  async consumeInvitationToken (token, username) {
    const info = await this.#db.getInvitationToken(token);
    if (info == null) return; // static config token or no tokens — nothing to consume
    info.consumedAt = Date.now();
    info.consumedBy = username;
    await this.#db.updateInvitationToken(token, info);
  }

  /**
   * Check if invitation token is valid (for /access/invitationtoken/check).
   * @param {string} token
   * @returns {Promise<boolean>}
   */
  async isInvitationTokenValid (token) {
    const allTokens = await this.#db.getAllInvitationTokens();

    // No tokens in PlatformDB → check config fallback
    if (allTokens.length === 0) {
      const configTokens = this.#config.get('invitationTokens');
      if (configTokens == null) return true; // allow all
      if (Array.isArray(configTokens) && configTokens.length === 0) return false;
      return Array.isArray(configTokens) && configTokens.includes(token);
    }

    const tokenInfo = await this.#db.getInvitationToken(token);
    return tokenInfo != null && tokenInfo.consumedBy == null;
  }

  /**
   * Get all invitation tokens.
   * @returns {Promise<Array>}
   */
  async getAllInvitationTokens () {
    return this.#db.getAllInvitationTokens();
  }

  /**
   * Generate N new invitation tokens.
   * @param {number} count
   * @param {string} createdBy - admin username
   * @param {string} [description]
   * @returns {Promise<Array>} created tokens
   */
  async generateInvitationTokens (count, createdBy, description) {
    const crypto = require('node:crypto');
    const created = [];
    for (let i = 0; i < count; i++) {
      const token = crypto.randomBytes(4).toString('hex');
      const info = {
        createdAt: Date.now(),
        createdBy: createdBy || 'admin',
        description: description || ''
      };
      await this.#db.createInvitationToken(token, info);
      created.push({ id: token, ...info });
    }
    return created;
  }

  /**
   * Seed invitation tokens from config into PlatformDB on first boot.
   * Only seeds if PlatformDB has no tokens and config has a non-null list.
   */
  async #seedInvitationTokens () {
    const configTokens = this.#config.get('invitationTokens');
    if (configTokens == null || !Array.isArray(configTokens) || configTokens.length === 0) return;

    const existing = await this.#db.getAllInvitationTokens();
    if (existing.length > 0) return; // already seeded

    for (const token of configTokens) {
      await this.#db.createInvitationToken(token, {
        createdAt: Date.now(),
        createdBy: 'config-seed',
        description: 'Seeded from invitationTokens config'
      });
    }
  }

  /**
   * Check if username is reserved (starts with "pryv" or in reserved words list).
   * @param {string} username
   * @returns {boolean}
   */
  #isUsernameReserved (username) {
    const lower = username.toLowerCase();
    if (/^pryv/.test(lower)) return true;
    return reservedWords.has(lower);
  }
}

module.exports = new Platform();
