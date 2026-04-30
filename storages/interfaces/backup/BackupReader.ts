/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */

import type { Readable } from 'stream';

/**
 * Per-user reader returned by `BackupReader.openUser()`.
 * Handles reading all data scoped to a single user.
 */
export interface UserBackupReader {
  readUserManifest (): Promise<any>;
  readStreams (): AsyncIterable<any>;
  readAccesses (): AsyncIterable<any>;
  readProfile (): AsyncIterable<any>;
  readWebhooks (): AsyncIterable<any>;
  readEvents (): AsyncIterable<any>;
  readAudit (): AsyncIterable<any>;
  readSeries (): AsyncIterable<any>;
  readAttachments (): AsyncIterable<{ eventId: string, fileId: string, stream: Readable }>;
  readAccountData (): Promise<any>;
}

/**
 * Top-level reader for a portable backup archive produced by a BackupWriter.
 * Handles JSONL (optionally gzip-compressed), chunked files, and attachments.
 */
export interface BackupReader {
  /** Read the top-level manifest. */
  readManifest (): Promise<any>;
  /** Read platform-level data. */
  readPlatformData (): AsyncIterable<any>;
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
  async readManifest (): Promise<any> { throw new Error('Not implemented'); },

  readPlatformData (): AsyncIterable<any> { throw new Error('Not implemented'); },

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

function validateBackupReader (instance: any): BackupReader {
  for (const method of REQUIRED_METHODS) {
    if (typeof instance[method] !== 'function') {
      throw new Error(`BackupReader implementation missing method: ${method}`);
    }
  }
  return instance;
}

// ---------------------------------------------------------------------------
// UserBackupReader prototype object — returned by BackupReader.openUser()
// ---------------------------------------------------------------------------

const UserBackupReader: UserBackupReader = {
  async readUserManifest (): Promise<any> { throw new Error('Not implemented'); },
  readStreams (): AsyncIterable<any> { throw new Error('Not implemented'); },
  readAccesses (): AsyncIterable<any> { throw new Error('Not implemented'); },
  readProfile (): AsyncIterable<any> { throw new Error('Not implemented'); },
  readWebhooks (): AsyncIterable<any> { throw new Error('Not implemented'); },
  readEvents (): AsyncIterable<any> { throw new Error('Not implemented'); },
  readAudit (): AsyncIterable<any> { throw new Error('Not implemented'); },
  readSeries (): AsyncIterable<any> { throw new Error('Not implemented'); },
  readAttachments (): AsyncIterable<{ eventId: string, fileId: string, stream: Readable }> { throw new Error('Not implemented'); },
  async readAccountData (): Promise<any> { throw new Error('Not implemented'); }
};

for (const propName of Object.getOwnPropertyNames(UserBackupReader)) {
  Object.defineProperty(UserBackupReader, propName, { configurable: false });
}

function createUserBackupReader (implementation: Partial<UserBackupReader>): UserBackupReader {
  return Object.assign(Object.create(UserBackupReader), implementation);
}

const USER_REQUIRED_METHODS: string[] = Object.getOwnPropertyNames(UserBackupReader);

function validateUserBackupReader (instance: any): UserBackupReader {
  for (const method of USER_REQUIRED_METHODS) {
    if (typeof instance[method] !== 'function') {
      throw new Error(`UserBackupReader implementation missing method: ${method}`);
    }
  }
  return instance;
}

module.exports = {
  BackupReader,
  createBackupReader,
  validateBackupReader,
  UserBackupReader,
  createUserBackupReader,
  validateUserBackupReader
};
