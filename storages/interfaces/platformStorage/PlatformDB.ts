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
  email: string;
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
  [key: string]: any;
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
  [key: string]: any;
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

export interface AccessStateEntry { value: any; expiresAt: number }

export interface PlatformDB {
  init (): Promise<void>;

  // --- Unique / indexed user fields --------------------------------
  setUserUniqueField (username: string, field: string, value: string): Promise<any>;
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
  getUserCore (username: string): Promise<string | null>;
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
  setAccessState (key: string, value: any, expiresAt: number): Promise<void>;
  getAccessState (key: string): Promise<AccessStateEntry | null>;
  deleteAccessState (key: string): Promise<void>;
  sweepExpiredAccessStates (now?: number): Promise<{ removed: number }>;
}

/**
 * PlatformDB prototype object.
 * Backend implementations (rqlite) inherit from this; tests can use
 * `validatePlatformDB` to verify class-based instances at boot.
 */
const PlatformDB: PlatformDB = {
  async init () { throw new Error('Not implemented'); },

  async setUserUniqueField (username: string, field: string, value: string): Promise<any> { throw new Error('Not implemented'); },

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

  async getUserCore (username: string): Promise<string | null> { throw new Error('Not implemented'); },

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

  async setAccessState (key: string, value: any, expiresAt: number): Promise<void> { throw new Error('Not implemented'); },

  async getAccessState (key: string): Promise<AccessStateEntry | null> { throw new Error('Not implemented'); },

  async deleteAccessState (key: string): Promise<void> { throw new Error('Not implemented'); },

  async sweepExpiredAccessStates (now?: number): Promise<{ removed: number }> { throw new Error('Not implemented'); }
};

// Limit tampering on existing properties
for (const propName of Object.getOwnPropertyNames(PlatformDB)) {
  Object.defineProperty(PlatformDB, propName, { configurable: false });
}

const REQUIRED_METHODS: string[] = Object.getOwnPropertyNames(PlatformDB);

function validatePlatformDB (instance: any): PlatformDB {
  for (const method of REQUIRED_METHODS) {
    if (typeof instance[method] !== 'function') {
      throw new Error(`PlatformDB implementation missing method: ${method}`);
    }
  }
  return instance;
}

export { PlatformDB, validatePlatformDB };