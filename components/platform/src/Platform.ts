/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */


import { createRequire } from 'node:module';
import type { PlatformDB, CoreInfo, DnsRecord } from '../../../storages/interfaces/platformStorage/PlatformDB.ts';
const require = createRequire(import.meta.url);

const crypto = require('crypto');

const { getLogger, getConfig } = require('@pryv/boiler');
const logger = getLogger('platform');
const AtRestEncryption = require('business/src/acme/AtRestEncryption.ts');

const errors = require('errors').factory;
const { ErrorIds } = require('errors/src/ErrorIds.ts');
const { ErrorMessages } = require('errors/src/ErrorMessages.ts');

const accountStreams = require('business/src/system-streams/index.ts');

const getPlatformDB = require('./getPlatformDB.ts').default;

const platformCheckIntegrity = require('./platformCheckIntegrity.ts').default;

const reservedWords = new Set(require('./reserved-words.json').list);

/**
 * @class Platform
 * @property {Users} users
 */
class Platform {
  #initialized: boolean;
  #db!: PlatformDB;
  #config!: Config;
  initialized: boolean = false;
  // In-memory cache of coreId → public URL.
  #coreUrlCache: Map<string, string>;

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
    if (!this.#db) {
      throw new Error('Platform.init: getPlatformDB() returned undefined. ' +
        'Call `await require("storages").init(config)` before getPlatform(); ' +
        'storages.platformDB is the singleton this class depends on.');
    }

    // Register this core in PlatformDB so other cores can discover it
    await this.registerSelf();

    // Load all known core URLs into the in-memory cache so
    // `coreIdToUrl()` can answer synchronously even when explicit
    // `core.url` overrides are in play (DNSless multi-core).
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
  async getUsersUniqueField (field: string, value: string) {
    return await this.#db.getUsersUniqueField(field, value);
  }

  /**
   * Check uniqueness of operations against PlatformDB.
   * Used by repository.insertOne to gather all conflicts before throwing.
   */
  async checkUpdateOperationUniqueness (username: string, operations: PlatformOperation[]) {
    const uniquenessErrors: Record<string, string> = {};
    for (const op of operations) {
      if (op.action !== 'delete' && op.isUnique) {
        const value = await this.#db.getUsersUniqueField(op.key, op.value as string);
        if (value != null && value !== username) uniquenessErrors[op.key] = op.value as string;
      }
    }
    return uniquenessErrors;
  }

  /**
   * Update user fields in PlatformDB (unique + indexed).
   */
  async updateUser (username: string, operations: PlatformOperation[]) {
    const uniquenessErrors = await this.checkUpdateOperationUniqueness(username, operations);
    if (Object.keys(uniquenessErrors).length > 0) {
      throw (errors.itemAlreadyExists('user', uniquenessErrors));
    }
    await this.#applyOperations(username, operations);
  }

