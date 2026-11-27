/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */

/**
 * AuditStorage interface — contract for the LRU-cached audit storage manager.
 * Manages per-user audit databases.
 *
 * Type definitions for AuditStorage live alongside the runtime contract; both
 * are erased at runtime by Node 24's strip-types. CJS module.exports is kept
 * verbatim so consumers (`const { validateAuditStorage } = require(...)`)
 * work unchanged.
 */

import type { UserAuditDatabase } from './UserAuditDatabase.js';

/**
 * The reserved id the trail of this core's administration acts is kept
 * under: the records of audited calls that have no account of this core in
 * their context. It is not an account and can never be one (account ids are
 * cuids, without a dash). A storage that keeps it (`acceptsPlatformTrail`)
 * exempts this exact id, and no other, from the refusal of records of
 * accounts that are not in the users index, and never deletes it as an
 * account (`deleteUser` refuses it).
 */
const PLATFORM_TRAIL_USER_ID = 'platform-trail';

/** Whether `userId` is the reserved id of the platform trail (exact match). */
function isPlatformTrail (userId: unknown): boolean {
  return userId === PLATFORM_TRAIL_USER_ID;
}

/** The refusal of `deleteUser(PLATFORM_TRAIL_USER_ID)`. */
function platformTrailDeletionError (): Error {
  return Object.assign(new Error('"' + PLATFORM_TRAIL_USER_ID + '" is the trail of the administration acts of this core, not an account: not deleted'),
    { code: 'PLATFORM_TRAIL_NOT_AN_ACCOUNT' });
}

export interface AuditStorage {
  init(): Promise<AuditStorage>;
  getVersion(): string;
  checkInitialized(): void;
  forUser(userId: string): Promise<UserAuditDatabase>;
  deleteUser(userId: string): Promise<void>;
  /**
   * Optional: refuse records of accounts that are erased, where the storage
   * does not do it by nature. Returns whether it does from now on.
   */
  refuseUnindexedUsers?(on: boolean): boolean;
  /**
   * Optional: whether the storage keeps the platform trail under
   * `PLATFORM_TRAIL_USER_ID` (see there). Without it, records with no account
   * go to syslog only.
   */
  acceptsPlatformTrail?(): boolean;
  close(): void;
}

const REQUIRED_METHODS: string[] = [
  'init',
  'getVersion',
  'checkInitialized',
  'forUser',
  'deleteUser',
  'close'
];

function validateAuditStorage (instance: unknown): AuditStorage {
  const obj = instance as Record<string, unknown>;
  for (const method of REQUIRED_METHODS) {
    if (typeof obj[method] !== 'function') {
      throw new Error(`AuditStorage implementation missing method: ${method}`);
    }
  }
  return obj as unknown as AuditStorage;
}

export {
  REQUIRED_METHODS,
  validateAuditStorage,
  PLATFORM_TRAIL_USER_ID,
  isPlatformTrail,
  platformTrailDeletionError
};
