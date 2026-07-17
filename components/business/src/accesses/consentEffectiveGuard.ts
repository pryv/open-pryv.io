/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */

/**
 * Consent effective-permission guard — the tree-aware half of the
 * consent-grant rule.
 *
 * `permissionSet.checkConsentGrant` enforces `granted ⊆ offered` by EXACT
 * ENTRY (dropping an entry = narrowing). That is sound only when every
 * entry is a positive, independent grant. Under the STREAM HIERARCHY it
 * is not: an offered entry that is more restrictive than an inherited
 * ancestor grant acts as a MASK, so dropping it WIDENS effective access.
 * Examples (all pass the pure entry-subset check, all widen):
 *   - `[{'*',manage},{secret,read}]`  → drop `{secret,read}`   → secret gains manage
 *   - `[{'*',read},{X,create-only}]`  → drop `{X,create-only}` → X gains read
 *   - `[{A,read},{A.child,create-only}]` (A.child under A) → drop → child gains read
 * The `create-only` cases defeat any numeric-rank test (create-only ranks
 * ABOVE read yet masks reads), and ancestry is by `parentId` in the
 * stream store — not derivable from the flat streamId strings. So the only
 * correct check resolves each level THROUGH the user's stream tree.
 *
 * This guard does exactly that by reusing `AccessLogic`'s resolution
 * (ancestor walk + `'*'` fallback + store expansion) for both the granted
 * and the offered permission sets, then comparing per-capability at every
 * offered streamId via the pure `levelCapabilityExcess`. It runs at the
 * accept paths (oauth2 `/accept`, cmc native accept) where the user
 * context / mall exists — `permissionSet` itself stays pure (no tree).
 *
 * SCOPE: stream permissions only. Feature permissions (`selfRevoke` /
 * `selfAudit` `forbidden`) are a self-limiting axis, not stream data
 * access, and are not part of the masking class; they are left to the
 * pure entry-subset check.
 */

import type { Permission, StreamPermission, PermissionLevel } from '../types/public.ts';
import type { StreamCapabilities } from './permissionSet.ts';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);

// permissionSet is pure (types only) — safe to load eagerly. AccessLogic
// pulls the mall + boiler chain, so it is required LAZILY inside the
// production resolver: callers that inject resolvers (tests) never load it.
const { levelCapabilityExcess } = require('./permissionSet.ts');

/** Resolve a permission set's EFFECTIVE level at a stream (through the
 * hierarchy) — the seam the AccessLogic backing plugs into, and the seam
 * tests inject a fake tree through. */
export type LevelResolver = (fullStreamId: string) => Promise<PermissionLevel | null | undefined>;

export type ConsentEffectiveViolation = {
  streamId: string;
  /** Capabilities granted would confer at `streamId` that offered does not. */
  excess: Array<keyof StreamCapabilities>;
};

export type ConsentEffectiveCheck =
  | { ok: true }
  | { ok: false; violations: ConsentEffectiveViolation[] };

function streamPermissions (perms: Permission[]): StreamPermission[] {
  return perms.filter((p): p is StreamPermission =>
    typeof (p as StreamPermission).streamId === 'string' &&
    (p as StreamPermission).streamId.length > 0);
}

/**
 * Pure decision core: for each offered streamId, compare the granted vs
 * offered effective level and flag any capability granted confers that
 * offered does not. Checking the offered streamIds is sufficient — every
 * mask originates at a dropped offered entry's own streamId, and a broader
 * grant there also covers each of its descendants.
 */
async function evaluateExcess (params: {
  offeredStreamIds: string[];
  resolveGranted: LevelResolver;
  resolveOffered: LevelResolver;
}): Promise<ConsentEffectiveViolation[]> {
  const { offeredStreamIds, resolveGranted, resolveOffered } = params;
  const violations: ConsentEffectiveViolation[] = [];
  const seen = new Set<string>();
  for (const streamId of offeredStreamIds) {
    if (seen.has(streamId)) continue;
    seen.add(streamId);
    const grantedLevel = await resolveGranted(streamId);
    const offeredLevel = await resolveOffered(streamId);
    const excess = levelCapabilityExcess(grantedLevel, offeredLevel);
    if (excess.length > 0) violations.push({ streamId, excess });
  }
  return violations;
}

/**
 * Build a permission-resolving `AccessLogic` for a bare permission list.
 * type `app` + NO id ⇒ the constructor skips the account-stream `none`
 * unshift and the `:_audit:` injection (see AccessLogic ctor: `if (!this.id)
 * return`), so we resolve the CONSENT permissions themselves, not a minted
 * access's system-augmented set. Both granted and offered are built
 * identically, so the comparison is apples-to-apples.
 */
async function accessLogicResolver (userId: string, permissions: Permission[]): Promise<LevelResolver> {
  const AccessLogic = require('./AccessLogic.ts').default;
  const logic = new AccessLogic(userId, { type: 'app', permissions: permissions.slice() });
  await logic.loadPermissions();
  return (fullStreamId: string) => logic._getStreamPermissionLevel(fullStreamId);
}

/**
 * Assert that `granted` confers no more effective stream access than
 * `offered` anywhere in the user's stream tree. `granted` is expected to
 * have already passed `checkConsentGrant` (exact-entry ⊆ `offered`); this
 * closes the hierarchical-masking gap that check cannot see.
 *
 * `resolvers` is an injection seam for tests (a fake tree); production
 * omits it and the guard resolves through `AccessLogic` + the live mall.
 */
async function assertGrantedWithinOffer (params: {
  userId: string;
  granted: Permission[];
  offered: Permission[];
  resolvers?: { granted: LevelResolver; offered: LevelResolver };
}): Promise<ConsentEffectiveCheck> {
  const { userId, granted, offered, resolvers } = params;
  const offeredStreamIds = streamPermissions(offered).map((p) => p.streamId);
  if (offeredStreamIds.length === 0) return { ok: true };

  const resolveGranted = resolvers?.granted ?? await accessLogicResolver(userId, granted);
  const resolveOffered = resolvers?.offered ?? await accessLogicResolver(userId, offered);

  const violations = await evaluateExcess({ offeredStreamIds, resolveGranted, resolveOffered });
  return violations.length === 0 ? { ok: true } : { ok: false, violations };
}

export { assertGrantedWithinOffer, evaluateExcess };
