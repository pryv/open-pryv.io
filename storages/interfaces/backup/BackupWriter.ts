/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */

import type { Readable } from 'stream';

/** Per-user manifest returned by `UserBackupWriter.close()`. */
export type UserManifest = {
  userId: string;
  username: string;
  /** ms epoch (Date.now() at close time). */
  backupTimestamp: number;
  /** Item counts per collection (streams, accesses, events, ...). */
  stats: Record<string, number>;
  /** Chunk-file inventory per collection. */
  chunks: Record<string, string[]>;
};

/**
 * Per-user writer returned by `BackupWriter.openUser()`.
 * Handles writing all data scoped to a single user.
 */
export interface UserBackupWriter {
  writeStreams (items: AsyncIterable<unknown> | unknown[]): Promise<void>;
  writeAccesses (items: AsyncIterable<unknown> | unknown[]): Promise<void>;
  writeProfile (items: AsyncIterable<unknown> | unknown[]): Promise<void>;
  writeWebhooks (items: AsyncIterable<unknown> | unknown[]): Promise<void>;
  /** Auto-chunks by maxChunkSize. */
  writeEvents (items: AsyncIterable<unknown> | unknown[]): Promise<void>;
  /** Auto-chunks by maxChunkSize. */
  writeAudit (items: AsyncIterable<unknown> | unknown[]): Promise<void>;
  /** Write HF series data (CSV format). */
  writeSeries (items: AsyncIterable<unknown> | unknown[]): Promise<void>;
  writeAttachment (eventId: string, fileId: string, readStream: Readable): Promise<void>;
  /** Account data as returned by UserAccountStorage.exportAll(). */
  writeAccountData (data: unknown): Promise<void>;
  /** Returns the user manifest (userId, username, chunk inventory, stats). */
  close (): Promise<UserManifest>;
}

export interface BackupWriteManifestParams {
  coreVersion: string;
  config: Record<string, unknown>;
  userManifests: UserManifest[];
  backupType: string;
  /** Consistency cutoff: items modified after this are excluded. */
  snapshotBefore?: number;
  backupTimestamp: number;
}

/** Top-level manifest as persisted by writeManifest (the archive's
 *  completion marker) and read back via BackupReader.readManifest. */
export type BackupManifest = {
  formatVersion: number;
  coreVersion?: string;
  config?: Record<string, unknown>;
  backupType: string;
  backupTimestamp?: number;
  snapshotBefore?: number | null;
  users: UserManifest[];
  compressed?: boolean;
  [k: string]: unknown;
};

/**
 * Top-level writer for a portable, engine-agnostic backup archive.
 * Data is written as JSONL (one JSON object per line), optionally
 * gzip-compressed. Large collections (events, audit) are chunked by
 * maxChunkSize.
 */
export interface BackupWriter {
  openUser (userId: string, username: string): Promise<UserBackupWriter>;
  writePlatformData (data: AsyncIterable<unknown> | unknown[]): Promise<void>;
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

  async writePlatformData (data: AsyncIterable<unknown> | unknown[]): Promise<void> { throw new Error('Not implemented'); },

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

function validateBackupWriter (instance: unknown): BackupWriter {
  const obj = instance as Record<string, unknown>;
  for (const method of REQUIRED_METHODS) {
    if (typeof obj[method] !== 'function') {
      throw new Error(`BackupWriter implementation missing method: ${method}`);
    }
  }
  return obj as unknown as BackupWriter;
}

// ---------------------------------------------------------------------------
// UserBackupWriter prototype — returned by BackupWriter.openUser()
// ---------------------------------------------------------------------------

const UserBackupWriter: UserBackupWriter = {
  async writeStreams (items: AsyncIterable<unknown> | unknown[]): Promise<void> { throw new Error('Not implemented'); },
  async writeAccesses (items: AsyncIterable<unknown> | unknown[]): Promise<void> { throw new Error('Not implemented'); },
  async writeProfile (items: AsyncIterable<unknown> | unknown[]): Promise<void> { throw new Error('Not implemented'); },
  async writeWebhooks (items: AsyncIterable<unknown> | unknown[]): Promise<void> { throw new Error('Not implemented'); },
  async writeEvents (items: AsyncIterable<unknown> | unknown[]): Promise<void> { throw new Error('Not implemented'); },
  async writeAudit (items: AsyncIterable<unknown> | unknown[]): Promise<void> { throw new Error('Not implemented'); },
  async writeSeries (items: AsyncIterable<unknown> | unknown[]): Promise<void> { throw new Error('Not implemented'); },
  async writeAttachment (eventId: string, fileId: string, readStream: Readable): Promise<void> { throw new Error('Not implemented'); },
  async writeAccountData (data: unknown): Promise<void> { throw new Error('Not implemented'); },
  async close (): Promise<UserManifest> { throw new Error('Not implemented'); }
};

for (const propName of Object.getOwnPropertyNames(UserBackupWriter)) {
  Object.defineProperty(UserBackupWriter, propName, { configurable: false });
}

function createUserBackupWriter (implementation: Partial<UserBackupWriter>): UserBackupWriter {
  return Object.assign(Object.create(UserBackupWriter), implementation);
}

const USER_REQUIRED_METHODS: string[] = Object.getOwnPropertyNames(UserBackupWriter);

function validateUserBackupWriter (instance: unknown): UserBackupWriter {
  const obj = instance as Record<string, unknown>;
  for (const method of USER_REQUIRED_METHODS) {
    if (typeof obj[method] !== 'function') {
      throw new Error(`UserBackupWriter implementation missing method: ${method}`);
    }
  }
  return obj as unknown as UserBackupWriter;
}

export { BackupWriter,
  createBackupWriter,
  validateBackupWriter,
  UserBackupWriter,
  createUserBackupWriter,
  validateUserBackupWriter };