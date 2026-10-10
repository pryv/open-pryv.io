/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */
import { createRequire } from 'node:module';
import type { MethodContext } from 'business/src/MethodContext.ts';
import type { MethodNext } from './_types.ts';
const require = createRequire(import.meta.url);
const commonFns = require('./helpers/commonFunctions.ts');
const errorHandling = require('errors').errorHandling;
const errors = require('errors').factory;
const ErrorIds = require('errors').ErrorIds;
const methodsSchema = require('../schema/generalMethods.ts');
const { fromCallback } = require('utils');
const { getLogger, ready } = require('@pryv/boiler');
const { getPasswordRules } = require('business/src/users/index.ts');
const updateAccessUsageStats = require('./helpers/updateAccessUsageStats.ts').default;

type AuditModule = {
  validApiCall: (ctx: unknown, result: unknown) => Promise<void>;
  errorApiCall: (ctx: unknown, err: unknown) => Promise<void>;
};
type ResultBag = Record<string, unknown> & { user?: Record<string, unknown>; results?: unknown[] };

const { RESULT_TO_OBJECT_MAX_ARRAY_SIZE } = require('../API.ts');

/** Default of `limits.batch.maxTotalItems`: the per-call drain ceiling, applied
 * to the sum of a batch's results. */
const DEFAULT_BATCH_MAX_TOTAL_ITEMS: number = RESULT_TO_OBJECT_MAX_ARRAY_SIZE;

/** Items a drained call result holds: the length of each list it carries. */
function countItems (obj: unknown): number {
  if (obj == null || typeof obj !== 'object') return 0;
  let n = 0;
  for (const value of Object.values(obj as Record<string, unknown>)) {
    if (Array.isArray(value)) n += value.length;
  }
  return n;
}

/**
 * Utility API methods implementations.
 *
 */
