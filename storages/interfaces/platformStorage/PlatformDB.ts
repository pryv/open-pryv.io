/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */

export interface PlatformEntry {
  isUnique: boolean;
  field: string;
  username: string;
  value: string;
}

export interface AcmeAccount {
  accountKey: string;
  accountUrl: string;
  /** ACME contact; null when the account was registered without one */
  email: string | null;
}

export interface TlsCertificate {
  certPem: string;
  chainPem: string;
  keyPem: string;
  issuedAt: number;
  expiresAt: number;
}

export interface TlsCertificateSummary {
  hostname: string;
  issuedAt: number;
  expiresAt: number;
}

export interface CoreInfo {
  id: string;
  ip?: string;
  ipv6?: string;
  cname?: string;
  hosting?: string;
  available?: boolean;
  /**
   * The core's public base URL, written by `Platform.registerSelf()` only when
   * that core has an explicit `core.url` configured. Absent on a deployment
   * that lets the URL be derived from `core.id + dns.domain`, so a consumer
   * must never treat "no url here" as "unknown core" — resolve through
   * `Platform.coreIdToUrl()` instead.
   */
  url?: string;
  /**
   * Hosted-site names this core serves (`hostedSites` keys), written by
   * `Platform.registerSelf()` only when the core has some. The embedded DNS
   * answers a site name with the cores that list it; every core reserves the
   * names as usernames.
   */
  sites?: string[];
  [key: string]: unknown;
}

export interface UserCoreMapping {
  username: string;
  coreId: string;
}

export interface DnsRecord {
  txt?: string[];
  cname?: string;
  a?: string;
  aaaa?: string;
  [key: string]: unknown;
}

export interface DnsRecordEntry {
  subdomain: string;
  records: DnsRecord;
}

export interface MailTemplateEntry {
  type: string;
  lang: string;
  part: string;
  pug: string;
}

export interface ObservabilityEntry { key: string; value: string }

export interface AccessStateEntry { value: unknown; expiresAt: number }

export interface ExpiredAccessStateEntry { key: string; value: unknown }

export interface InvitationTokenInfo {
  createdAt: number;
  createdBy: string;
  description: string;
  consumedAt?: number;
  consumedBy?: string;
  // True when the row's KEY is the SHA-256 of the token rather than the token
  // itself. Set on every token written by a current core; used by the boot
  // migration to tell already-hashed rows from legacy raw-keyed ones. Not part
  // of the public listing (Platform.getAllInvitationTokens strips it).
  keyHashed?: boolean;
}

export interface InvitationTokenEntry extends InvitationTokenInfo {
  id: string;
}

/**
 * Result of `checkStoreIntegrity()`, read on THIS node's copy of the platform data.
 * A corrupted primary-key index raises no error by itself: upserts then
 * duplicate keys and lookups miss rows, so the duplicate scan reads the table
 * without that index.
 */
export interface PlatformIntegrityReport {
  ok: boolean;
  /** Engine structural check messages (`['ok']` when clean); null when the engine has none. */
  structural: string[] | null;
  /** Keys found more than once by a scan that bypasses the primary-key index. */
  duplicateKeys: Array<{ key: string; count: number }>;
}

export interface PlatformDB {
  init (): Promise<void>;

  // --- Unique / indexed user fields --------------------------------
  setUserUniqueField (username: string, field: string, value: string): Promise<void>;
  setUserUniqueFieldIfNotExists (username: string, field: string, value: string): Promise<boolean>;
  deleteUserUniqueField (field: string, value: string): Promise<void>;
  setUserIndexedField (username: string, field: string, value: string): Promise<void>;
  deleteUserIndexedField (username: string, field: string): Promise<void>;
  getUserIndexedField (username: string, field: string): Promise<string | null>;
  getUsersUniqueField (field: string, value: string): Promise<string | null>;
  getAllWithPrefix (prefix: string): Promise<PlatformEntry[]>;
  deleteAll (): Promise<void>;
  close (): Promise<void>;
  isClosed (): boolean;

