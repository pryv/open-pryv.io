/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */

/**
 * Backup/restore interface barrel.
 * @module storages/interfaces/backup
 */

import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);

// Type-only import to mark this as a TS module (not a script).
const {
  BackupWriter, createBackupWriter, validateBackupWriter,
  UserBackupWriter, createUserBackupWriter, validateUserBackupWriter
} = require('./BackupWriter.ts');

const {
  BackupReader, createBackupReader, validateBackupReader,
  UserBackupReader, createUserBackupReader, validateUserBackupReader
} = require('./BackupReader.ts');

const { sanitize, INTERNAL_FIELDS } = require('./sanitize.ts');
const { createFilesystemBackupWriter } = require('./FilesystemBackupWriter.ts');
const { createFilesystemBackupReader } = require('./FilesystemBackupReader.ts');
const { createBackupEncryptor, createBackupDecryptor, DEFAULT_CHUNK } = require('./BackupCipher.ts');

export { BackupWriter,
  createBackupWriter,
  validateBackupWriter,
  UserBackupWriter,
  createUserBackupWriter,
  validateUserBackupWriter,

  BackupReader,
  createBackupReader,
  validateBackupReader,
  UserBackupReader,
  createUserBackupReader,
  validateUserBackupReader,

  sanitize,
  INTERNAL_FIELDS,

  createFilesystemBackupWriter,
  createFilesystemBackupReader,

  createBackupEncryptor,
  createBackupDecryptor,
  DEFAULT_CHUNK };