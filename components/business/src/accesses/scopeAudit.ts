/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */
import AccessLogic from './AccessLogic.ts';
import { managingAccessBase, SYSTEM_CREATED_BY } from './refs.ts';
import type { Permission, PermissionLevel } from '../types/public.ts';

/**
 * Read-only check of the accesses an app access created: does any of them
 * reach further than its creator? Two cases:
 *   - `exceeds-level`: a granted stream is above the creator's level there;
 *   - `reaches-carve-out`: a broad grant covers a stream where the creator
 *     holds a narrower entry (`none`, `create-only` or a lower level) that the
 *     child does not carry.
 * Nothing is written: the creator's check runs on copies.
 */

// the fields read here; the creator row is handed whole to AccessLogic
type AccessRow = {
  id?: string;
  type?: string;
  createdBy?: unknown;
  expires?: number | null;
  permissions?: Array<Record<string, unknown>>;
};

export type ScopeFinding = {
  accessId: string;
  type: string;
  creatorId: string;
  reason: 'exceeds-level' | 'reaches-carve-out';
  // narrower creator entries the child does not carry (reaches-carve-out only)
  missingEntries: number;
};

/**
 * A live access whose creator is gone and was not personal: it is managed by
 * nothing now. `creator` says how it went: `deleted` when a deletion record
 * names it (a non-personal creator deleted through `accesses.delete` took
 * its accesses with it, so this is rare), `absent` when no row is left at
 * all, which is what a CMC revoke of an `app` consent grant left behind
 * before such a revoke removed the grant's sub-accesses too.
 */
export type OrphanFinding = {
  accessId: string;
  type: string;
  creatorId: string;
  creator: 'deleted' | 'absent';
  expires: number | null;
};

export type ScopeAuditResult = {
  checked: number; // accesses created by a non-personal access
  creatorGone: number; // created by a non-personal access that is deleted or unknown
  findings: ScopeFinding[];
  orphans: OrphanFinding[]; // one per access counted in `creatorGone`
};

/**
 * @param accesses the user's live accesses (the ones checked)
 * @param deleted the user's deleted accesses, used only to tell the type of a
 *   creator that is gone
 */
export async function auditAccessScope (userId: string, accesses: AccessRow[], deleted: AccessRow[] = []): Promise<ScopeAuditResult> {
  const result: ScopeAuditResult = { checked: 0, creatorGone: 0, findings: [], orphans: [] };
  const byId = new Map<string, AccessRow>();
  for (const a of accesses) if (typeof a?.id === 'string') byId.set(a.id, a);
  const deletedTypes = new Map<string, string>();
  for (const a of deleted) if (typeof a?.id === 'string') deletedTypes.set(a.id, String(a.type));

  for (const child of accesses) {
    if (child == null || child.type === 'personal' || typeof child.createdBy !== 'string') continue;
    // Minted by the platform (a consent grant, an OAuth / SSO / MFA session,
    // a delegation marker): no creating access to check against, and not an
    // orphan.
    if (child.createdBy === SYSTEM_CREATED_BY) continue;
    let creatorId: string;
    try {
      creatorId = managingAccessBase(child.createdBy);
    } catch (_e) {
      continue; // not an access reference
    }
    if (creatorId === child.id) continue;
    const creator = byId.get(creatorId);
    if (creator == null) {
      const deletedType = deletedTypes.get(creatorId);
      if (deletedType !== 'personal') {
        result.creatorGone++;
        result.orphans.push({
          accessId: child.id!,
          type: String(child.type),
          creatorId,
          creator: deletedType != null ? 'deleted' : 'absent',
          expires: typeof child.expires === 'number' ? child.expires : null,
        });
      }
      continue;
    }
    if (creator.type === 'personal') continue; // the owner reaches everything

    const streamPerms: Permission[] = (child.permissions ?? [])
      .filter((p) => typeof p?.streamId === 'string')
      .map((p) => ({ streamId: p.streamId as string, level: p.level as PermissionLevel }));
    if (streamPerms.length === 0) continue;
    result.checked++;

    const logic = new AccessLogic(userId, structuredClone(creator));
    await logic.loadPermissions();
    const candidate = { type: 'shared', permissions: streamPerms.slice() };
    const fits = await logic.canCreateAccess(candidate);
    if (!fits) {
      result.findings.push({ accessId: child.id!, type: String(child.type), creatorId, reason: 'exceeds-level', missingEntries: 0 });
      continue;
    }
    const added = candidate.permissions.slice(streamPerms.length)
      .filter((p) => 'streamId' in p && typeof p.streamId === 'string').length;
    if (added > 0) {
      result.findings.push({ accessId: child.id!, type: String(child.type), creatorId, reason: 'reaches-carve-out', missingEntries: added });
    }
  }
  return result;
}

