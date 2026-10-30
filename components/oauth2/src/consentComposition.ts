/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */

/**
 * OAuth2: what the consent screen of a registry client shows on a
 * re-authorization, and what the grant becomes after it.
 *
 * The screen shows the COMPOSITION of the user's current grant and the
 * request: one entry per stream at the level covering both (a stream held at
 * `read` and requested at `create-only` has none: the consent is refused).
 * Entries the grant already holds are flagged `currentlyGranted` (shown
 * ticked; a stream entry also carries `currentLevel`, the level held now);
 * a new entry the request marks `optIn` is shown unticked. The
 * grant's forbidden features stay on the screen, locked. The core's own
 * default forbids are never shown: they are applied after every consent.
 *
 * `shownDigest` binds that screen. A consent posting it back proves the user
 * saw the composition, so the grant becomes exactly what was ticked (an
 * untick narrows). A consent without it (a consent UI that does not know the
 * composition) is joined into the grant: it never narrows.
 *
 * Pure: no I/O, no clock.
 */

import crypto from 'node:crypto';
import type { OAuthClient } from './storage.ts';
import type { ExtPermission, SynthOffer } from './extension.ts';
import type { Permission } from 'business/src/types/public.ts';
import { canonicalJson } from './scopeGrammar.ts';
import { defaultForbiddenFeatures } from './clientRegistry.ts';
import {
  mergeStreamPermissions, isStreamPermission, isFeaturePermission, normalizePermissions,
  PermissionMergeConflictError,
} from 'business/src/accesses/permissionSet.ts';
import { canonicalStreamId } from 'mall/src/helpers/storeDataUtils.ts';

/** How the app sees the user: the stable account id, or the grant's alias. */
export type SubjectMode = 'pseudonym' | 'account';

/** A change of subject mode between the current grant and the request. */
export type SubjectChange = { from: SubjectMode; to: SubjectMode };

/** The user's current grant for the client, as the composition needs it. */
export type CurrentGrant = {
  permissions: ExtPermission[];
  /** The grant carries an alias (the app sees a pseudonym). */
  aliased: boolean;
};

/** The offer shown on the consent screen; entries may carry `currentlyGranted`. */
export type ShownOffer = SynthOffer & { allowUserChoice: boolean };

export type Composition =
  | { ok: true; shown: ShownOffer; subjectChange: SubjectChange | null; shownDigest: string }
  | { ok: false; error: PermissionMergeConflictError };

export function subjectModeOf (aliased: boolean): SubjectMode {
  return aliased ? 'pseudonym' : 'account';
}

/**
 * Compose the consent screen from the requested offer (as re-derived from the
 * signed state, with its digest) and the user's current grant (null: none).
 */
