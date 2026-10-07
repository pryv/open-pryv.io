/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);

/**
 * Read-only check of the accesses an app access created: does any of them
 * reach further than its creator? Two cases:
 *   - `exceeds-level`: a granted stream is above the creator's level there;
 *   - `reaches-carve-out`: a broad grant covers a stream where the creator
 *     holds a narrower entry (`none`, `create-only` or a lower level) that the
 *     child does not carry.
 * Nothing is written: the creator's check runs on copies.
 */

const AccessLogic = require('./AccessLogic.ts').default;
const { managingAccessBase } = require('./refs.ts');

type AccessRow = {
  id?: string;
  type?: string;
  createdBy?: unknown;
  permissions?: Array<Record<string, unknown>>;
  [k: string]: unknown;
};

export type ScopeFinding = {
  accessId: string;
  type: string;
  creatorId: string;
  reason: 'exceeds-level' | 'reaches-carve-out';
  // narrower creator entries the child does not carry (reaches-carve-out only)
  missingEntries: number;
};

export type ScopeAuditResult = {
  checked: number; // accesses created by a non-personal access
  creatorGone: number; // created by a non-personal access that is deleted or unknown
  findings: ScopeFinding[];
};

/**
 * @param accesses the user's live accesses (the ones checked)
 * @param deleted the user's deleted accesses, used only to tell the type of a
 *   creator that is gone
 */
export async function auditAccessScope (userId: string, accesses: AccessRow[], deleted: AccessRow[] = []): Promise<ScopeAuditResult> {
  const result: ScopeAuditResult = { checked: 0, creatorGone: 0, findings: [] };
  const byId = new Map<string, AccessRow>();
  for (const a of accesses) if (typeof a?.id === 'string') byId.set(a.id, a);
  const deletedTypes = new Map<string, string>();
  for (const a of deleted) if (typeof a?.id === 'string') deletedTypes.set(a.id, String(a.type));

  for (const child of accesses) {
    if (child == null || child.type === 'personal' || typeof child.createdBy !== 'string') continue;
    let creatorId: string;
    try {
      creatorId = managingAccessBase(child.createdBy);
    } catch (_e) {
      continue; // not an access reference
    }
    if (creatorId === child.id) continue;
    const creator = byId.get(creatorId);
    if (creator == null) {
      if (deletedTypes.get(creatorId) !== 'personal') result.creatorGone++;
      continue;
    }
    if (creator.type === 'personal') continue; // the owner reaches everything

    const streamPerms = (child.permissions ?? [])
      .filter((p) => typeof p?.streamId === 'string')
      .map((p) => ({ streamId: p.streamId, level: p.level }));
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
      .filter((p: Record<string, unknown>) => typeof p?.streamId === 'string').length;
    if (added > 0) {
      result.findings.push({ accessId: child.id!, type: String(child.type), creatorId, reason: 'reaches-carve-out', missingEntries: added });
    }
  }
  return result;
}

