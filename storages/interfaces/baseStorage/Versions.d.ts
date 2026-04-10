/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */

export interface VersionRecord {
  _id: string;
  migrationStarted?: number;
  migrationCompleted?: number;
  initialInstall?: number;
}

/**
 * Versions storage interface — global (not user-scoped).
 * Async/await API.
 */
export interface Versions {
  getCurrent(): Promise<VersionRecord | null>;
  migrateIfNeeded(): Promise<void>;
  removeAll(): Promise<void>;

  // Migration methods
  exportAll(): Promise<VersionRecord[]>;
  importAll(data: VersionRecord[]): Promise<void>;
}

export declare function validateVersions(instance: any): Versions;

export declare const REQUIRED_METHODS: string[];
