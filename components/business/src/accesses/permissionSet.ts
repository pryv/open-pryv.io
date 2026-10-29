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
 * In a CONSENT request or offer an entry may also carry the annotations
 * `mandatory?` and `optIn?` (see `ConsentPermission`). They live only in
 * the consent layer: `stripConsentAnnotations` removes them before an
 * access is minted, so no stored permission ever carries one.
 *
 * Consumers:
 *   - AccessLogic (level ordering via `PermissionLevels`)
 *   - api-server schema/access.ts (JSON-schema enums derive from the
 *     value lists exported here)
 *   - cmc acceptOrchestration (offer permissions normalization)
 *   - oauth2 route mount (granted ⊆ offered consent-downgrade check,
 *     injected as a dep)
 *   - api-server routes/reg/consentCheck (the same check on the auth
 *     request's ACCEPTED post, against the form resolved from its
 *     `consent` sidecar)
 *
 * Keep this module pure (no config, no I/O) so any component can load it.
 */

import type { Permission, StreamPermission, FeaturePermission, PermissionLevel } from '../types/public.ts';
import { canonicalStreamId } from 'mall/src/helpers/storeDataUtils.ts';

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

/**
 * Valid `setting` values for a feature permission (e.g. `selfRevoke`).
 * `allowed` is the explicit form of the default (absence ⇒ allow at every
 * enforcement site, which tests `setting !== 'forbidden'`): it exists so a
 * minted access can OVERRIDE an inherited restriction — e.g. an OAuth session
 * credential stays self-revocable (a client may always revoke its own token)
 * even when the consent offer forbids selfRevoke on the durable data-grant.
 */
const FEATURE_SETTING_VALUES: readonly string[] = Object.freeze(['forbidden', 'allowed']);

/**
 * Feature permissions an access hands down to every access it creates when
 * it carries them as `forbidden` (see `AccessLogic.inheritRestrictions`).
 */
const INHERITED_RESTRICTION_FEATURES: readonly string[] = Object.freeze(['secretSharing', 'webhooks']);

/**
 * Whether a raw permission array carries `{ feature, setting: 'forbidden' }`.
 * Pure: works on a stored access row as well as on an `AccessLogic`
 * (both expose `.permissions`). Anything that is not an array forbids nothing.
 */
function isFeatureForbidden (permissions: unknown, feature: string): boolean {
  if (!Array.isArray(permissions)) return false;
  return permissions.some((p: unknown) => {
    if (p == null || typeof p !== 'object') return false;
    const c = p as Record<string, unknown>;
    return c.feature === feature && c.setting === 'forbidden';
  });
}

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
 * plain lexicon plus the consent-layer annotations. Neither reaches a
 * minted access row (see `stripConsentAnnotations`).
 *
 * The two annotations are orthogonal and together express the three
 * words a requester can put on an entry:
 *
 *   mandatory : `mandatory: true`  the user cannot drop it (enforced by
 *                                  `checkConsentGrant`)
 *   opt-out   : neither flag       optional, offered pre-selected (the
 *                                  behaviour every offer has today)
 *   opt-in    : `optIn: true`      optional, offered NOT pre-selected
 *
 * `optIn` is DISPLAY-ONLY: it says how the consent screen should present
 * the entry, never what the user is allowed to grant. `checkConsentGrant`
 * does not read it, so an offer's grant rule is identical with and without
 * it. `mandatory` and `optIn` on the same entry contradict each other and
 * are rejected at normalization. */
type ConsentPermission = Permission & { mandatory?: boolean; optIn?: boolean };

/**
 * Copy the consent-layer annotations from a request/offer entry onto its
 * normalized twin, rejecting the one combination that carries no meaning.
 * Only called in consent context; outside it both annotations are dropped.
 *
 * `mandatory` + `optIn` on one entry is a contradiction: the first says
 * the user may not drop the entry, the second says it is offered
 * unselected, so the screen would open on a state the grant rule refuses.
 * Rejecting it at normalization means neither the consent screen nor
 * `checkConsentGrant` ever has to decide which flag wins.
 */
function copyConsentAnnotations (from: ConsentPermission, to: ConsentPermission, index: number): void {
  const mandatory = from.mandatory === true;
  const optIn = from.optIn === true;
  if (mandatory && optIn) {
    throw new Error(
      `invalid consent permission at index ${index}: 'mandatory' and 'optIn' contradict ` +
      'each other (a mandatory entry cannot be offered unselected)'
    );
  }
  if (mandatory) to.mandatory = true;
  if (optIn) to.optIn = true;
}

