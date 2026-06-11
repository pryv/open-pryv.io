/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */

import type { Readable } from 'stream';
import type { StoredItem } from '../_shared/types.ts';
import type { StoredEvent, StoredStream, StoredAccess } from '../_shared/domain.ts';
import type { BackupManifest, UserManifest } from './BackupWriter.ts';
import type { UserAccountStorageExport } from '../baseStorage/UserAccountStorage.ts';
import type { AuditExportRow } from '../auditStorage/UserAuditDatabase.ts';

/** Platform-data entry: v1 / old-v2 archives carry raw `{key, value}` rows
 *  straight from the platform store; v2 archives carry the parsed
 *  `{username, field, value, isUnique}` shape (platformDB.exportAll).
 *  Restore bridges both, so the type is a flat optional bag. */
export type PlatformBackupEntry = {
  key?: string;
  value?: unknown;
  username?: string;
  field?: string;
  isUnique?: boolean;
  [k: string]: unknown;
};

/**
 * Per-user reader returned by `BackupReader.openUser()`.
 * Handles reading all data scoped to a single user.
 */
export interface UserBackupReader {
  readUserManifest (): Promise<UserManifest>;
  readStreams (): AsyncIterable<StoredStream>;
  readAccesses (): AsyncIterable<StoredAccess>;
  readProfile (): AsyncIterable<StoredItem>;
  readWebhooks (): AsyncIterable<StoredItem>;
  readEvents (): AsyncIterable<StoredEvent>;
  /** Raw audit rows as exported by UserAuditDatabase.exportAllEvents. */
  readAudit (): AsyncIterable<AuditExportRow>;
  /** HF series rows — engine/CSV-derived, opaque at this level. */
  readSeries (): AsyncIterable<unknown>;
  readAttachments (): AsyncIterable<{ eventId: string, fileId: string, stream: Readable }>;
  /** Resolves to null when the archive has no account data file. */
  readAccountData (): Promise<UserAccountStorageExport | null>;
}

/**
 * Top-level reader for a portable backup archive produced by a BackupWriter.
 * Handles JSONL (optionally gzip-compressed), chunked files, and attachments.
 */
export interface BackupReader {
  /** Read the top-level manifest. */
  readManifest (): Promise<BackupManifest>;
  /** Read platform-level data. */
  readPlatformData (): AsyncIterable<PlatformBackupEntry>;
  /** Read register-level server mappings (v1 enterprise only). */
  readServerMappings (): AsyncIterable<{ username: string, server: string }>;
  /** Open a user context for reading backup data. */
  openUser (userId: string): Promise<UserBackupReader>;
  /** Finalize and close. Release resources. */
  close (): Promise<void>;
}

/**
 * BackupReader prototype object.
 * All backup reader implementations inherit from this via {@link createBackupReader}.
 */
const BackupReader: BackupReader = {
  async readManifest (): Promise<BackupManifest> { throw new Error('Not implemented'); },

  readPlatformData (): AsyncIterable<PlatformBackupEntry> { throw new Error('Not implemented'); },

  /**
   * Default implementation yields nothing — sources without register
   * data (open-pryv.io v1.9, v2→v2 backups) inherit this no-op.
   */
  readServerMappings (): AsyncIterable<{ username: string, server: string }> {
    async function * empty (): AsyncGenerator<{ username: string, server: string }> {}
    return empty();
  },

  async openUser (userId: string): Promise<UserBackupReader> { throw new Error('Not implemented'); },

  async close (): Promise<void> { throw new Error('Not implemented'); }
};

// Limit tampering on existing properties
for (const propName of Object.getOwnPropertyNames(BackupReader)) {
  Object.defineProperty(BackupReader, propName, { configurable: false });
}

function createBackupReader (implementation: Partial<BackupReader>): BackupReader {
  return Object.assign(Object.create(BackupReader), implementation);
}

const REQUIRED_METHODS: string[] = Object.getOwnPropertyNames(BackupReader);

function validateBackupReader (instance: unknown): BackupReader {
  const inst = instance as Record<string, unknown>;
  for (const method of REQUIRED_METHODS) {
    if (typeof inst[method] !== 'function') {
      throw new Error(`BackupReader implementation missing method: ${method}`);
    }
  }
  return inst as unknown as BackupReader;
}

// ---------------------------------------------------------------------------
// UserBackupReader prototype object — returned by BackupReader.openUser()
// ---------------------------------------------------------------------------

const UserBackupReader: UserBackupReader = {
  async readUserManifest (): Promise<UserManifest> { throw new Error('Not implemented'); },
  readStreams (): AsyncIterable<StoredStream> { throw new Error('Not implemented'); },
  readAccesses (): AsyncIterable<StoredAccess> { throw new Error('Not implemented'); },
  readProfile (): AsyncIterable<StoredItem> { throw new Error('Not implemented'); },
  readWebhooks (): AsyncIterable<StoredItem> { throw new Error('Not implemented'); },
  readEvents (): AsyncIterable<StoredEvent> { throw new Error('Not implemented'); },
  readAudit (): AsyncIterable<AuditExportRow> { throw new Error('Not implemented'); },
  readSeries (): AsyncIterable<unknown> { throw new Error('Not implemented'); },
  readAttachments (): AsyncIterable<{ eventId: string, fileId: string, stream: Readable }> { throw new Error('Not implemented'); },
  async readAccountData (): Promise<UserAccountStorageExport | null> { throw new Error('Not implemented'); }
};

for (const propName of Object.getOwnPropertyNames(UserBackupReader)) {
  Object.defineProperty(UserBackupReader, propName, { configurable: false });
}

function createUserBackupReader (implementation: Partial<UserBackupReader>): UserBackupReader {
  return Object.assign(Object.create(UserBackupReader), implementation);
}

const USER_REQUIRED_METHODS: string[] = Object.getOwnPropertyNames(UserBackupReader);

function validateUserBackupReader (instance: unknown): UserBackupReader {
  const inst = instance as Record<string, unknown>;
  for (const method of USER_REQUIRED_METHODS) {
    if (typeof inst[method] !== 'function') {
      throw new Error(`UserBackupReader implementation missing method: ${method}`);
    }
  }
  return inst as unknown as UserBackupReader;
}

export { BackupReader,
  createBackupReader,
  validateBackupReader,
  UserBackupReader,
  createUserBackupReader,
  validateUserBackupReader };