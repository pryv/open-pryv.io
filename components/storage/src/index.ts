/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */

import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);

const { StorageLayer } = require('./StorageLayer.ts');
const { Size } = require('./Size.ts');
const userLocalDirectory = require('./userLocalDirectory.ts');

const interfaces = {
  UserAccountStorage: require('storages/interfaces/baseStorage/UserAccountStorage.ts'),
  UsersLocalIndexDB: require('storages/interfaces/baseStorage/UsersLocalIndexDB.ts'),
  EventFiles: require('storages/interfaces/fileStorage/EventFiles.ts'),
  UserStorage: require('storages/interfaces/baseStorage/UserStorage.ts'),
  Sessions: require('storages/interfaces/baseStorage/Sessions.ts'),
  PasswordResetRequests: require('storages/interfaces/baseStorage/PasswordResetRequests.ts'),
  AuditStorage: require('storages/interfaces/auditStorage/AuditStorage.ts'),
  UserAuditDatabase: require('storages/interfaces/auditStorage/UserAuditDatabase.ts')
};

export { Size, StorageLayer, getStorageLayer, userLocalDirectory, getUsersLocalIndex, getUserAccountStorage, interfaces };

/**
 * Ensure the storages barrel is initialized (lazy fallback).
 */
async function ensureBarrel () {
  const storages = require('storages');
  if (!storages.storageLayer) await storages.init();
  return storages;
}

async function getUsersLocalIndex () {
  return (await ensureBarrel()).usersLocalIndex;
}

async function getUserAccountStorage () {
  return (await ensureBarrel()).userAccountStorage;
}

async function getStorageLayer () {
  return (await ensureBarrel()).storageLayer;
}