/**
 * Validate an unknown value as a permissions array covering the FULL
 * lexicon (stream + feature permissions) and return typed copies
 * carrying only the known fields (display names preserved on stream
 * permissions). Throws with the offending index on invalid entries.
 *
 * With `opts.consent`, the consent-layer annotations (`mandatory: true`,
 * `optIn: true`) are preserved on entries (offer/request context);
 * without it they are dropped (mint/grant context).
 */
function normalizePermissions (perms: unknown, opts?: { consent?: boolean }): ConsentPermission[] {
  if (!Array.isArray(perms)) {
    throw new Error('permissions must be an array');
  }
  const keepAnnotations = opts?.consent === true;
  return perms.map((p, i) => {
    if (isStreamPermission(p)) {
      // Consent context: a permission set is validated by the "granted ⊆
      // offered, dropping an entry = narrowing" rule (checkConsentGrant).
      // That rule is only sound for POSITIVE grants. `none` is an
      // EXCLUSION MASK (AccessLogic adds streamIds with level 'none' to the
      // cannot-list / forbidden-get sets), so an offered `none` entry that
      // masks a broader grant INVERTS the rule — dropping it WIDENS access.
      // Consent offers therefore must not carry masks.
      if (keepAnnotations && p.level === 'none') {
        throw new Error(
          `invalid consent permission at index ${i}: level 'none' (an exclusion mask) ` +
          'is not allowed in a consent offer — offers must grant positive access only'
        );
      }
      const out: ConsentPermission = { streamId: p.streamId, level: p.level };
      if (typeof p.defaultName === 'string') out.defaultName = p.defaultName;
      if (typeof p.name === 'string') out.name = p.name;
      if (keepAnnotations) copyConsentAnnotations(p as ConsentPermission, out, i);
      return out;
    }
    if (isFeaturePermission(p)) {
      const out: ConsentPermission = { feature: p.feature, setting: p.setting };
      if (keepAnnotations) copyConsentAnnotations(p as ConsentPermission, out, i);
      return out;
    }
    throw new Error(
      `invalid permission at index ${i}: expected {streamId, level in [${PERMISSION_LEVEL_VALUES.join(', ')}]} ` +
      `or {feature, setting in [${FEATURE_SETTING_VALUES.join(', ')}]}`
    );
  });
}

/**
 * The five capabilities a stream permission level confers, derived to
 * match `AccessLogic` EXACTLY (single source of truth for the level →
 * capability mapping, so the consent effective-comparison can never
 * drift from what the access actually grants at request time):
 *   - read   ← canGetEventsOnStream    (create-only is NOT readable)
 *   - create ← canCreateEventsOnStream (create-only IS creatable)
 *   - update ← canUpdateEventsOnStream (create-only cannot update)
 *   - manage ← _canManageStream        (only `manage`; create-only excluded)
 *   - list   ← canListStream           (create-only IS listable — rank ≥ read)
 *
 * `null`/`undefined` (no matching permission) and `none` (exclusion
 * mask) confer nothing. Note the create-only asymmetry: it can create +
 * list but not read — a plain numeric level comparison misses it, which
 * is exactly why the consent-mask class needs this table, not a rank test.
 */
export type StreamCapabilities = {
  read: boolean; create: boolean; update: boolean; manage: boolean; list: boolean;
};
const NO_CAPABILITIES: StreamCapabilities = Object.freeze({
  read: false, create: false, update: false, manage: false, list: false
}) as StreamCapabilities;
function capabilitiesForLevel (level: PermissionLevel | null | undefined): StreamCapabilities {
  switch (level) {
    case 'read': return { read: true, create: false, update: false, manage: false, list: true };
    case 'create-only': return { read: false, create: true, update: false, manage: false, list: true };
    case 'contribute': return { read: true, create: true, update: true, manage: false, list: true };
    case 'manage': return { read: true, create: true, update: true, manage: true, list: true };
    // 'none', null, undefined, or any unexpected value → nothing.
    default: return NO_CAPABILITIES;
  }
}