  // --- Migration methods ------------------------------------------
  exportAll (): Promise<PlatformEntry[]>;
  importAll (data: PlatformEntry[]): Promise<void>;
  clearAll (): Promise<void>;

  // --- User-to-core mapping (multi-core) --------------------------
  setUserCore (username: string, coreId: string): Promise<void>;
  /**
   * ATOMIC claim-or-confirm: install `coreId` for `username` ONLY when no row
   * holds the key, in one linearized operation. Returns true when the surviving
   * row points at THIS `coreId` (this call won the claim, OR a pre-existing row
   * already pointed here — idempotent for retries and self-pointing rows),
   * false only when the key is held by a DIFFERENT core. Concurrent claimants
   * on different cores: exactly ONE gets true. Use this (not getUserCore +
   * setUserCore, which races, nor plain setUserCore, which overwrites) to
   * reserve a username against other cores during registration/rename.
   * Legitimate re-assignment (admin move, migration, restore) keeps using
   * setUserCore.
   */
  setUserCoreIfNotExists (username: string, coreId: string): Promise<boolean>;
  getUserCore (username: string): Promise<string | null>;
  deleteUserCore (username: string): Promise<void>;
  getAllUserCores (): Promise<UserCoreMapping[]>;

  // --- Core registration (multi-core) -----------------------------
  setCoreInfo (coreId: string, info: CoreInfo): Promise<void>;
  getCoreInfo (coreId: string): Promise<CoreInfo | null>;
  getAllCoreInfos (): Promise<CoreInfo[]>;

  // --- DNS records ------------------------------------------------
  setDnsRecord (subdomain: string, records: DnsRecord): Promise<void>;
  getDnsRecord (subdomain: string): Promise<DnsRecord | null>;
  getAllDnsRecords (): Promise<DnsRecordEntry[]>;
  deleteDnsRecord (subdomain: string): Promise<void>;

  // --- ACME account + TLS certs -----------------------------------
  setAcmeAccount (account: AcmeAccount): Promise<void>;
  getAcmeAccount (): Promise<AcmeAccount | null>;
  setCertificate (hostname: string, cert: TlsCertificate): Promise<void>;
  getCertificate (hostname: string): Promise<TlsCertificate | null>;
  listCertificates (): Promise<TlsCertificateSummary[]>;
  deleteCertificate (hostname: string): Promise<void>;

  // --- Observability config ---------------------------------------
  setObservabilityValue (key: string, value: string): Promise<void>;
  getObservabilityValue (key: string): Promise<string | null>;
  getAllObservabilityValues (): Promise<ObservabilityEntry[]>;
  deleteObservabilityValue (key: string): Promise<void>;

  // --- Mail templates ---------------------------------------------
  setMailTemplate (type: string, lang: string, part: string, pug: string): Promise<void>;
  getMailTemplate (type: string, lang: string, part: string): Promise<string | null>;
  getAllMailTemplates (): Promise<MailTemplateEntry[]>;
  deleteMailTemplate (type: string, lang: string, part?: string): Promise<void>;

