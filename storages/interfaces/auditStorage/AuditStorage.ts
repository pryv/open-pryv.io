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

import type { UserAuditDatabase } from './UserAuditDatabase';

export interface AuditStorage {
  init(): Promise<AuditStorage>;
  getVersion(): string;
  checkInitialized(): void;
  forUser(userId: string): Promise<UserAuditDatabase>;
  deleteUser(userId: string): Promise<void>;
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

function validateAuditStorage (instance: any): AuditStorage {
  for (const method of REQUIRED_METHODS) {
    if (typeof instance[method] !== 'function') {
      throw new Error(`AuditStorage implementation missing method: ${method}`);
    }
  }
  return instance;
}

module.exports = {
  REQUIRED_METHODS,
  validateAuditStorage
};