  /**
   * Apply operations to PlatformDB.
   */
  async #applyOperations (username: string, operations: PlatformOperation[]) {
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
            const previousValue = op.previousValue ?? '';
            const existingUsernameValue = await this.#db.getUsersUniqueField(op.key, previousValue);
            if (existingUsernameValue !== null && existingUsernameValue === username) {
              await this.#db.deleteUserUniqueField(op.key, previousValue);
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
   *
   * Discovers what's actually present by enumerating all PlatformDB entries
   * for the username and deleting each. Robust to runtime changes in
   * `accountStreams.{uniqueFieldNames,indexedFieldNames}` — those are mutable
   * module-level bindings rebound by `reloadForTests` (see B-2026-05-29-2):
   * a fixture user created under one systemStreams config can be removed
   * under another without leaking the custom-field entries.
   *
   * The `user` arg is no longer load-bearing but kept on the signature for
   * backwards compatibility with existing callers.
   */
  async deleteUser (username: string, _user: unknown) {
    const entries = await this.#db.getAllWithPrefix('user');
    const operations: PlatformOperation[] = [];
    for (const entry of entries) {
      if (entry.username !== username) continue;
      if (entry.field == null || entry.field.startsWith('_')) continue;
      operations.push({
        action: 'delete',
        key: entry.field,
        value: entry.value,
        isUnique: entry.isUnique === true,
        isActive: true
      });
    }
    await this.#applyOperations(username, operations);
  }

  // ----------------  Core identity (multi-core)  ----------------

  get coreId (): string {
    return (this.#config.get('core:id') as string) || 'single';
  }

  get coreUrl (): string | null {
    return (this.#config.get('core:url') as string) || null;
  }

  get isSingleCore (): boolean {
    return this.#config.get('core:isSingleCore') !== false;
  }

  get domain (): string | null {
    return (this.#config.get('dns:domain') as string) || null;
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
   */
  coreIdToUrl (coreId: string): string {
    let url;
    if (this.#coreUrlCache.has(coreId)) {
      url = this.#coreUrlCache.get(coreId);
    } else {
      const domain = this.domain;
      if (domain != null) {
        url = 'https://' + coreId + '.' + domain;
      } else {
        url = this.coreUrl;
      }
    }
    return withTrailingSlash(url);
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
    if (!this.#db) {
      throw new Error('Platform.registerSelf: PlatformDB is not initialised. ' +
        'Call `await require("storages").init(config)` before getPlatform()/platform.init().');
    }
    const info: CoreInfo = {
      id: this.coreId,
      url: this.coreUrl || undefined, // advertise explicit URL for DNSless multi-core
      ip: (this.#config.get('core:ip') as string) || undefined,
      ipv6: (this.#config.get('core:ipv6') as string) || undefined,
      cname: (this.#config.get('core:cname') as string) || undefined,
      hosting: (this.#config.get('core:hosting') as string) || undefined,
      available: this.#config.get('core:available') !== false
    };
    await this.#db.setCoreInfo(this.coreId, info);
    // Refresh the in-memory coreId→URL cache so this core's own entry is
    // visible immediately. NOTE: cache stays cold for changes made by OTHER
    // cores until the next init() — periodic refresh for dynamic cluster
    // membership is tracked in PLATFORM-WIDE-CONFIG-MIGRATION.md follow-up.
    await this._refreshCoreUrlCache();

    const { snapshot, hash } = this.getPlatformConfigSnapshot();
    logger.info('[platform-config-snapshot] coreId=' + this.coreId +
      ' hash=' + hash + ' ' +
      JSON.stringify(snapshot) +
      ' — these values MUST be identical across cores in a multi-core deployment. ' +
      'Compare hashes across core logs to detect drift. See CONFIG-SEPARATION.md.');
  }

  /**
   * Build the deterministic snapshot of platform-wide config keys this core
   * observes. Mirrors the boot log so operators can cross-reference a
   * CLI read (e.g. `bin/observability.js show`) against the value
   * each core logs at startup. `auth.adminAccessKey` is surfaced only
   * as a short SHA-256 prefix — the secret itself never leaves config.
   *
   */
  getPlatformConfigSnapshot () {
    const snapshot: Record<string, unknown> = {
      'dns.domain': this.#config.get('dns:domain') || null,
      'integrity.algorithm': this.#config.get('integrity:algorithm') || null,
      'versioning.deletionMode': this.#config.get('versioning:deletionMode') || null,
      'uploads.maxSizeMb': this.#config.get('uploads:maxSizeMb') || null
    };
    const adminKey = this.#config.get('auth:adminAccessKey');
    snapshot['auth.adminAccessKey.sha256'] = adminKey
      ? crypto.createHash('sha256').update(String(adminKey)).digest('hex').slice(0, 16)
      : null;
    const hash = crypto
      .createHash('sha256')
      .update(JSON.stringify(snapshot))
      .digest('hex')
      .slice(0, 16);
    return { snapshot, hash };
  }

  /**
   * Get which core hosts a user.
   */
  async getUserCore (username: string) {
    return await this.#db.getUserCore(username);
  }

  /**
   * Set which core hosts a user.
   */
  async setUserCore (username: string, coreId: string) {
    await this.#db.setUserCore(username, coreId);
  }

  /**
   * Get all user-to-core mappings.
   */
  async getAllUserCores () {
    return await this.#db.getAllUserCores();
  }

  /**
   * Get info for a specific core.
   */
  async getCoreInfo (coreId: string) {
    return await this.#db.getCoreInfo(coreId);
  }

  /**
   * Get all registered cores.
   */
  async getAllCoreInfos () {
    return await this.#db.getAllCoreInfos();
  }

  // --- Persistent DNS records --- //

  /**
   * Set a persistent DNS record. Runtime-managed entries like ACME challenges.
   * Static infrastructure records stay in YAML config; admin MUST NOT shadow them.
   */
  async setDnsRecord (subdomain: string, records: DnsRecord) {
    await this.#db.setDnsRecord(subdomain, records);
  }

  async getDnsRecord (subdomain: string) {
    return await this.#db.getDnsRecord(subdomain);
  }

  async getAllDnsRecords () {
    return await this.#db.getAllDnsRecords();
  }

  async deleteDnsRecord (subdomain: string) {
    await this.#db.deleteDnsRecord(subdomain);
  }

  /**
   * Update this core's availability in PlatformDB.
   */
  async setAvailable (available: boolean) {
    if (!this.#db) {
      throw new Error('Platform.setAvailable: PlatformDB is not initialised (init() was not awaited).');
    }
    const info = await this.#db.getCoreInfo(this.coreId);
    if (info != null) {
      info.available = available;
      await this.#db.setCoreInfo(this.coreId, info);
    }
  }

  /**
   * Select a core for a new registration.
   * Single-core: returns self. Multi-core: least-users among available cores in the given hosting.
   * @param [hosting] - hosting key (null = any)
   */
  async selectCoreForRegistration (hosting: string | null): Promise<string> {
    if (this.isSingleCore) return this.coreId;

    // Get all registered cores, filter by hosting + availability
    const allCores = await this.#db.getAllCoreInfos();
    let candidates = allCores.filter((c: CoreInfo) => c.available !== false);
    if (hosting != null) {
      candidates = candidates.filter((c: CoreInfo) => c.hosting === hosting);
    }
    if (candidates.length === 0) return this.coreId; // fallback to self
    if (candidates.length === 1) return candidates[0].id;

    // Count users per core
    const allMappings = await this.#db.getAllUserCores();
    const counts: Record<string, number> = {};
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
   * @param uniqueFields - e.g. { username: 'bob', email: 'bob@example.com' }
   * @param [hosting] - hosting key from the registration payload;
   *   when set, narrows `selectCoreForRegistration` to that hosting so
   *   aws-us-east-1 registrations land on the correct core even if
   *   another hosting has fewer users.
   */
  async validateRegistration (username: string, invitationToken: string, uniqueFields: Record<string, string>, hosting: string | null) {
    // 1. Check invitation token
    await this.#checkInvitationToken(invitationToken);

    // 2. Check reserved usernames
    if (this.#isUsernameReserved(username)) {
      throw errors.itemAlreadyExists('user', { username });
    }

    // 3. Check username existence (lazy require to avoid circular dependency)
    const { getUsersRepository } = require('business/src/users/index.ts');
    const usersRepository = await getUsersRepository();
    if (await usersRepository.usernameExists(username)) {
      // Gather other eventual uniqueness conflicts for a complete error
      const allConflicts: Record<string, string> = { username };
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
    const conflicts: Record<string, string> = {};
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

    // 5. Assign user to a core (honour requested hosting so e.g.
    //    aws-us-east-1 registrations don't leak to aws-eu-central-1
    //    just because the latter happens to have fewer users).
    const selectedCoreId = await this.selectCoreForRegistration(hosting);
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
  async #checkInvitationToken (invitationToken: string) {
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
   * @param username - the user who consumed it
   */
  async consumeInvitationToken (token: string, username: string) {
    const info = await this.#db.getInvitationToken(token);
    if (info == null) return; // static config token or no tokens — nothing to consume
    info.consumedAt = Date.now();
    info.consumedBy = username;
    await this.#db.updateInvitationToken(token, info);
  }

  /**
   * Check if invitation token is valid (for /access/invitationtoken/check).
   */
  async isInvitationTokenValid (token: string) {
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
   */
  async getAllInvitationTokens () {
    return this.#db.getAllInvitationTokens();
  }

  /**
   * Generate N new invitation tokens.
   * @param createdBy - admin username
   * @param [description]
   */
  async generateInvitationTokens (count: number, createdBy: string, description: string) {
    const crypto = require('node:crypto');
    const created: Array<{ id: string; createdAt: number; createdBy: string; description: string }> = [];
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
   */
  #isUsernameReserved (username: string) {
    const lower = username.toLowerCase();
    if (/^pryv/.test(lower)) return true;
    return reservedWords.has(lower);
  }

  // --- Observability config (optional APM) ---------------------------

  /**
   * Build the effective observability config by merging:
   *   1. Defaults + local YAML override (under `observability:` in config).
   *   2. Cluster-wide values from PlatformDB (under `observability/<key>`).
   *   3. Derived fields: `hostname` from `new URL(core.url).hostname`,
   *      `appName` fallback to `dns.domain` when unset.
   *
   * Secrets (license keys) are at-rest-encrypted via `AtRestEncryption`
   * with HKDF-derived keys per provider. The source material is
   * `auth.adminAccessKey` — every cluster has one, and it's already
   * the operator-sync secret.
   *
   * Resolution rule: local `observability.enabled: false` ALWAYS wins
   * (emergency off-switch). Otherwise PlatformDB is authoritative.
   *
   *   enabled: boolean,
   *   provider: string,
   *   appName: string,
   *   logLevel: 'error' | 'warn' | 'info' | 'debug',
   *   hostname: string,
   *   newrelic: { licenseKey: string }
   * }>}
   */
  async getObservabilityConfig () {
    // `observability` config section — operator YAML overrides.
    type ObservabilityYaml = {
      enabled?: boolean;
      provider?: string;
      logLevel?: string;
      appName?: string;
      newrelic?: { licenseKey?: string };
    };
    const localYaml = (this.#config.get('observability') || {}) as ObservabilityYaml;
    const dbRows = await this.#db.getAllObservabilityValues();
    const db: Record<string, string> = {};
    for (const { key, value } of dbRows) {
      db[key] = value;
    }

    // Effective enabled: local-false wins; else use DB; else YAML; else false.
    let enabled;
    if (localYaml.enabled === false) {
      enabled = false;
    } else if (db.enabled != null) {
      enabled = parseJsonBoolean(db.enabled);
    } else {
      enabled = !!localYaml.enabled;
    }

    const provider = db.provider != null
      ? parseJsonString(db.provider)
      : (localYaml.provider || '');

    const logLevelRaw = db['log-level'] != null
      ? parseJsonString(db['log-level'])
      : (localYaml.logLevel || 'error');
    const logLevel = ['error', 'warn', 'info', 'debug'].includes(logLevelRaw) ? logLevelRaw : 'error';

    // appName: DB > local YAML > derived from dns.domain.
    let appName = db['app-name'] != null ? parseJsonString(db['app-name']) : (localYaml.appName || '');
    if (!appName) {
      const domain = this.#config.get('dns:domain');
      appName = domain ? 'open-pryv.io (' + domain + ')' : 'open-pryv.io';
    }

    // Hostname: derive from core.url if it's a URL; else fall back to
    // dns.domain (prefixed with "single.") or OS hostname as last resort.
    const hostname = this.#deriveHostname();

    // Decrypt provider secrets on demand — only if they exist AND the
    // operator hasn't set a local override in YAML.
    const newrelic = {
      licenseKey: localYaml.newrelic?.licenseKey ||
        await this.#decryptObservabilitySecret('newrelic-license-key', db['newrelic-license-key'])
    };

    return { enabled, provider, appName, logLevel, hostname, newrelic };
  }

  /**
   * Write a single observability PlatformDB row. Encrypts known-secret
   * keys at rest automatically.
   *
   * Callers (the `bin/observability.js` CLI) should invalidate the
   * cluster's in-memory cache after writing — e.g. via the
   * `/system/admin/observability/invalidate-cache` admin route.
   *
   * @param value — JSON-encodable.
   */
  async setObservabilityValue (key: string, value: unknown) {
    const serialised = SECRET_OBSERVABILITY_KEYS.has(key)
      ? await this.#encryptObservabilitySecret(key, value)
      : JSON.stringify(value);
    await this.#db.setObservabilityValue(key, serialised);
  }

  async deleteObservabilityValue (key: string) {
    await this.#db.deleteObservabilityValue(key);
  }

  #deriveHostname (): string {
    const coreUrl = this.#config.get('core:url') as string | undefined;
    if (coreUrl) {
      try {
        const h = new URL(coreUrl).hostname;
        if (h) return h;
      } catch { /* fall through */ }
    }
    const domain = this.#config.get('dns:domain') as string | undefined;
    if (domain) return 'single.' + domain;
    return require('os').hostname();
  }

  #getAtRestKey (purpose: string) {
    const adminKey = this.#config.get('auth:adminAccessKey');
    if (!adminKey) {
      throw new Error('observability: auth.adminAccessKey is required to derive at-rest key');
    }
    return AtRestEncryption.deriveKey(
      Buffer.from(adminKey as string, 'utf8'),
      purpose
    );
  }

  async #encryptObservabilitySecret (key: string, value: unknown) {
    const atRestKey = this.#getAtRestKey('observability-' + key);
    return AtRestEncryption.encrypt(Buffer.from(String(value), 'utf8'), atRestKey);
  }

  async #decryptObservabilitySecret (key: string, stored: string | null) {
    if (!stored) return '';
    try {
      const atRestKey = this.#getAtRestKey('observability-' + key);
      return AtRestEncryption.decrypt(stored, atRestKey).toString('utf8');
    } catch (err: unknown) {
      logger.warn('observability: failed to decrypt ' + key + ': ' + (err as Error).message);
      return '';
    }
  }
}

const SECRET_OBSERVABILITY_KEYS = new Set(['newrelic-license-key']);

// Service URLs in this codebase carry a trailing slash by convention
// (matches serviceInfo.{register,api,access}). Centralizing here so naive
// `url + 'users'` concatenation in clients/tests can't produce
// `https://single.example.devusers`.
function withTrailingSlash (url: string | null | undefined): string {
  if (url == null || url === '') return '';
  return url.endsWith('/') ? url : url + '/';
}

function parseJsonBoolean (raw: string): boolean {
  try { return JSON.parse(raw) === true; } catch { return false; }
}

function parseJsonString (raw: string): string {
  try {
    const v = JSON.parse(raw);
    return typeof v === 'string' ? v : '';
  } catch {
    // Tolerate raw strings written without JSON quoting.
    return typeof raw === 'string' ? raw : '';
  }
}

const platform = new Platform();
export default platform;
export { platform, Platform };

// Local type aliases for shapes that aren't formally exported by an interface.
type Config = { get (key: string): unknown };
type PlatformOperation = {
  action: 'create' | 'update' | 'delete';
  isUnique: boolean;
  isActive?: boolean;
  key: string;
  value: string;
  previousValue?: string;
};
