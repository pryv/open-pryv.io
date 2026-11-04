/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */

/**
 * The operator's purge of an OAuth client on THIS core
 * (`bin/oauth-client.js purge-grants <clientId>`): for every account of the
 * core, every grant of the client is deleted with what it holds (its
 * sessions, the accesses those created, the aliases, the refresh chains):
 * its registry grants, and the consent grants its sessions are bound to (the
 * CMC data-grant of an app-account client); then any access still minted for
 * the client (a session without a grant, a client_credentials token), each
 * with its chain; last, every refresh token of the client left in this
 * core's keyspace is ended. Each user's next authorization is a fresh
 * consent.
 *
 * Deletion goes through `deleteAccessChain`, the teardown of
 * `accesses.delete`, so each row leaves a deletion record and the access
 * index is tombstoned. It does not run the route's post-delete hooks: the
 * counterparty of a deleted CMC data-grant is not sent a revoke notice (its
 * reach through the grant ends all the same).
 */

import { fromCallback } from 'utils';
import { getConfig } from '@pryv/boiler';
import { getStorageLayer, getUsersLocalIndex } from 'storage';
import * as storages from 'storages';
import * as oauthStorage from 'oauth2/src/storage.ts';
import { parseAccessRef } from 'business/src/accesses/refs.ts';
import type { PlatformDB } from '../../../../../storages/interfaces/platformStorage/PlatformDB.ts';
import { deleteAccessChain } from './accessDeletion.ts';
import { REGISTRY_GRANT_PREFIX, REGISTRY_GRANT_DEVICE, SESSION_NAME_PREFIX } from '../../routes/oauth2/types.ts';

type AccessRow = {
  id: string;
  type?: string;
  name?: string;
  deviceName?: string;
  clientData?: { oauth?: { grantOf?: unknown; dataGrantId?: unknown; exchange?: unknown } } | null;
};
type NodeCallback = (err: Error | null, result?: unknown) => void;

export type PurgeCounts = {
  /** Accounts of this core where something was deleted. */
  accounts: number;
  /** Grants (consent records: registry grants, CMC data-grants) deleted. */
  grants: number;
  /** Accesses minted for the client (sessions, client_credentials tokens) deleted. */
  sessions: number;
  /** Every access deleted (the above, plus what the sessions created). */
  accesses: number;
  /** Refresh tokens ended by the keyspace sweep (those of the deleted sessions end with them). */
  refreshTokens: number;
};

const dbFindOptions = { projection: { calls: 0, deleted: 0 } };

function isRegistryGrantOf (a: AccessRow, clientId: string): boolean {
  return a?.type === 'app' && (
    (a.name === REGISTRY_GRANT_PREFIX + clientId && a.deviceName === REGISTRY_GRANT_DEVICE) ||
    a.clientData?.oauth?.grantOf === clientId);
}

function isMintedFor (a: AccessRow, clientId: string): boolean {
  return a?.type === 'app' && a.name === SESSION_NAME_PREFIX + clientId;
}

/**
 * The grants of `clientId` among an account's accesses: registry grants, and
 * those its sessions are bound to. Not the grant of a derived session (token
 * exchange): it is the grant of the client the subject token was issued to,
 * and purging the resource server deletes its derived sessions only.
 */
function grantsOf (all: AccessRow[], clientId: string): AccessRow[] {
  const bound = new Set(all.filter((a) => isMintedFor(a, clientId) && a.clientData?.oauth?.exchange == null)
    .map((a) => a.clientData?.oauth?.dataGrantId)
    .filter((id): id is string => typeof id === 'string')
    .map((id) => parseAccessRef(id).base));
  return all.filter((a) => a?.type !== 'personal' && (isRegistryGrantOf(a, clientId) || bound.has(parseAccessRef(a.id).base)));
}

/** Purge `clientId`'s grants, sessions and chains on this core. */
export async function purgeClientGrants (clientId: string): Promise<PurgeCounts> {
  if (typeof clientId !== 'string' || clientId.length === 0) throw new Error('clientId required');
  const counts: PurgeCounts = { accounts: 0, grants: 0, sessions: 0, accesses: 0, refreshTokens: 0 };
  const storageLayer = await getStorageLayer();
  const usersIndex = await getUsersLocalIndex();
  const users: Record<string, string> = await usersIndex.getAllByUsername();
  for (const [username, userId] of Object.entries(users)) {
    const user = { id: userId, username };
    const find = async (): Promise<AccessRow[]> =>
      (await fromCallback((cb: NodeCallback) => storageLayer.accesses.find(user, {}, dbFindOptions, cb)) as AccessRow[]) ?? [];
    const before = await find();
    const grants = grantsOf(before, clientId);
    const minted = new Set(before.filter((a) => isMintedFor(a, clientId)).map((a) => a.id));
    if (grants.length === 0 && minted.size === 0) continue;
    const deleted = new Set<string>();
    const remember = (outcome: { deleted: boolean; relatedDeletions: Array<{ id: string }> }, id: string): void => {
      if (!outcome.deleted) return;
      deleted.add(id);
      for (const r of outcome.relatedDeletions) deleted.add(r.id);
    };
    for (const grant of grants) {
      if (deleted.has(grant.id)) continue;
      const outcome = await deleteAccessChain(user, { id: grant.id });
      remember(outcome, grant.id);
      if (outcome.deleted) counts.grants++;
    }
    // What is still minted for the client (no grant behind it).
    for (const a of (await find()).filter((r) => isMintedFor(r, clientId))) {
      remember(await deleteAccessChain(user, { id: a.id }), a.id);
    }
    counts.sessions += [...minted].filter((id) => deleted.has(id)).length;
    counts.accesses += deleted.size;
    if (deleted.size > 0) counts.accounts++;
  }
  const platform = storages.platformDB as PlatformDB | undefined;
  if (platform != null) {
    const coreId = String((await getConfig()).get('core:id') ?? 'single');
    counts.refreshTokens = await oauthStorage.revokeClientRefreshTokens(platform, coreId, clientId);
  }
  return counts;
}
