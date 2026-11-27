/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */

/**
 * This core's lockdown (`admin.lockdown`, per-core YAML, never in the
 * platform store): administration capabilities and platform configuration
 * keys managed elsewhere, so read-only (or hidden) through the API. Not
 * applied yet: without the block everything stays editable.
 */

type ConfigReader = { get: (key: string) => unknown };

export type LockdownReport = {
  problems: Array<{ message: string; path: string[] }>;
  warnings: string[];
};

/** What the portal context shows: the capabilities that are not editable, the read-only keys. */
export type LockdownView = {
  capabilities: Record<string, 'readonly' | 'hidden'>;
  platformConfig: { readonly: string[] };
};

/** Validates `admin.lockdown`. Never throws; problems name their key path. */
export function describeLockdown (_config: ConfigReader): LockdownReport {
  return { problems: [], warnings: [] };
}

/** The lockdown as the portal context shows it, or null when nothing is locked. */
export function lockdownView (_config: ConfigReader): LockdownView | null {
  return null;
}

/** `names` without the capabilities the lockdown hides. */
export function withoutHiddenCapabilities (_config: ConfigReader, names: string[]): string[] {
  return names;
}
