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
      'calls'
    ];
    const userProps = ['username'];
    for (const prop of accessInfoProps) {
      const accessProp = context.access[prop];
      if (accessProp != null) { result[prop] = accessProp; }
    }
    result.user = {};
    for (const prop of userProps) {
      const userProp = (context.user as unknown as Record<string, unknown>)[prop];
      if (userProp != null) { (result.user as Record<string, unknown>)[prop] = userProp; }
    }
    if (context.access.isPersonal()) {
      const expirationAndChangeTimes = await passwordRules.getPasswordExpirationAndChangeTimes(context.user.id);
      Object.assign(result.user, expirationAndChangeTimes);
    }
    next();
  }
  api.register('callBatch', commonFns.getParamsValidation(methodsSchema.callBatch.params), callBatchApiFn, updateAccessUsage);
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
    result.results = [];
    for (const call of calls) {
      result.results.push(await executeCall(call));
    }
    context.disableAccessUsageStats = false; // to allow tracking functions
    next();
    async function executeCall (call: ApiCall) {
      try {
        countCall(call.method);
        // update methodId to match the call todo
        context.methodId = call.method;
        // Perform API call
        const result = await fromCallback((cb: (err: unknown, res: unknown) => void) => api.call(context, call.params, cb)) as { toObject: (cb: (err: unknown, res: unknown) => void) => void };
        if (isAuditActive && audit) { await audit.validApiCall(context, result); }
        return await fromCallback((cb: (err: unknown, res: unknown) => void) => result.toObject(cb));
      } catch (err) {
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
