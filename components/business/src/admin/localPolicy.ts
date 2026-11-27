/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */

/**
 * This core's local policy on administrator grants (`admin.localPolicy`,
 * per-core YAML): whether grants replicated through the platform store count
 * here, the permissions that only a local grant can give, and the local
 * grants. Not applied yet: the defaults accept every replicated grant.
 */

type ConfigReader = { get: (key: string) => unknown };

export type LocalPolicyReport = {
  problems: Array<{ message: string; path: string[] }>;
  warnings: string[];
};

/** What the portal context shows of the policy, or null when there is nothing to show. */
export type LocalPolicyView = Record<string, unknown>;

/** Validates `admin.localPolicy`. Never throws; problems name their key path. */
export function describeLocalPolicy (_config: ConfigReader): LocalPolicyReport {
  return { problems: [], warnings: [] };
}

/** The policy as the portal context shows it to `subject`, or null. */
export function policyView (_config: ConfigReader, _subject?: { userId?: string }): LocalPolicyView | null {
  return null;
}