export function composeShownOffer (
  requested: { offer: SynthOffer; digest: string },
  current: CurrentGrant | null,
  client: OAuthClient
): Composition {
  const requestedPermissions = requested.offer.permissions;
  let permissions: ExtPermission[];
  let subjectChange: SubjectChange | null = null;
  if (current == null) {
    permissions = requestedPermissions.map((p) => ({ ...p }));
  } else {
    const from = subjectModeOf(current.aliased);
    const to = subjectModeOf(requested.offer.randomAlias === true);
    if (from !== to) subjectChange = { from, to };

    const requestedStreams = requestedPermissions.filter(isStreamPermission);
    // Exclusion masks of the grant are restrictions, not something to tick:
    // never shown (they are kept by the next grant, see nextGrantPermissions).
    const currentStreams = (current.permissions ?? []).filter((p) => isStreamPermission(p) && p.level !== 'none');
    const joined = mergeStreamPermissions(currentStreams, normalizePermissions(requestedStreams), 'join');
    if (joined.conflicts.length > 0) return { ok: false, error: new PermissionMergeConflictError(joined.conflicts) };
    const requestedById = new Map<string, ExtPermission>(requestedStreams.map((p) => [canonicalStreamId(p.streamId), p]));
    // The level each stream is held at now: the screen says what the app holds
    // (an entry the request widens shows both levels).
    const heldLevels = new Map<string, string>(currentStreams.map((p) => [canonicalStreamId(String(p.streamId)), String(p.level)]));
    permissions = [];
    for (const p of joined.permissions) {
      if (!isStreamPermission(p)) continue;
      const id: string = canonicalStreamId(p.streamId);
      const r = requestedById.get(id);
      const out: ExtPermission = { streamId: p.streamId, level: p.level };
      if (r?.mandatory === true) out.mandatory = true;
      const held = heldLevels.get(id);
      if (held != null) {
        out.currentlyGranted = true;
        out.currentLevel = held;
      } else if (r?.optIn === true) {
        out.optIn = true;
      }
      permissions.push(out);
    }

    const currentFeatures = (current.permissions ?? []).filter(isFeaturePermission);
    const currentForbids = new Set<string>(currentFeatures.filter((p) => p.setting === 'forbidden').map((p) => p.feature));
    const currentFeatureNames = new Set<string>(currentFeatures.map((p) => p.feature));
    const requestedFeatures = requestedPermissions.filter(isFeaturePermission);
    for (const f of requestedFeatures) {
      const out: ExtPermission = currentForbids.has(f.feature)
        ? { feature: f.feature, setting: 'forbidden', mandatory: true }
        : { ...f };
      // A held entry opens ticked: never opt-in.
      if (currentFeatureNames.has(f.feature)) {
        out.currentlyGranted = true;
        delete out.optIn;
      }
      permissions.push(out);
    }
    // The grant's own restrictions stay visible (locked), except the core's
    // default forbids, which are never shown.
    const defaults = new Set<string>(defaultForbiddenFeatures(client));
    const requestedNames = new Set<string>(requestedFeatures.map((p) => p.feature));
    for (const feature of currentForbids) {
      if (requestedNames.has(feature) || defaults.has(feature)) continue;
      permissions.push({ feature, setting: 'forbidden', mandatory: true, currentlyGranted: true });
    }
  }
  const shown: ShownOffer = { ...requested.offer, permissions, allowUserChoice: requested.offer.allowUserChoice === true };
  return { ok: true, shown, subjectChange, shownDigest: shownDigestOf(requested.digest, shown, subjectChange) };
}

/**
 * Digest of a composed screen: the requested offer's digest, the shown offer
 * and the subject change. The entry order of the shown offer does not count.
 */
export function shownDigestOf (offerDigest: string, shown: ShownOffer, subjectChange: SubjectChange | null): string {
  const sorted = { ...shown, permissions: [...shown.permissions].sort((a, b) => sortKey(a).localeCompare(sortKey(b))) };
  return crypto.createHash('sha256')
    .update(canonicalJson({ offerDigest, shown: sorted, subjectChange }))
    .digest('base64url');
}

function sortKey (p: ExtPermission): string {
  if (isStreamPermission(p)) return 's|' + canonicalStreamId(p.streamId);
  return 'f|' + String(p.feature);
}

/**
 * The permissions of the grant after a consent of a registry client.
 *
 * - `replace` (the consent screen showed the composition, `shownDigest`):
 *   exactly what the user ticked, plus the current grant's restrictions
 *   (its forbidden features, and its exclusion masks on streams the consent
 *   does not name).
 * - otherwise: what the user ticked joined into the current grant (never
 *   narrows). A level conflict throws `PermissionMergeConflictError`.
 *
 * Then the client's default forbids; a forbid always wins over an allow.
 */
export function nextGrantPermissions ({ granted, current, client, replace }: {
  granted: ExtPermission[];
  current: CurrentGrant | null;
  client: OAuthClient;
  replace: boolean;
}): Permission[] {
  const plain = normalizePermissions(granted);
  let base: unknown[];
  if (current == null) {
    base = plain;
  } else if (replace) {
    const kept = (current.permissions ?? []).filter((p) =>
      (isFeaturePermission(p) && p.setting === 'forbidden') || (isStreamPermission(p) && p.level === 'none'));
    base = mergeStreamPermissions(plain, kept, 'join').permissions;
  } else {
    const merged = mergeStreamPermissions(current.permissions ?? [], plain, 'join');
    if (merged.conflicts.length > 0) throw new PermissionMergeConflictError(merged.conflicts);
    base = merged.permissions;
  }
  const defaults = defaultForbiddenFeatures(client).map((feature) => ({ feature, setting: 'forbidden' }));
  return mergeStreamPermissions(base, defaults, 'join').permissions;
}
