/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);

import type { MethodContext } from 'business/src/MethodContext.ts';
import type { MethodNext } from 'api-server/src/methods/_types.ts';

const errors = require('errors').factory;
const commonFns = require('api-server/src/methods/helpers/commonFunctions.ts');
const methodsSchema = require('../schema/auditMethods.ts');
const eventsGetUtils = require('api-server/src/methods/helpers/eventsGetUtils.ts');
const { getStoreQueryFromParams, getStoreOptionsFromParams } = require('mall/src/helpers/eventsQueryUtils.ts');
const { localStorePrepareOptions, localStorePrepareQuery } = require('storage/src/localStoreEventQueries.ts');

const audit = require('audit').default;
const auditStorage = audit.storage;
const { ConvertEventFromStoreStream } = require('mall/src/helpers/eventsUtils.ts');

type StreamQueryItem = {
  all?: string[];
  any?: string[];
  not?: string[];
  and?: StreamQueryItem[];
};

type GetLogsParams = {
  arrayOfStreamQueries?: StreamQueryItem[] | null;
  streams?: StreamQueryItem[] | null;
  [k: string]: unknown;
};

type Result = { addStream: (name: string, stream: NodeJS.ReadableStream) => void };

type Api = { register: (name: string, ...mws: unknown[]) => void };

export default function (api: Api): void {
  api.register('audit.getLogs',
    eventsGetUtils.coerceStreamsParam,
    commonFns.getParamsValidation(methodsSchema.get.params),
    eventsGetUtils.applyDefaultsForRetrieval,
    eventsGetUtils.transformArrayOfStringsToStreamsQuery,
    anyStarStreamQueryIsNullQUery,
    removeStoreIdFromStreamQuery,
    limitStreamQueryToAccessToken,
    getAuditLogs);
};
function anyStarStreamQueryIsNullQUery (context: MethodContext, params: GetLogsParams, result: Result, next: MethodNext): void {
  if (isStar()) {
    params.arrayOfStreamQueries = null;
  }
  next();
  /**
   * arrayOfStreamQueries === [{ any: ['*']}]
   */
  function isStar (): boolean {
    const q = params.arrayOfStreamQueries;
    return (q != null &&
            q.length === 1 &&
            q[0]?.any?.length === 1 &&
            q[0]?.any[0] === '*');
  }
}
/**
 * Remove ':audit:' from stream query;
 */
function removeStoreIdFromStreamQuery (context: MethodContext, params: GetLogsParams, result: Result, next: MethodNext): void {
  if (params.arrayOfStreamQueries == null) { return next(); }
  for (const query of params.arrayOfStreamQueries) {
    for (const item of ['all', 'any', 'not'] as const) {
      if (query[item] != null) {
        const streamIds = query[item] as string[];
        for (let i = 0; i < streamIds.length; i++) {
          const streamId = streamIds[i];
          if (!streamId.startsWith(audit.CONSTANTS.STORE_PREFIX)) {
            return next(errors.invalidRequestStructure('Invalid "streams" parameter. It should be an array of streamIds starting with Audit store prefix: "' +
                            audit.CONSTANTS.STORE_PREFIX +
                            '"', params.arrayOfStreamQueries));
          }
          streamIds[i] = streamId.substring(audit.CONSTANTS.STORE_PREFIX.length);
        }
      }
    }
  }
  next();
}
function limitStreamQueryToAccessToken (context: MethodContext, params: GetLogsParams, result: Result, next: MethodNext): void {
  if (context.access!.isPersonal()) { return next(); }
  if (params.arrayOfStreamQueries == null) {
    params.arrayOfStreamQueries = [{}];
  }
  // stream corresponding to acces.id exemple: "access-{acces.id}"
  const streamId = audit.CONSTANTS.ACCESS_STREAM_ID_PREFIX + context.access!.id;
  for (const query of params.arrayOfStreamQueries) {
    if (query.any == null) {
      query.any = [streamId];
    } else {
      if (query.and == null) {
        query.and = [];
      }
      query.and.push({ any: [streamId] });
    }
  }
  next();
}
// From storage
async function getAuditLogs (context: MethodContext, params: GetLogsParams, result: Result, next: MethodNext): Promise<void> {
  try {
    const userDB = await auditStorage.forUser(context.user!.id);
    params.streams = params.arrayOfStreamQueries;
    const storeQuery = getStoreQueryFromParams(params);
    const storeOptions = getStoreOptionsFromParams(params);
    const query = localStorePrepareQuery(storeQuery);
    const options = localStorePrepareOptions(storeOptions);
    result.addStream('auditLogs', userDB
      .getEventsStreamed({ query, options })
      .pipe(new ConvertEventFromStoreStream('_audit')));
  } catch (err) {
    return next(err);
  }
  next();
}
