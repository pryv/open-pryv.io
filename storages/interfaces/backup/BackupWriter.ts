/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */

import type { Readable } from 'stream';

/**
 * Per-user writer returned by `BackupWriter.openUser()`.
 * Handles writing all data scoped to a single user.
 */
export interface UserBackupWriter {
  writeStreams (items: AsyncIterable<any> | any[]): Promise<void>;
  writeAccesses (items: AsyncIterable<any> | any[]): Promise<void>;
  writeProfile (items: AsyncIterable<any> | any[]): Promise<void>;
  writeWebhooks (items: AsyncIterable<any> | any[]): Promise<void>;
  /** Auto-chunks by maxChunkSize. */
  writeEvents (items: AsyncIterable<any> | any[]): Promise<void>;
  /** Auto-chunks by maxChunkSize. */
  writeAudit (items: AsyncIterable<any> | any[]): Promise<void>;
  /** Write HF series data (CSV format). */
  writeSeries (items: AsyncIterable<any> | any[]): Promise<void>;
  writeAttachment (eventId: string, fileId: string, readStream: Readable): Promise<void>;
  /** Account data as returned by UserAccountStorage.exportAll(). */
  writeAccountData (data: any): Promise<void>;
  /** Returns the user manifest (userId, username, chunk inventory, stats). */
  close (): Promise<any>;
}

export interface BackupWriteManifestParams {
  coreVersion: string;
  config: Record<string, any>;
  userManifests: any[];
  backupType: string;
  /** Consistency cutoff: items modified after this are excluded. */
  snapshotBefore?: number;
  backupTimestamp: number;
}

/**
 * Top-level writer for a portable, engine-agnostic backup archive.
 * Data is written as JSONL (one JSON object per line), optionally
 * gzip-compressed. Large collections (events, audit) are chunked by
 * maxChunkSize.
 */
export interface BackupWriter {
  openUser (userId: string, username: string): Promise<UserBackupWriter>;
  writePlatformData (data: AsyncIterable<any> | any[]): Promise<void>;
  /** Must be called last — acts as completion marker. */
  writeManifest (params: BackupWriteManifestParams): Promise<void>;
  close (): Promise<void>;
}

/**
 * BackupWriter prototype object.
 * All backup writer implementations inherit from this via {@link createBackupWriter}.
 */
const BackupWriter: BackupWriter = {
  async openUser (userId: string, username: string): Promise<UserBackupWriter> { throw new Error('Not implemented'); },

  async writePlatformData (data: AsyncIterable<any> | any[]): Promise<void> { throw new Error('Not implemented'); },

  async writeManifest (params: BackupWriteManifestParams): Promise<void> { throw new Error('Not implemented'); },

  async close (): Promise<void> { throw new Error('Not implemented'); }
};

// Limit tampering on existing properties
for (const propName of Object.getOwnPropertyNames(BackupWriter)) {
  Object.defineProperty(BackupWriter, propName, { configurable: false });
}

function createBackupWriter (implementation: Partial<BackupWriter>): BackupWriter {
  return Object.assign(Object.create(BackupWriter), implementation);
}

const REQUIRED_METHODS: string[] = Object.getOwnPropertyNames(BackupWriter);

function validateBackupWriter (instance: any): BackupWriter {
  for (const method of REQUIRED_METHODS) {
    if (typeof instance[method] !== 'function') {
      throw new Error(`BackupWriter implementation missing method: ${method}`);
    }
  }
  return instance;
}

// ---------------------------------------------------------------------------
// UserBackupWriter prototype — returned by BackupWriter.openUser()
// ---------------------------------------------------------------------------

const UserBackupWriter: UserBackupWriter = {
  async writeStreams (items: AsyncIterable<any> | any[]): Promise<void> { throw new Error('Not implemented'); },
  async writeAccesses (items: AsyncIterable<any> | any[]): Promise<void> { throw new Error('Not implemented'); },
  async writeProfile (items: AsyncIterable<any> | any[]): Promise<void> { throw new Error('Not implemented'); },
  async writeWebhooks (items: AsyncIterable<any> | any[]): Promise<void> { throw new Error('Not implemented'); },
  async writeEvents (items: AsyncIterable<any> | any[]): Promise<void> { throw new Error('Not implemented'); },
  async writeAudit (items: AsyncIterable<any> | any[]): Promise<void> { throw new Error('Not implemented'); },
  async writeSeries (items: AsyncIterable<any> | any[]): Promise<void> { throw new Error('Not implemented'); },
  async writeAttachment (eventId: string, fileId: string, readStream: Readable): Promise<void> { throw new Error('Not implemented'); },
  async writeAccountData (data: any): Promise<void> { throw new Error('Not implemented'); },
  async close (): Promise<any> { throw new Error('Not implemented'); }
};

for (const propName of Object.getOwnPropertyNames(UserBackupWriter)) {
  Object.defineProperty(UserBackupWriter, propName, { configurable: false });
}

function createUserBackupWriter (implementation: Partial<UserBackupWriter>): UserBackupWriter {
  return Object.assign(Object.create(UserBackupWriter), implementation);
}

const USER_REQUIRED_METHODS: string[] = Object.getOwnPropertyNames(UserBackupWriter);

function validateUserBackupWriter (instance: any): UserBackupWriter {
  for (const method of USER_REQUIRED_METHODS) {
    if (typeof instance[method] !== 'function') {
      throw new Error(`UserBackupWriter implementation missing method: ${method}`);
    }
  }
  return instance;
}

module.exports = {
  BackupWriter,
  createBackupWriter,
  validateBackupWriter,
  UserBackupWriter,
  createUserBackupWriter,
  validateUserBackupWriter
};