export default async function (api: { register: (...args: unknown[]) => void; call: (ctx: unknown, params: unknown, cb: (err: unknown, res: unknown) => void) => void }) {
  const logger = getLogger('methods:batch');
  const config = await ready();
  const isAuditActive = config.get('audit:active');
  const updateAccessUsage = await updateAccessUsageStats();
  const passwordRules = await getPasswordRules();
  let audit: AuditModule | undefined;
  if (isAuditActive) {
    audit = require('audit').default;
  }
  api.register('getAccessInfo', commonFns.getParamsValidation(methodsSchema.getAccessInfo.params), getAccessInfoApiFn);
  async function getAccessInfoApiFn (context: MethodContext, _params: unknown, result: ResultBag, next: MethodNext) {
    const accessInfoProps = [
      'id',
      'token',
      'type',
      'name',
      'deviceName',
      'permissions',
      'lastUsed',
      'expires',
      'deleted',
      'clientData',
      'created',
      'createdBy',
      'modified',
      'modifiedBy',
      'calls',
      'alias'
    ];
    for (const prop of accessInfoProps) {
      const accessProp = context.access[prop];
      if (accessProp != null) { result[prop] = accessProp; }
    }
    result.user = {};
    // Report the access alias instead of the real username when this access
    // carries one (de-identification); otherwise the canonical primary
    // username (which `context.user.username` always holds, even after a
    // username change). The real username never leaks for an aliased access.
    const reportedUsername = (context.access.alias as string | undefined) ?? context.user.username;
    if (reportedUsername != null) { (result.user as Record<string, unknown>).username = reportedUsername; }
    if (context.access.isPersonal()) {
      const expirationAndChangeTimes = await passwordRules.getPasswordExpirationAndChangeTimes(context.user.id);
      Object.assign(result.user, expirationAndChangeTimes);
    }
    // Delegation surfacing — an additive, first-class field derived from the
    // forge-protected `clientData.delegation` marker so clients need not parse
    // clientData. For a delegate PAT the token acts AS the controlled account,
    // so `result.user.username` stays the controlled account; for a control
    // access the shape names the relationship it operates. Additive only.
    const delMarker = (context.access as { clientData?: { delegation?: { kind?: string; delegate?: { username?: string; hostSlug?: string } } } }).clientData?.delegation;
    if (delMarker != null) {
      if (delMarker.kind === 'delegate-pat') {
        result.delegation = {
          isDelegatedAccess: true,
          controlledUsername: context.user.username,
          delegate: delMarker.delegate,
        };
      } else if (delMarker.kind === 'delegated-child') {
        // An app/shared access granted on the controlled account by a
        // delegate: the holder acts on the controlled account, and the
        // grant came through the delegation, not the account owner.
        result.delegation = {
          isDelegatedAccess: true,
          controlledUsername: context.user.username,
          delegate: delMarker.delegate,
          grantedVia: 'app',
        };
      } else if (delMarker.kind === 'control') {
        result.delegation = {
          kind: 'control',
          controlledUsername: context.user.username,
          delegate: delMarker.delegate,
        };
      }
    }
    next();
  }
  api.register('callBatch', refuseNestedBatch, commonFns.getParamsValidation(methodsSchema.callBatch.params), callBatchApiFn, updateAccessUsage);

  // A batch inside a batch would multiply the call count past the schema's
  // bound and nest result envelopes; no client needs it.
  function refuseNestedBatch (context: MethodContext, _params: unknown, _result: ResultBag, next: MethodNext) {
    if (context.genericDispatch === 'batch') {
      return next(errors.invalidOperation('callBatch cannot be called inside a batch call.'));
    }
    next();
  }

  /** Most result items all the calls of one batch may return together. */
  function maxTotalItems (): number {
    const value = config.get('limits:batch:maxTotalItems');
    return (typeof value === 'number' && Number.isInteger(value) && value > 0) ? value : DEFAULT_BATCH_MAX_TOTAL_ITEMS;
  }

  async function callBatchApiFn (context: MethodContext & { accessUsageStats?: Record<string, number>; methodId?: string; acceptStreamsQueryNonStringified?: boolean; disableAccessUsageStats?: boolean }, calls: ApiCall[], result: ResultBag, next: MethodNext) {
    // allow non stringified stream queries in batch calls
    context.acceptStreamsQueryNonStringified = true;
    context.disableAccessUsageStats = true;
    // to avoid updatingAccess for each api call we are collecting all counter here
    context.accessUsageStats = {};
    function countCall (methodId: string) {
      if (context.accessUsageStats![methodId] == null) { context.accessUsageStats![methodId] = 0; }
      context.accessUsageStats![methodId]++;
    }
    // Every result of the batch is held until the envelope is written, so the
    // per-call ceiling alone does not bound it: the calls share one budget.
    // Each call may drain at most what is left of it; past it the whole batch
    // fails rather than answering a truncated envelope.
    const totalBudget = maxTotalItems();
    let itemsUsed = 0;
    let overBudget = false;
    // The inner calls run as generically dispatched calls (methods that take
    // credentials refuse them); the dispatcher this batch came through, if
    // any, is restored afterwards.
    const outerDispatch = context.genericDispatch;
    context.genericDispatch = 'batch';
    result.results = [];
    try {
      for (const call of calls) {
        result.results.push(await executeCall(call));
        if (overBudget) break;
      }
    } finally {
      context.genericDispatch = outerDispatch;
      context.resultArrayLimit = undefined;
    }
    // The OUTER callBatch result is written to HTTP, so its onEnd (API.ts) fires
    // `validApiCall` once more for the batch envelope. After the loop `context`
    // still holds the LAST inner call's methodId + breach-scope enrichment (reset
    // happens BEFORE each call, not after the loop) — without this the envelope
    // row would duplicate that call's action AND its recordCount/scope, so a
    // batched read's records get counted twice in the breach report. Restore the
    // envelope's own identity and clear the per-read enrichment.
    context.methodId = 'callBatch';
    context.auditRecordCount = undefined;
    context.auditRecordCountIncomplete = undefined;
    context.auditScopedStreamIds = undefined;
    context.auditScopedStreamCount = undefined;
    context.disableAccessUsageStats = false; // to allow tracking functions
    if (overBudget) {
      result.results = undefined;
      return next(errors.tooManyResults(totalBudget));
    }
    next();
    async function executeCall (call: ApiCall) {
      const remaining = Math.max(totalBudget - itemsUsed, 1);
      try {
        countCall(call.method);
        // update methodId to match the call todo
        context.methodId = call.method;
        // The context is REUSED across batched calls — clear the breach-scope
        // audit enrichment so a read's counts never leak onto the next call's
        // audit row (only a read re-sets them).
        context.auditRecordCount = undefined;
        context.auditRecordCountIncomplete = undefined;
        context.auditScopedStreamIds = undefined;
        context.auditScopedStreamCount = undefined;
        context.resultArrayLimit = remaining;
        // Perform API call
        const result = await fromCallback((cb: (err: unknown, res: unknown) => void) => api.call(context, call.params, cb)) as { toObject: (cb: (err: unknown, res: unknown) => void) => void };
        // Drain the result FIRST so streamed reads finish counting, THEN audit —
        // otherwise a batched events.get audits a false recordCount: 0.
        const obj = await fromCallback((cb: (err: unknown, res: unknown) => void) => result.toObject(cb));
        itemsUsed += countItems(obj);
        if (itemsUsed > totalBudget) overBudget = true;
        if (isAuditActive && audit) { await audit.validApiCall(context, result); }
        return obj;
      } catch (err) {
        // A drain refused by the shared budget (not by the API-wide per-call
        // ceiling) is the batch going over its total.
        if ((err as { id?: string } | null)?.id === ErrorIds.TooManyResults && remaining < RESULT_TO_OBJECT_MAX_ARRAY_SIZE) {
          overBudget = true;
        }
        // Batchcalls have specific error handling hence the custom request context
        const reqContext = {
          method: call.method + ' (within batch)',
          url: 'pryv://' + context.user.username
        };
        errorHandling.logError(err, reqContext, logger);
        if (isAuditActive && audit) { await audit.errorApiCall(context, err); }
        return { error: errorHandling.getPublicErrorData(err) };
      }
    }
  }
};

type ApiCall = {
  method: string;
  params: unknown;
};