  // --- Access-request state (cluster-wide ephemeral) --------------
  setAccessState (key: string, value: unknown, expiresAt: number): Promise<void>;
  /**
   * ATOMIC set-if-absent: install the value ONLY when no live entry
   * holds the key, in one linearized operation. Returns true when this
   * call installed the value (key absent, or held only an expired
   * entry — expired rows count as absent and are replaced), false when
   * a live entry exists (left untouched). Concurrent callers of the
   * same key: exactly ONE gets true. Use this (not getAccessState +
   * setAccessState, which races) for first-writer-wins state such as
   * single-use nonce/replay markers.
   */
  setAccessStateIfAbsent (key: string, value: unknown, expiresAt: number): Promise<boolean>;
  getAccessState (key: string): Promise<AccessStateEntry | null>;
  deleteAccessState (key: string): Promise<void>;
  /**
   * ATOMIC get-and-delete: return the entry AND delete it in one
   * linearized operation, or null if absent/expired. The single-use
   * primitive — concurrent consumers of the same key: exactly ONE gets
   * the entry, all others get null. Use this (not getAccessState +
   * deleteAccessState, which races) for single-use tokens.
   */
  consumeAccessState (key: string): Promise<AccessStateEntry | null>;
  sweepExpiredAccessStates (now?: number): Promise<{ removed: number }>;
  /**
   * Non-destructive listing of the EXPIRED access-state entries whose
   * (caller-facing) key starts with `prefix`. Returns each match's key and
   * parsed value — for callers that must act on an expired entry (e.g. revoke
   * a resource its payload points at) BEFORE the sweep removes it. Does NOT
   * delete anything; the sweep still owns removal. Malformed payloads are
   * skipped (the sweep drops them). The `prefix` must not contain SQL LIKE
   * wildcards.
   */
  listExpiredAccessStates (prefix: string, now?: number): Promise<ExpiredAccessStateEntry[]>;

  // --- Generic cluster-wide key-value (indefinite, no TTL) --------
  // For features that need string-keyed indefinite storage (no expiry,
  // no lazy-expire). For TTL'd ephemeral state, use setAccessState
  // above. Callers own their key-prefix conventions (e.g.
  // `oauth-client/<id>`); the engine treats keys as opaque strings.
  setPlatformKv (key: string, value: string): Promise<void>;
  getPlatformKv (key: string): Promise<string | null>;
  deletePlatformKv (key: string): Promise<void>;
  listPlatformKvKeys (prefix: string): Promise<string[]>;

  // --- Invitation tokens ------------------------------------------
  createInvitationToken (token: string, info: InvitationTokenInfo): Promise<void>;
  getInvitationToken (token: string): Promise<InvitationTokenInfo | null>;
  getAllInvitationTokens (): Promise<InvitationTokenEntry[]>;
  updateInvitationToken (token: string, info: InvitationTokenInfo): Promise<void>;
  deleteInvitationToken (token: string): Promise<void>;
  /** Atomically mark an unconsumed token consumed; false when it already was (or is missing). */
  claimInvitationToken (token: string, consumedBy: string, consumedAt: number): Promise<boolean>;
  /** Clear a claim made by `consumedBy` (no-op when someone else holds it). */
  releaseInvitationToken (token: string, consumedBy: string): Promise<void>;

  // Integrity (read-only)
  checkStoreIntegrity (): Promise<PlatformIntegrityReport>;
}

/**
 * PlatformDB prototype object.
 * Backend implementations (rqlite) inherit from this; tests can use
 * `validatePlatformDB` to verify class-based instances at boot.
 */
