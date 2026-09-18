/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */

/**
 * OAuth2: revoke the accesses behind expired, never-exchanged
 * authorization codes. Run by the master's periodic sweep BEFORE the generic
 * sweep removes the expired rows.
 *
 * An expired code row that still exists was never exchanged (the /token
 * consume is atomic single-use), so the access pre-minted at /accept is an
 * orphan, alive until its own (short) TTL.
 *
 * - Current rows (`oauth-ac/`) carry the access id and the issuing core id,
 *   never the token: only the issuing core can delete the access, from its
 *   own storage. Rows of other cores are left to their own core.
 * - Legacy rows (`oauth-code/`, from before hashed codes) carry the token and
 *   are revoked over HTTP as before.
 *
 * Best-effort: a failed revoke is counted as not revoked; the access then dies
 * by its own TTL and the row is swept regardless.
 */

import type { PlatformDB } from '../../../storages/interfaces/platformStorage/PlatformDB.ts';
import { revokeOrphanAccess } from './orphanAccess.ts';

export type OrphanSweepDeps = {
  platform: PlatformDB;
  /** `core:id` of the core running the sweep. */
  coreId: string;
  /** Delete an access from this core's storage. */
  revokeLocal: (params: { userId: string; username: string; accessId: string; clientId: string }) => Promise<void>;
  /** Canonical username for a user id on this core, or null when absent (code rows carry the id only). */
  resolveUsername: (userId: string) => Promise<string | null>;
  /** Legacy HTTP self-revoke; injectable for tests. */
  revokeHttp?: typeof revokeOrphanAccess;
  /** Upper bound of revokes per call, to keep one sweep tick bounded. */
  maxPerTick?: number;
};

export async function revokeExpiredCodeOrphans (deps: OrphanSweepDeps): Promise<number> {
  const max = deps.maxPerTick ?? 300;
  const revokeHttp = deps.revokeHttp ?? revokeOrphanAccess;
  let revoked = 0;
  let attempts = 0;

  const current = await deps.platform.listExpiredAccessStates('oauth-ac/');
  for (const { value } of current) {
    if (attempts >= max) return revoked;
    const v = (value ?? {}) as Record<string, unknown>;
    if (v.coreId !== deps.coreId) continue;
    if (typeof v.accessId !== 'string' || typeof v.userId !== 'string' || typeof v.clientId !== 'string') continue;
    attempts++;
    try {
      // A user gone since /accept took the access with their storage.
      const username = await deps.resolveUsername(v.userId);
      if (username == null) continue;
      await deps.revokeLocal({ userId: v.userId, username, accessId: v.accessId, clientId: v.clientId });
      revoked++;
    } catch {
      // best-effort, see header
    }
  }

  const legacy = await deps.platform.listExpiredAccessStates('oauth-code/');
  for (const { value } of legacy) {
    if (attempts >= max) return revoked;
    const v = (value ?? {}) as Record<string, unknown>;
    if (typeof v.accessId === 'string' && typeof v.accessToken === 'string' && typeof v.apiEndpoint === 'string') {
      attempts++;
      if (await revokeHttp({ apiEndpoint: v.apiEndpoint, accessToken: v.accessToken, accessId: v.accessId })) revoked++;
    }
  }
  return revoked;
}
