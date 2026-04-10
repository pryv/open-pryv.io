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

const {
  BackupWriter, createBackupWriter, validateBackupWriter,
  UserBackupWriter, createUserBackupWriter, validateUserBackupWriter
} = require('./BackupWriter');

const {
  BackupReader, createBackupReader, validateBackupReader,
  UserBackupReader, createUserBackupReader, validateUserBackupReader
} = require('./BackupReader');

const { sanitize, INTERNAL_FIELDS } = require('./sanitize');
const { createFilesystemBackupWriter } = require('./FilesystemBackupWriter');
const { createFilesystemBackupReader } = require('./FilesystemBackupReader');

module.exports = {
  BackupWriter,
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
  createFilesystemBackupReader
};