const PlatformDB: PlatformDB = {
  async init () { throw new Error('Not implemented'); },

  async setUserUniqueField (username: string, field: string, value: string): Promise<void> { throw new Error('Not implemented'); },

  async setUserUniqueFieldIfNotExists (username: string, field: string, value: string): Promise<boolean> { throw new Error('Not implemented'); },

  async deleteUserUniqueField (field: string, value: string): Promise<void> { throw new Error('Not implemented'); },

  async setUserIndexedField (username: string, field: string, value: string): Promise<void> { throw new Error('Not implemented'); },

  async deleteUserIndexedField (username: string, field: string): Promise<void> { throw new Error('Not implemented'); },

  async getUserIndexedField (username: string, field: string): Promise<string | null> { throw new Error('Not implemented'); },

  async getUsersUniqueField (field: string, value: string): Promise<string | null> { throw new Error('Not implemented'); },

  async getAllWithPrefix (prefix: string): Promise<PlatformEntry[]> { throw new Error('Not implemented'); },

  async deleteAll (): Promise<void> { throw new Error('Not implemented'); },

  async close (): Promise<void> { throw new Error('Not implemented'); },

  isClosed (): boolean { throw new Error('Not implemented'); },

  // --- Migration methods --- //

  async exportAll (): Promise<PlatformEntry[]> { throw new Error('Not implemented'); },

  async importAll (data: PlatformEntry[]): Promise<void> { throw new Error('Not implemented'); },

  async clearAll (): Promise<void> { throw new Error('Not implemented'); },

  // --- User-to-core mapping (multi-core) --- //

  async setUserCore (username: string, coreId: string): Promise<void> { throw new Error('Not implemented'); },

  async setUserCoreIfNotExists (username: string, coreId: string): Promise<boolean> { throw new Error('Not implemented'); },

  async getUserCore (username: string): Promise<string | null> { throw new Error('Not implemented'); },

  async deleteUserCore (username: string): Promise<void> { throw new Error('Not implemented'); },

  async getAllUserCores (): Promise<UserCoreMapping[]> { throw new Error('Not implemented'); },

  // --- Core registration (multi-core) --- //

  async setCoreInfo (coreId: string, info: CoreInfo): Promise<void> { throw new Error('Not implemented'); },

  async getCoreInfo (coreId: string): Promise<CoreInfo | null> { throw new Error('Not implemented'); },

  async getAllCoreInfos (): Promise<CoreInfo[]> { throw new Error('Not implemented'); },

  // --- DNS records --- //

  async setDnsRecord (subdomain: string, records: DnsRecord): Promise<void> { throw new Error('Not implemented'); },

  async getDnsRecord (subdomain: string): Promise<DnsRecord | null> { throw new Error('Not implemented'); },

  async getAllDnsRecords (): Promise<DnsRecordEntry[]> { throw new Error('Not implemented'); },

  async deleteDnsRecord (subdomain: string): Promise<void> { throw new Error('Not implemented'); },

  // --- ACME account + TLS certs --- //

  async setAcmeAccount (account: AcmeAccount): Promise<void> { throw new Error('Not implemented'); },

  async getAcmeAccount (): Promise<AcmeAccount | null> { throw new Error('Not implemented'); },

  async setCertificate (hostname: string, cert: TlsCertificate): Promise<void> { throw new Error('Not implemented'); },

  async getCertificate (hostname: string): Promise<TlsCertificate | null> { throw new Error('Not implemented'); },

  async listCertificates (): Promise<TlsCertificateSummary[]> { throw new Error('Not implemented'); },

  async deleteCertificate (hostname: string): Promise<void> { throw new Error('Not implemented'); },

  // --- Observability config --- //

  async setObservabilityValue (key: string, value: string): Promise<void> { throw new Error('Not implemented'); },

  async getObservabilityValue (key: string): Promise<string | null> { throw new Error('Not implemented'); },

  async getAllObservabilityValues (): Promise<ObservabilityEntry[]> { throw new Error('Not implemented'); },

  async deleteObservabilityValue (key: string): Promise<void> { throw new Error('Not implemented'); },

  // --- Mail templates --- //

  async setMailTemplate (type: string, lang: string, part: string, pug: string): Promise<void> { throw new Error('Not implemented'); },

  async getMailTemplate (type: string, lang: string, part: string): Promise<string | null> { throw new Error('Not implemented'); },

  async getAllMailTemplates (): Promise<MailTemplateEntry[]> { throw new Error('Not implemented'); },

  async deleteMailTemplate (type: string, lang: string, part?: string): Promise<void> { throw new Error('Not implemented'); },

  // --- Access-request state --- //

  async setAccessState (key: string, value: unknown, expiresAt: number): Promise<void> { throw new Error('Not implemented'); },

  async setAccessStateIfAbsent (key: string, value: unknown, expiresAt: number): Promise<boolean> { throw new Error('Not implemented'); },

  async getAccessState (key: string): Promise<AccessStateEntry | null> { throw new Error('Not implemented'); },

  async deleteAccessState (key: string): Promise<void> { throw new Error('Not implemented'); },

  async consumeAccessState (key: string): Promise<AccessStateEntry | null> { throw new Error('Not implemented'); },

  async sweepExpiredAccessStates (now?: number): Promise<{ removed: number }> { throw new Error('Not implemented'); },

  async listExpiredAccessStates (prefix: string, now?: number): Promise<ExpiredAccessStateEntry[]> { throw new Error('Not implemented'); },

  // --- Generic cluster-wide key-value --- //

  async setPlatformKv (key: string, value: string): Promise<void> { throw new Error('Not implemented'); },

  async getPlatformKv (key: string): Promise<string | null> { throw new Error('Not implemented'); },

  async deletePlatformKv (key: string): Promise<void> { throw new Error('Not implemented'); },

  async listPlatformKvKeys (prefix: string): Promise<string[]> { throw new Error('Not implemented'); },

  // --- Invitation tokens --- //

  async createInvitationToken (token: string, info: InvitationTokenInfo): Promise<void> { throw new Error('Not implemented'); },

  async getInvitationToken (token: string): Promise<InvitationTokenInfo | null> { throw new Error('Not implemented'); },

  async getAllInvitationTokens (): Promise<InvitationTokenEntry[]> { throw new Error('Not implemented'); },

  async updateInvitationToken (token: string, info: InvitationTokenInfo): Promise<void> { throw new Error('Not implemented'); },

  async deleteInvitationToken (token: string): Promise<void> { throw new Error('Not implemented'); },

  async claimInvitationToken (token: string, consumedBy: string, consumedAt: number): Promise<boolean> { throw new Error('Not implemented'); },

  async releaseInvitationToken (token: string, consumedBy: string): Promise<void> { throw new Error('Not implemented'); },

  async checkStoreIntegrity (): Promise<PlatformIntegrityReport> { throw new Error('Not implemented'); }
};

