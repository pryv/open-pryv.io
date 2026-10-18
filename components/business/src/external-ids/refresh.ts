/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */

/**
 * Token refresh of this core's external ids, after the derivation changed (a
 * pepper rotation, a switch between cleartext and hashed mode) while the
 * blinded values did not.
 *
 * A local row names its namespace only through `ns_token`. It is matched
 * against each namespace's current token (already fresh), its salt (the
 * cleartext form) and, when the retired pepper is given, the token under that
 * pepper. A matched row gets its current tokens from the stored blinded value,
 * in this order: the local row first, then the new platform key, then the old
 * key deleted. With the local row first, a crash at any step leaves states the
 * plain reconcile heals without the retired pepper: a missing self-row for the
 * new key, a stale self-row for the old one.
 */

import { listNamespaces, getNamespace, namespaceToken, tokensFor, claimRow } from 'platform/src/externalIdIndex.ts';
import type { ExtIdPlatformHandle, ExtIdNamespaceRow } from 'platform/src/externalIdIndex.ts';
import type { ExternalIdsLocalDB } from 'storages/interfaces/baseStorage/ExternalIdsLocalDB.ts';

export interface TokenRefreshSummary {
  fresh: number;
  refreshed: number;
  lostToOtherCore: number;
  namespaceMissing: number;
  corrupt: number;
}

export async function refreshExternalIdTokens (options: {
  platform: ExtIdPlatformHandle,
  db: ExternalIdsLocalDB,
  oldHasher?: { hashFor (field: string, value: string): string } | null,
  dryRun: boolean
}): Promise<TokenRefreshSummary> {
  const { platform, db, oldHasher, dryRun } = options;
  const summary: TokenRefreshSummary = { fresh: 0, refreshed: 0, lostToOtherCore: 0, namespaceMissing: 0, corrupt: 0 };

  const current = new Map<string, ExtIdNamespaceRow>();
  const bySalt = new Map<string, ExtIdNamespaceRow>();
  const byOld = new Map<string, ExtIdNamespaceRow>();
  for (const info of await listNamespaces(platform)) {
    const row = await getNamespace(platform, info.namespace);
    if (row == null) continue;
    current.set(namespaceToken(platform, row), row);
    bySalt.set(row.salt, row);
    if (oldHasher != null) byOld.set(oldHasher.hashFor('ext-id-ns', row.salt), row);
  }

  for (const r of await db.scanAll()) {
    const fresh = current.get(r.nsToken);
    if (fresh != null) {
      summary.fresh++;
      if (tokensFor(platform, fresh, r.blindedValue).valueToken !== r.valueToken) summary.corrupt++;
      continue;
    }
    const ns = bySalt.get(r.nsToken) ?? byOld.get(r.nsToken);
    if (ns == null) {
      summary.namespaceMissing++;
      continue;
    }
    const tokens = tokensFor(platform, ns, r.blindedValue);
    if (dryRun) {
      summary.refreshed++;
      continue;
    }
    const oldNsToken = r.nsToken;
    const oldKey = r.nsToken + '/' + r.valueToken;
    await db.retoken(r.userId, oldNsToken, tokens);
    if (await claimRow(platform, tokens)) summary.refreshed++;
    else summary.lostToOtherCore++;
    await platform.deleteCoreRowIfValue('ext-id/', oldKey, platform.coreId);
  }
  return summary;
}
