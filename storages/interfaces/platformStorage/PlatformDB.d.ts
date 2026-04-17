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

export interface PlatformDB {
  init(): Promise<void>;
  setUserUniqueField(username: string, field: string, value: string): Promise<any>;
  deleteUserUniqueField(field: string, value: string): Promise<void>;
  setUserIndexedField(username: string, field: string, value: string): Promise<void>;
  deleteUserIndexedField(username: string, field: string): Promise<void>;
  getUserIndexedField(username: string, field: string): Promise<string | null>;
  getUsersUniqueField(field: string, value: string): Promise<string | null>;
  getAllWithPrefix(prefix: string): Promise<PlatformEntry[]>;
  deleteAll(): Promise<void>;
  close(): Promise<void>;
  isClosed(): boolean;
  exportAll(): Promise<PlatformEntry[]>;
  importAll(data: PlatformEntry[]): Promise<void>;
  clearAll(): Promise<void>;
  setAcmeAccount(account: AcmeAccount): Promise<void>;
  getAcmeAccount(): Promise<AcmeAccount | null>;
  setCertificate(hostname: string, cert: TlsCertificate): Promise<void>;
  getCertificate(hostname: string): Promise<TlsCertificate | null>;
  listCertificates(): Promise<TlsCertificateSummary[]>;
  deleteCertificate(hostname: string): Promise<void>;
}

export declare const PlatformDB: PlatformDB;
export declare function validatePlatformDB(instance: any): PlatformDB;
