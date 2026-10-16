/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */

/**
 * External-id routes: the account's ids, and the core lookup on the register
 * surface. The lookup is a POST so the blinded value never enters a URL (and
 * so neither the request log nor the audit's query). Both are within a
 * per-address budget: each lookup counts, each claim refusal (409) counts.
 */

import path from 'node:path';
import type { AppLike, PryvRequest } from './_types.ts';
import type { Response, NextFunction, Application as ExpressApp } from 'express';
import { factory as errors } from 'errors';
import { loadAccess, setMinimalMethodContext, setMethodId } from 'middleware';
import { clientIp } from 'middleware/src/clientIp.ts';
import methodCallback from './methodCallback.ts';
import { Account, Register } from './Paths.ts';
import { extIdLookupBudget } from './reg/extIdLookupBudget.ts';

type CreatedContext = { externalIdCreated?: boolean };

function tooManyProbes (retryAfterSeconds: number) {
  return errors.tooManyAttempts(retryAfterSeconds, {
    message: `Too many external-id lookups or refused claims from this address; retry in ${retryAfterSeconds} s.`,
    data: { retryAfterSeconds }
  });
}

/** The account's ids (per-user routes: mounted with the other account routes). */
export default function (expressApp: ExpressApp, app: AppLike): void {
  const api = app.api;
  const loadAccessMiddleware = loadAccess(app.storageLayer);
  const base = Account + '/external-ids';

  // A claim refusal counts in the address budget; an address over budget is
  // refused before the claim runs.
  function claimHandler (methodParams: (req: PryvRequest) => Record<string, unknown>, successCode: (context: CreatedContext) => number) {
    return async function (req: PryvRequest, res: Response, next: NextFunction) {
      try {
        const ip = clientIp(req);
        const retryAfter = await extIdLookupBudget.check(ip);
        if (retryAfter != null) return next(tooManyProbes(retryAfter));
        const context = req.context as CreatedContext;
        const done = methodCallback(res, next, () => successCode(context));
        api.call(req.context, methodParams(req), (err: unknown, result: unknown) => {
          if ((err as { id?: string } | null)?.id === 'external-id-already-claimed') {
            extIdLookupBudget.reserve(ip).catch(() => {});
          }
          done(err, result as Parameters<typeof done>[1]);
        });
      } catch (err) { next(err); }
    };
  }

  expressApp.post(base, setMethodId('account.externalIds.claim'), loadAccessMiddleware,
    claimHandler((req) => req.body, (context) => context.externalIdCreated === true ? 201 : 200));
  expressApp.get(base, setMethodId('account.externalIds.list'), loadAccessMiddleware, function (req: PryvRequest, res: Response, next: NextFunction) {
    api.call(req.context, req.query, methodCallback(res, next, 200));
  });
  expressApp.put(base + '/:namespace', setMethodId('account.externalIds.replace'), loadAccessMiddleware,
    claimHandler((req) => Object.assign({}, req.body, { namespace: req.params.namespace }), () => 200));
  expressApp.delete(base + '/:namespace', setMethodId('account.externalIds.release'), loadAccessMiddleware, function (req: PryvRequest, res: Response, next: NextFunction) {
    api.call(req.context, { namespace: req.params.namespace }, methodCallback(res, next, 200));
  });
}

/** The core lookup (register surface: mounted with the other /reg routes). */
export function lookupRoute (expressApp: ExpressApp, app: AppLike): void {
  const api = app.api;
  expressApp.post(path.join(Register, '/ext-id/cores'), setMinimalMethodContext, setMethodId('auth.extIdCores'), async (req: PryvRequest, res: Response, next: NextFunction) => {
    try {
      const retryAfter = await extIdLookupBudget.reserve(clientIp(req));
      if (retryAfter != null) return next(tooManyProbes(retryAfter));
      api.call(req.context, req.body, methodCallback(res, next, 200));
    } catch (err) { next(err); }
  });
}