// Limit tampering on existing properties
for (const propName of Object.getOwnPropertyNames(PlatformDB)) {
  Object.defineProperty(PlatformDB, propName, { configurable: false });
}

const REQUIRED_METHODS: string[] = Object.getOwnPropertyNames(PlatformDB);

function validatePlatformDB (instance: unknown): PlatformDB {
  const inst = instance as Record<string, unknown>;
  for (const method of REQUIRED_METHODS) {
    if (typeof inst[method] !== 'function') {
      throw new Error(`PlatformDB implementation missing method: ${method}`);
    }
  }
  return inst as unknown as PlatformDB;
}

const MAX_LISTED = 10;

/**
 * Human-readable lines for a `checkStoreIntegrity()` report (CLI + boot log).
 * Lists at most MAX_LISTED structural messages and duplicated keys.
 */
function describePlatformIntegrity (report: PlatformIntegrityReport): string[] {
  if (report.ok) {
    return [report.structural == null
      ? 'OK (no duplicate keys; this engine has no structural check)'
      : 'OK (structure and keys)'];
  }
  const lines = ['FAILED'];
  if (report.structural != null && !(report.structural.length === 1 && report.structural[0] === 'ok')) {
    lines.push(`structural check: ${report.structural.length} message(s)`);
    for (const msg of report.structural.slice(0, MAX_LISTED)) lines.push(`  ${msg}`);
  }
  if (report.duplicateKeys.length > 0) {
    lines.push(`${report.duplicateKeys.length} key(s) stored more than once (corrupted primary-key index):`);
    for (const d of report.duplicateKeys.slice(0, MAX_LISTED)) lines.push(`  ${d.key} (x${d.count})`);
  }
  lines.push('Repair: rebuild the table from its distinct rows on this node (see INSTALL.md, "Platform DB integrity").');
  return lines;
}

export { PlatformDB, validatePlatformDB, describePlatformIntegrity };