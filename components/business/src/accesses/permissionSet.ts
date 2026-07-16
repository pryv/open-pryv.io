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

/** A permission entry as it appears in a CONSENT request/offer: the
 * plain lexicon plus the consent-layer `mandatory` annotation. Never
 * reaches a minted access row (see `stripConsentAnnotations`). */
type ConsentPermission = Permission & { mandatory?: boolean };

/**
 * Validate an unknown value as a permissions array covering the FULL
 * lexicon (stream + feature permissions) and return typed copies
 * carrying only the known fields (display names preserved on stream
 * permissions). Throws with the offending index on invalid entries.
 *
 * With `opts.consent`, the consent-layer `mandatory: true` annotation
 * is preserved on entries (offer/request context); without it the
 * annotation is dropped (mint/grant context).
 */
function normalizePermissions (perms: unknown, opts?: { consent?: boolean }): ConsentPermission[] {
  if (!Array.isArray(perms)) {
    throw new Error('permissions must be an array');
  }
  const keepMandatory = opts?.consent === true;
  return perms.map((p, i) => {
    if (isStreamPermission(p)) {
      // Consent context: a permission set is validated by the "granted ⊆
      // offered, dropping an entry = narrowing" rule (checkConsentGrant).
      // That rule is only sound for POSITIVE grants. `none` is an
      // EXCLUSION MASK (AccessLogic adds streamIds with level 'none' to the
      // cannot-list / forbidden-get sets), so an offered `none` entry that
      // masks a broader grant INVERTS the rule — dropping it WIDENS access.
      // Consent offers therefore must not carry masks.
      if (keepMandatory && p.level === 'none') {
        throw new Error(
          `invalid consent permission at index ${i}: level 'none' (an exclusion mask) ` +
          `is not allowed in a consent offer — offers must grant positive access only`
        );
      }
      const out: ConsentPermission = { streamId: p.streamId, level: p.level };
      if (typeof p.defaultName === 'string') out.defaultName = p.defaultName;
      if (typeof p.name === 'string') out.name = p.name;
      if (keepMandatory && (p as ConsentPermission).mandatory === true) out.mandatory = true;
      return out;
    }
    if (isFeaturePermission(p)) {
      const out: ConsentPermission = { feature: p.feature, setting: p.setting };
      if (keepMandatory && (p as ConsentPermission).mandatory === true) out.mandatory = true;
      return out;
    }
    throw new Error(
      `invalid permission at index ${i}: expected {streamId, level in [${PERMISSION_LEVEL_VALUES.join(', ')}]} ` +
      `or {feature, setting in [${FEATURE_SETTING_VALUES.join(', ')}]}`
    );
  });
}

/** Drop consent-layer annotations — call before anything that mints or
 * updates a real access row. */
function stripConsentAnnotations (perms: ConsentPermission[]): Permission[] {
  return perms.map((p) => {
    const { mandatory: _mandatory, ...rest } = p as ConsentPermission & Record<string, unknown>;
    return rest as Permission;
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

/** Consent-grant validation outcome; `offending` names the entries
 * that violate the failing rule. */
type ConsentGrantCheck =
  | { ok: true }
  | { ok: false; reason: 'not-subset' | 'choice-not-allowed' | 'mandatory-refused'; offending: Permission[] };

/**
 * THE consent-grant rule (single point — enforced identically by the
 * cmc accept path and the OAuth2 accept endpoint):
 *
 *   - `granted ⊆ offered` always (exact-entry identity);
 *   - `allowUserChoice` false/absent (the DEFAULT) → ALL OR NOTHING:
 *     `granted` must cover the WHOLE offered set — the user's only
 *     choice is accept or deny (`reason: 'choice-not-allowed'` names
 *     the missing entries otherwise);
 *   - `allowUserChoice` true → cherry-picking allowed, EXCEPT offered
 *     entries annotated `mandatory: true`, which must all be granted
 *     (`reason: 'mandatory-refused'` otherwise).
 *
 * `offered` is expected in consent form (annotations preserved —
 * `normalizePermissions(perms, {consent: true})`); `granted` in plain
 * form. Identity ignores annotations.
 */
function checkConsentGrant (
  granted: Permission[],
  offered: ConsentPermission[],
  allowUserChoice: boolean
): ConsentGrantCheck {
  const sub = isPermissionSubset(granted, offered);
  if (!sub.ok) return { ok: false, reason: 'not-subset', offending: sub.offending };
  const grantedKeys = new Set(granted.map(permissionKey));
  if (allowUserChoice !== true) {
    const missing = offered.filter((o) => !grantedKeys.has(permissionKey(o)));
    if (missing.length > 0) {
      return { ok: false, reason: 'choice-not-allowed', offending: stripConsentAnnotations(missing) };
    }
    return { ok: true };
  }
  const missingMandatory = offered.filter(
    (o) => o.mandatory === true && !grantedKeys.has(permissionKey(o))
  );
  if (missingMandatory.length > 0) {
    return { ok: false, reason: 'mandatory-refused', offending: stripConsentAnnotations(missingMandatory) };
  }
  return { ok: true };
}

export {
  PermissionLevels,
  PERMISSION_LEVEL_VALUES,
  FEATURE_SETTING_VALUES,
  isStreamPermission,
  isFeaturePermission,
  normalizePermissions,
  stripConsentAnnotations,
  permissionKey,
  isPermissionSubset,
  checkConsentGrant
};