/**
 * The capabilities present under `grantedLevel` that are ABSENT under
 * `offeredLevel` — i.e. where a granted access would exceed the offer at
 * a given stream. Empty ⇒ granted ⊆ offered at that stream. This is the
 * per-stream primitive the tree-aware consent guard applies to every
 * offered streamId (resolving each level through the stream hierarchy so
 * a dropped restrictive descendant that re-inherits a broader ancestor is
 * caught).
 */
function levelCapabilityExcess (
  grantedLevel: PermissionLevel | null | undefined,
  offeredLevel: PermissionLevel | null | undefined
): Array<keyof StreamCapabilities> {
  const g = capabilitiesForLevel(grantedLevel);
  const o = capabilitiesForLevel(offeredLevel);
  return (Object.keys(g) as Array<keyof StreamCapabilities>).filter((c) => g[c] && !o[c]);
}

/** The capability names, in a fixed order. */
const CAPABILITY_NAMES: ReadonlyArray<keyof StreamCapabilities> =
  Object.freeze(['read', 'create', 'update', 'manage', 'list']);

/**
 * The level whose capability set is EXACTLY `combine(cap(a), cap(b))`, or
 * `null` when no level has that set. Derived from `capabilitiesForLevel`, so
 * the merge rules can never drift from what an access grants. `none` is
 * matched before the other levels (it is the only level with no capability).
 */
function levelForCapabilities (wanted: StreamCapabilities): PermissionLevel | null {
  for (const level of PERMISSION_LEVEL_VALUES) {
    const caps = capabilitiesForLevel(level);
    if (CAPABILITY_NAMES.every((c) => caps[c] === wanted[c])) return level;
  }
  return null;
}

function combineLevels (
  a: PermissionLevel, b: PermissionLevel, combine: (x: boolean, y: boolean) => boolean
): PermissionLevel | null {
  const ca = capabilitiesForLevel(a);
  const cb = capabilitiesForLevel(b);
  const wanted = {} as StreamCapabilities;
  for (const c of CAPABILITY_NAMES) wanted[c] = combine(ca[c], cb[c]);
  return levelForCapabilities(wanted);
}

/**
 * The level granting exactly the union of what `a` and `b` grant, or `null`
 * when no level does. There is no rounding up: `read` with `create-only` is
 * {read, create, list}, which no level grants (`contribute` would add
 * `update`, which neither side consented to).
 */
function joinLevel (a: PermissionLevel, b: PermissionLevel): PermissionLevel | null {
  return combineLevels(a, b, (x, y) => x || y);
}

/**
 * The level granting exactly what both `a` and `b` grant, or `null` when no
 * level does: `read` with `create-only` share only {list}, which is no level
 * (the stream then gets no entry at all).
 */
function meetLevel (a: PermissionLevel, b: PermissionLevel): PermissionLevel | null {
  return combineLevels(a, b, (x, y) => x && y);
}

/** One stream on which two permission sets hold levels that cannot be joined. */
type PermissionMergeConflict = { streamId: string; current: PermissionLevel; incoming: PermissionLevel };

/**
 * Thrown when two permission sets give one stream levels whose union is no
 * level (`read` and `create-only`, in either order).
 */
class PermissionMergeConflictError extends Error {
  code = 'permission-level-conflict';
  conflicts: PermissionMergeConflict[];
  constructor (conflicts: PermissionMergeConflict[]) {
    super(conflicts.map((c) =>
      `stream "${c.streamId}" is held at level "${c.current}" and requested at level "${c.incoming}": ` +
      'no level grants exactly both; "contribute" is the level covering both').join('; '));
    this.name = 'PermissionMergeConflictError';
    this.conflicts = conflicts;
  }
}

type MergeSide = {
  /** Stream entries by canonical id, and feature settings by feature name. */
  streams: Map<string, StreamPermission>;
  features: Map<string, string>;
  /** Entry keys (`s|<canonical id>` / `f|<feature>`) in first-seen order. */
  order: string[];
};

/**
 * Index one side of a merge. Two entries for one stream (in any spelling)
 * collapse to the LAST one, which is what an access applies when it loads
 * such a row; the collapsed entry keeps the position of the first. Two
 * entries for one feature collapse to `forbidden` if either is, which is how
 * a restriction is enforced (`isFeatureForbidden`).
 */
