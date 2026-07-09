/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */

/**
 * Permission-set lexicon + pure set operations — the single source of
 * truth for the `accesses.create` permission grammar:
 *
 *   Permission = StreamPermission  { streamId, level, defaultName?, name? }
 *              | FeaturePermission { feature, setting }
 *
 * Consumers:
 *   - AccessLogic (level ordering via `PermissionLevels`)
 *   - api-server schema/access.ts (JSON-schema enums derive from the
 *     value lists exported here)
 *   - cmc acceptOrchestration (offer permissions normalization)
 *   - oauth2 route mount (granted ⊆ offered consent-downgrade check,
 *     injected as a dep)
 *
 * Keep this module pure (no config, no I/O) so any component can load it.
 */

import type { Permission, StreamPermission, FeaturePermission, PermissionLevel } from '../types/public.ts';

/**
 * Permission levels ordered by ascending capability, for level
 * assessment (`isHigherOrEqualLevel`-style comparisons in AccessLogic).
 */
const PermissionLevels: Record<PermissionLevel, number> = {
  none: -1,
  read: 0,
  'create-only': 1,
  contribute: 1,
  manage: 2
};
Object.freeze(PermissionLevels);

/** Valid `level` values for a stream permission. */
const PERMISSION_LEVEL_VALUES: readonly PermissionLevel[] =
  Object.freeze(Object.keys(PermissionLevels) as PermissionLevel[]);

/** Valid `setting` values for a feature permission (e.g. `selfRevoke`). */
const FEATURE_SETTING_VALUES: readonly string[] = Object.freeze(['forbidden']);

function isStreamPermission (p: unknown): p is StreamPermission {
  if (p == null || typeof p !== 'object') return false;
  const c = p as Record<string, unknown>;
  return typeof c.streamId === 'string' && c.streamId.length > 0 &&
    typeof c.level === 'string' &&
    (PERMISSION_LEVEL_VALUES as readonly string[]).includes(c.level);
}

function isFeaturePermission (p: unknown): p is FeaturePermission {
  if (p == null || typeof p !== 'object') return false;
  const c = p as Record<string, unknown>;
  return typeof c.feature === 'string' && c.feature.length > 0 &&
    typeof c.setting === 'string' &&
    FEATURE_SETTING_VALUES.includes(c.setting);
}

/**
 * Validate an unknown value as a permissions array covering the FULL
 * lexicon (stream + feature permissions) and return typed copies
 * carrying only the known fields (display names preserved on stream
 * permissions). Throws with the offending index on invalid entries.
 */
function normalizePermissions (perms: unknown): Permission[] {
  if (!Array.isArray(perms)) {
    throw new Error('permissions must be an array');
  }
  return perms.map((p, i) => {
    if (isStreamPermission(p)) {
      const out: StreamPermission = { streamId: p.streamId, level: p.level };
      if (typeof p.defaultName === 'string') out.defaultName = p.defaultName;
      if (typeof p.name === 'string') out.name = p.name;
      return out;
    }
    if (isFeaturePermission(p)) {
      return { feature: p.feature, setting: p.setting };
    }
    throw new Error(
      `invalid permission at index ${i}: expected {streamId, level in [${PERMISSION_LEVEL_VALUES.join(', ')}]} ` +
      `or {feature, setting in [${FEATURE_SETTING_VALUES.join(', ')}]}`
    );
  });
}

/**
 * Canonical identity of a permission entry — display names are NOT
 * part of the identity (a granted entry matches its offered twin even
 * if the UI stripped `defaultName`).
 */
function permissionKey (p: Permission): string {
  if (isStreamPermission(p)) return 's|' + p.streamId + '|' + p.level;
  return 'f|' + (p as FeaturePermission).feature + '|' + (p as FeaturePermission).setting;
}

/**
 * Exact-entry subset check: every granted entry must exist identically
 * in the offered set (consent downgrade = dropping entries, never
 * altering them). Returns the offending entries on failure so callers
 * can produce a precise error.
 */
function isPermissionSubset (granted: Permission[], offered: Permission[]):
  { ok: true } | { ok: false; offending: Permission[] } {
  const offeredKeys = new Set(offered.map(permissionKey));
  const offending = granted.filter((g) => !offeredKeys.has(permissionKey(g)));
  return offending.length === 0 ? { ok: true } : { ok: false, offending };
}

export {
  PermissionLevels,
  PERMISSION_LEVEL_VALUES,
  FEATURE_SETTING_VALUES,
  isStreamPermission,
  isFeaturePermission,
  normalizePermissions,
  permissionKey,
  isPermissionSubset
};
