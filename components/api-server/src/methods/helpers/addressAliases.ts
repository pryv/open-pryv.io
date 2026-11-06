/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */

/**
 * Address aliases: names the account owner mints for the account (personal
 * token only), each an address of the account like its username
 * (`https://<alias>.<domain>/...`: the platform routes it to the account's
 * core, the embedded DNS answers it). One is held by no access until an
 * OAuth consent bound to that address adopts it: the grant then carries it as
 * its alias (the app knows the account by that name only), with every session
 * of the grant. One grant per address alias. It is released when that grant
 * is fully withdrawn, or when the owner deletes it (which withdraws the grant
 * that holds it).
 */

import { fromCallback } from 'utils';
import { getStorageLayer } from 'storage';
import { getUsersRepository } from 'business/src/users/index.ts';
import { isAddressAliasShape } from 'business/src/users/aliasShape.ts';
import { REGISTRY_GRANT_PREFIX, REGISTRY_GRANT_DEVICE } from '../../routes/oauth2/types.ts';

/** How many address aliases one account may hold, adopted or not. */
export const MAX_ADDRESS_ALIASES = 10;

/** The reason a consent or an adoption gives when the address alias is not the account's to give. */
export const ADDRESS_ALIAS_UNAVAILABLE = 'address-alias-unavailable';

/** The members of an access row read here. */
export type AliasHolderRow = {
  id: string;
  type?: string;
  name?: string;
  deviceName?: string | null;
  alias?: string;
  created?: number;
  clientData?: { oauth?: { grantOf?: unknown } } | null;
};

type AccountRef = { id: string; username: string };
type NodeCallback = (err: Error | null, result?: unknown) => void;

const dbFindOptions = { projection: { calls: 0, deleted: 0 } };

/** The account's address aliases, held or not. */
export async function addressAliasesOfAccount (userId: string): Promise<string[]> {
  return await (await getUsersRepository()).getAddressAliasesForUserId(userId);
}

/**
 * The account's live accesses (not deleted; an expired one still holds its
 * alias) carrying an address alias, by alias.
 */
export async function addressAliasHolders (user: AccountRef): Promise<Map<string, AliasHolderRow[]>> {
  const storageLayer = await getStorageLayer();
  const rows = await fromCallback((cb: NodeCallback) => storageLayer.accesses.find(user, {}, dbFindOptions, cb)) as AliasHolderRow[] | null;
  const byAlias = new Map<string, AliasHolderRow[]>();
  for (const row of rows ?? []) {
    if (typeof row.alias !== 'string' || !isAddressAliasShape(row.alias)) continue;
    const list = byAlias.get(row.alias) ?? [];
    list.push(row);
    byAlias.set(row.alias, list);
  }
  return byAlias;
}

/** Whether `row` is the consent grant of a registry OAuth client (and of `clientId`, when given). */
export function isRegistryGrantRow (row: AliasHolderRow, clientId?: string): boolean {
  if (row.type !== 'app' || row.deviceName !== REGISTRY_GRANT_DEVICE || typeof row.name !== 'string') return false;
  return clientId == null ? row.name.startsWith(REGISTRY_GRANT_PREFIX) : row.name === REGISTRY_GRANT_PREFIX + clientId;
}

/**
 * The address aliases a consent of `clientId` may bind: the account's address
 * aliases no access holds, and the one this client's grant holds already (a
 * re-authorization at the same address). An alias another grant holds is
 * never one of them. Without a client, the unheld ones only.
 */
export async function bindableAddressAliases (user: AccountRef, clientId?: string | null): Promise<string[]> {
  const aliases = await addressAliasesOfAccount(user.id);
  if (aliases.length === 0) return [];
  const holders = await addressAliasHolders(user);
  return aliases.filter((alias) => {
    const rows = holders.get(alias);
    if (rows == null || rows.length === 0) return true;
    return clientId != null && rows.some((row) => isRegistryGrantRow(row, clientId));
  });
}

/** The access a holder list names as the alias's holder: the grant, or the first row. */
export function holderOf (rows: AliasHolderRow[]): AliasHolderRow | null {
  return rows.find((row) => isRegistryGrantRow(row)) ?? rows[0] ?? null;
}
