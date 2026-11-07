/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */

/**
 * The account's address aliases (personal token only): create one (the
 * server mints the name), list them, delete one. See helpers/addressAliases.ts.
 */

import type { MethodNext as Next, ResultBag } from './_types.ts';
import type { MethodContext } from 'business/src/MethodContext.ts';
import { factory as errors, APIError } from 'errors';
import { ApiEndpoint } from 'utils';
import { getConfig } from '@pryv/boiler';
import { basicAccessAuthorizationCheck, getParamsValidation, requirePersonalAccess } from './helpers/commonFunctions.ts';
import * as methodsSchema from '../schema/accountMethods.ts';
import { getUsersRepository } from 'business/src/users/index.ts';
import { parseAccessRef } from 'business/src/accesses/refs.ts';
import { deleteAccessChain } from './helpers/accessDeletion.ts';
import type { AliasHolderRow } from './helpers/addressAliases.ts';
import { MAX_ADDRESS_ALIASES, addressAliasesOfAccount, addressAliasHolders, holderOf, maxAliasesPerAccount } from './helpers/addressAliases.ts';

type Api = { register: (...args: unknown[]) => void };
type AccountRef = { id: string; username: string };

function asApiError (err: unknown) {
  return err instanceof APIError ? err : errors.unexpectedError(err);
}

/** The account the personal token belongs to (set by the access load). */
function accountOf (context: MethodContext): AccountRef {
  const id = context.user?.id;
  if (id == null) throw errors.unexpectedError('address aliases: method called without a loaded user');
  return { id, username: context.user.username };
}

function heldByOf (rows: AliasHolderRow[] | undefined): { accessId: string; clientId?: string } | null {
  const holder = rows != null ? holderOf(rows) : null;
  if (holder == null) return null;
  const clientId = holder.clientData?.oauth?.grantOf;
  return { accessId: holder.id, ...(typeof clientId === 'string' && clientId.length > 0 ? { clientId } : {}) };
}

function viewOf (alias: string, rows: AliasHolderRow[] | undefined) {
  return { alias, apiEndpoint: ApiEndpoint.build(alias, undefined), heldBy: heldByOf(rows) };
}

export default async function (api: Api) {
  api.register('account.addressAliases.create',
    basicAccessAuthorizationCheck,
    getParamsValidation(methodsSchema.addressAliasesCreate.params),
    requirePersonalAccess,
    async function createAddressAlias (context: MethodContext, _params: unknown, result: ResultBag, next: Next) {
      try {
        const account = accountOf(context);
        const usersRepository = await getUsersRepository();
        const held = await addressAliasesOfAccount(account.id);
        if (held.length >= MAX_ADDRESS_ALIASES) {
          return next(errors.invalidOperation(
            'This account already holds ' + held.length + ' address aliases, the most allowed. Delete one it no longer uses first.',
            { addressAliasesLimit: MAX_ADDRESS_ALIASES }
          ));
        }
        const all = (await usersRepository.getAliasesForUserId(account.id)).length;
        const maxAll = maxAliasesPerAccount(await getConfig());
        if (all >= maxAll) {
          return next(errors.invalidOperation(
            'This account already holds ' + all + ' aliases, the most allowed (accesses.maxAliasesPerAccount = ' + maxAll + ').',
            { maxAliasesPerAccount: maxAll }
          ));
        }
        const alias = await usersRepository.mintAlias(account.username, account.id, 'address');
        result.addressAlias = viewOf(alias, undefined);
        next();
      } catch (err) {
        next(asApiError(err));
      }
    }
  );

  api.register('account.addressAliases.list',
    basicAccessAuthorizationCheck,
    getParamsValidation(methodsSchema.addressAliasesList.params),
    requirePersonalAccess,
    async function listAddressAliases (context: MethodContext, _params: unknown, result: ResultBag, next: Next) {
      try {
        const account = accountOf(context);
        const aliases = await addressAliasesOfAccount(account.id);
        const holders = aliases.length > 0 ? await addressAliasHolders(account) : new Map<string, AliasHolderRow[]>();
        result.addressAliases = aliases.map((alias) => viewOf(alias, holders.get(alias)));
        result.addressAliasesLimit = MAX_ADDRESS_ALIASES;
        next();
      } catch (err) {
        next(asApiError(err));
      }
    }
  );

  // Deleting an address alias releases the name (it routes nowhere and no
  // longer answers in the DNS), then withdraws the grant that holds it (its
  // sessions end, its refresh chains end). Released first: from then on no
  // consent can adopt it (the adoption reads the alias index), so a consent
  // racing the deletion is withdrawn by the passes below or refused.
  api.register('account.addressAliases.delete',
    basicAccessAuthorizationCheck,
    getParamsValidation(methodsSchema.addressAliasesDelete.params),
    requirePersonalAccess,
    async function deleteAddressAlias (context: MethodContext, params: { alias: string }, result: ResultBag, next: Next) {
      try {
        const account = accountOf(context);
        const alias = params.alias.toLowerCase();
        if (!(await addressAliasesOfAccount(account.id)).includes(alias)) {
          return next(errors.unknownResource('address alias', params.alias));
        }
        await (await getUsersRepository()).releaseAlias(alias, account.id);
        const relatedDeletions: Array<{ id: string }> = [];
        // A grant and its sessions carry the alias: deleting the grant takes
        // them all. Bounded passes in case another holder appeared meanwhile
        // (one that adopted it just before the release).
        for (let pass = 0; pass < 5; pass++) {
          const rows = (await addressAliasHolders(account)).get(alias) ?? [];
          const holder = holderOf(rows);
          if (holder == null) break;
          const outcome = await deleteAccessChain(account, { id: parseAccessRef(holder.id).base });
          if (!outcome.deleted) break;
          relatedDeletions.push({ id: holder.id }, ...outcome.relatedDeletions);
        }
        result.addressAliasDeletion = { alias };
        result.relatedDeletions = relatedDeletions;
        next();
      } catch (err) {
        next(asApiError(err));
      }
    }
  );
}