function indexForMerge (perms: unknown): MergeSide {
  const side: MergeSide = { streams: new Map(), features: new Map(), order: [] };
  for (const p of normalizePermissions(perms)) {
    if (isStreamPermission(p)) {
      const key = 's|' + canonicalStreamId(p.streamId);
      if (!side.streams.has(key)) side.order.push(key);
      side.streams.set(key, p);
    } else {
      const f = p as FeaturePermission;
      const key = 'f|' + f.feature;
      const known = side.features.get(key);
      if (known == null) side.order.push(key);
      side.features.set(key, known === 'forbidden' ? known : f.setting);
    }
  }
  return side;
}

/**
 * Merge two permission sets stream by stream.
 *
 * - `join` (a consent adding to what is already granted): a stream in both
 *   sets gets `joinLevel`; when there is none, the stream is reported in
 *   `conflicts` and left out; a stream in one set only is kept. A feature is
 *   `forbidden` if either set forbids it (a restriction once consented is
 *   kept), else `allowed`.
 * - `meet` (what a session may still use under its grant): a stream in both
 *   sets gets `meetLevel`, and is left out when there is none; a stream in
 *   one set only is left out. A feature is `forbidden` if either set forbids
 *   it (the grant's restrictions always reach the session), `allowed` when
 *   both allow it, left out otherwise.
 *
 * Streams are identified by their canonical id (`a` and `:local:a` are one
 * stream). An emitted stream entry is the one of the side whose level is
 * kept (its `streamId` spelling, `defaultName`, `name`), `current`'s when the
 * levels are equal. Order: `current`'s entries first, in their order, then
 * the new ones in `incoming`'s order, so a merge that changes nothing returns
 * `current` as it was (consent annotations dropped, duplicates collapsed).
 */
function mergeStreamPermissions (current: unknown, incoming: unknown, mode: 'join' | 'meet'):
{ permissions: Permission[]; conflicts: PermissionMergeConflict[] } {
  const cur = indexForMerge(current);
  const inc = indexForMerge(incoming);
  const conflicts: PermissionMergeConflict[] = [];
  const out: Permission[] = [];
  const keys = cur.order.concat(inc.order.filter((k) => !cur.streams.has(k) && !cur.features.has(k)));
  for (const key of keys) {
    if (key.startsWith('s|')) {
      const c = cur.streams.get(key);
      const i = inc.streams.get(key);
      if (c == null || i == null) {
        if (mode === 'join') out.push((c ?? i) as StreamPermission);
        continue;
      }
      const level = mode === 'join' ? joinLevel(c.level, i.level) : meetLevel(c.level, i.level);
      if (level == null) {
        if (mode === 'join') conflicts.push({ streamId: key.slice(2), current: c.level, incoming: i.level });
        continue;
      }
      out.push(level === c.level ? c : i);
    } else {
      const c = cur.features.get(key);
      const i = inc.features.get(key);
      let setting: string | null;
      if (c === 'forbidden' || i === 'forbidden') setting = 'forbidden';
      else if (mode === 'join') setting = 'allowed';
      else setting = (c === 'allowed' && i === 'allowed') ? 'allowed' : null;
      if (setting != null) out.push({ feature: key.slice(2), setting });
    }
  }
  return { permissions: out, conflicts };
}

/** Drop consent-layer annotations (`mandatory`, `optIn`): call before
 * anything that mints or updates a real access row. */
function stripConsentAnnotations (perms: ConsentPermission[]): Permission[] {
  return perms.map((p) => {
    const { mandatory: _mandatory, optIn: _optIn, ...rest } =
      p as ConsentPermission & Record<string, unknown>;
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
 *
 * `optIn` is deliberately NOT read here. It sets how a consent screen
 * opens (unselected rather than pre-selected), which is a presentation
 * choice; what the user may then grant is unchanged. So this rule
 * returns the same verdict for an offer with and without `optIn` on
 * any entry, and an opt-in entry the user leaves unticked is simply an
 * entry that is not in `granted`.
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
  INHERITED_RESTRICTION_FEATURES,
  isFeatureForbidden,
  isStreamPermission,
  isFeaturePermission,
  normalizePermissions,
  stripConsentAnnotations,
  permissionKey,
  isPermissionSubset,
  checkConsentGrant,
  capabilitiesForLevel,
  levelCapabilityExcess,
  joinLevel,
  meetLevel,
  mergeStreamPermissions,
  PermissionMergeConflictError
};
export type { PermissionMergeConflict };
