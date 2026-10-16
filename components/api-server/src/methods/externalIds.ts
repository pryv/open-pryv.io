/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */

/**
 * External ids of the account (personal token only), and the lookup of the
 * core holding an id. The blinded value is never returned and never echoed in
 * an error.
 */

import type { MethodNext as Next, ResultBag } from './_types.ts';
import type { MethodContext as BaseMethodContext } from 'business/src/MethodContext.ts';
import { factory as errors, APIError } from 'errors';
import { basicAccessAuthorizationCheck, getParamsValidation, requirePersonalAccess } from './helpers/commonFunctions.ts';
import * as methodsSchema from '../schema/accountMethods.ts';
import { getExternalIdsService } from 'business/src/external-ids/service.ts';

type MethodContext = BaseMethodContext & { externalIdCreated?: boolean };
type Api = { register: (...args: unknown[]) => void };

function asApiError (err: unknown) {
  return err instanceof APIError ? err : errors.unexpectedError(err);
}

/** The account the personal token belongs to (set by the access load). */
function userIdOf (context: MethodContext): string {
  const id = context.user?.id;
  if (id == null) throw errors.unexpectedError('external ids: method called without a loaded user');
  return id;
}

export default async function (api: Api) {
  api.register('account.externalIds.claim',
    basicAccessAuthorizationCheck,
    getParamsValidation(methodsSchema.externalIdsClaim.params),
    requirePersonalAccess,
    async function claimExternalId (context: MethodContext, params: { namespace: string, blindedValue: string }, result: ResultBag, next: Next) {
      try {
        const { externalId, created } = await (await getExternalIdsService()).claim(userIdOf(context), params.namespace, params.blindedValue);
        context.externalIdCreated = created;
        result.externalId = externalId;
        next();
      } catch (err) {
        next(asApiError(err));
      }
    }
  );

  api.register('account.externalIds.list',
    basicAccessAuthorizationCheck,
    getParamsValidation(methodsSchema.externalIdsList.params),
    requirePersonalAccess,
    async function listExternalIds (context: MethodContext, _params: unknown, result: ResultBag, next: Next) {
      try {
        result.externalIds = await (await getExternalIdsService()).list(userIdOf(context));
        next();
      } catch (err) {
        next(asApiError(err));
      }
    }
  );

  api.register('account.externalIds.release',
    basicAccessAuthorizationCheck,
    getParamsValidation(methodsSchema.externalIdsRelease.params),
    requirePersonalAccess,
    async function releaseExternalId (context: MethodContext, params: { namespace: string }, result: ResultBag, next: Next) {
      try {
        await (await getExternalIdsService()).release(userIdOf(context), params.namespace);
        result.released = true;
        next();
      } catch (err) {
        next(asApiError(err));
      }
    }
  );

  api.register('account.externalIds.replace',
    basicAccessAuthorizationCheck,
    getParamsValidation(methodsSchema.externalIdsClaim.params),
    requirePersonalAccess,
    async function replaceExternalId (context: MethodContext, params: { namespace: string, blindedValue: string }, result: ResultBag, next: Next) {
      try {
        const { externalId, created } = await (await getExternalIdsService()).replace(userIdOf(context), params.namespace, params.blindedValue);
        context.externalIdCreated = created;
        result.externalId = externalId;
        next();
      } catch (err) {
        next(asApiError(err));
      }
    }
  );

  // Unauthenticated: answers which core holds the id, never the account.
  // Unknown namespace and unclaimed id answer the same 404.
  api.register('auth.extIdCores',
    getParamsValidation(methodsSchema.externalIdCores.params),
    async function lookupExternalIdCore (_context: MethodContext, params: { namespace: string, blindedValue: string }, result: ResultBag, next: Next) {
      try {
        const server = await (await getExternalIdsService()).lookupCoreUrl(params.namespace, params.blindedValue);
        if (server == null) return next(errors.unknownResource('external id'));
        result.server = server;
        next();
      } catch (err) {
        next(asApiError(err));
      }
    }
  );
}
