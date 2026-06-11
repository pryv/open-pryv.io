/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */
import { createRequire } from 'node:module';
import type { Request, Response } from 'express';
const require = createRequire(import.meta.url);

const { tryCoerceStringValues } = require('api-server').validation;
const timestamp = require('unix-timestamp');
const errors = require('errors').factory;
const SeriesResponse = require('../SeriesResponse.ts').default;
const AUTH_HEADER = 'authorization';

interface SeriesQuery { from?: number; to: number }
interface MetadataLike {
  forSeries: (username: string, eventId: string, authToken: string) => Promise<SeriesMetaLike>;
}
interface SeriesMetaLike {
  canRead: () => boolean;
  namespaceAndName: () => [string, string];
}
interface SeriesRepoLike {
  get: (...args: [string, string]) => Promise<{ query: (q: SeriesQuery) => Promise<unknown> }>;
}
interface HfsContextLike {
  metadata: MetadataLike;
  series: SeriesRepoLike;
}

/** GET /events/:event_id/series - Query a series for a data subset.
 */
async function querySeriesData (ctx: HfsContextLike, req: Request, res: Response) {
  const metadata = ctx.metadata;
  const seriesRepo = ctx.series;
  // Extract parameters from request:
  const username = req.params.user_name;
  const eventId = req.params.event_id;
  const accessToken = req.headers[AUTH_HEADER];
  // If required params are not there, abort.
  if (accessToken == null) { throw errors.missingHeader(AUTH_HEADER, 401); }
  if (eventId == null) { throw errors.invalidItemId(); }
  const seriesMeta = await verifyAccess(String(username), String(eventId), String(accessToken), metadata);
  const query = coerceStringParams(structuredClone(req.query));
  applyDefaultValues(query);
  validateQuery(query);
  await retrievePoints(seriesRepo, res, query, seriesMeta);
}
function coerceStringParams (params: Record<string, unknown>): SeriesQuery {
  tryCoerceStringValues(params, {
    fromDeltaTime: 'number',
    toDeltaTime: 'number'
  });
  const query: SeriesQuery = {
    from: params.fromDeltaTime as number | undefined,
    to: params.toDeltaTime as number
  };
  return query;
}
function applyDefaultValues (query: SeriesQuery): void {
  if (query.to == null) { query.to = timestamp.now(); }
}
function validateQuery (query: SeriesQuery): void {
  if (query.from != null && isNaN(query.from)) { throw errors.invalidParametersFormat("'from' must contain seconds since epoch."); }
  if (isNaN(query.to)) { throw errors.invalidParametersFormat("'to' must contain seconds since epoch."); }
  if (query.from != null && query.to != null && query.to < query.from) { throw errors.invalidParametersFormat("'to' must be >= 'from'."); }
}
async function verifyAccess (username: string, eventId: string, authToken: string, metadata: MetadataLike): Promise<SeriesMetaLike> {
  const seriesMeta = await metadata.forSeries(username, eventId, authToken);
  if (!seriesMeta.canRead()) { throw errors.forbidden(); }
  return seriesMeta;
}
async function retrievePoints (seriesRepo: SeriesRepoLike, res: Response, query: SeriesQuery, seriesMeta: SeriesMetaLike): Promise<void> {
  const seriesInstance = await seriesRepo.get(...seriesMeta.namespaceAndName());
  const data = await seriesInstance.query(query);
  const responseObj = new SeriesResponse(data);
  responseObj.answer(res);
}
export default querySeriesData;
export { querySeriesData };
