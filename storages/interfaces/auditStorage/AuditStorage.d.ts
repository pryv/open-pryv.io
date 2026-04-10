/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */

import { UserAuditDatabase } from './UserAuditDatabase';

/**
 * AuditStorage interface — LRU-cached manager for per-user audit databases.
 * Async/await API.
 */
export interface AuditStorage {
  init(): Promise<this>;
  getVersion(): string;
  checkInitialized(): void;
  forUser(userId: string): Promise<UserAuditDatabase>;
  deleteUser(userId: string): Promise<void>;
  close(): void;
}

export declare function validateAuditStorage(instance: any): AuditStorage;

export declare const REQUIRED_METHODS: string[];
