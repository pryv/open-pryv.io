/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);

const { tryCoerceStringValues } = require('api-server').validation;
const timestamp = require('unix-timestamp');
const errors = require('errors').factory;
const SeriesResponse = require('../SeriesResponse.ts').default;
const AUTH_HEADER = 'authorization';
/** GET /events/:event_id/series - Query a series for a data subset.
 *
 * @param {Context} ctx  :  Context
 * @param {express$Request} req  :  express$Request       description
 * @param {express$Response} res  :  express$Response      description
 * @param  {type} next: express$NextFunction  description
 * @return {unknown}
 */
async function querySeriesData (ctx: any, req: any, res: any) {
  const metadata = ctx.metadata;
  const seriesRepo = ctx.series;
  // Extract parameters from request:
  const username = req.params.user_name;
  const eventId = req.params.event_id;
  const accessToken = req.headers[AUTH_HEADER];
  // If required params are not there, abort.
  if (accessToken == null) { throw errors.missingHeader(AUTH_HEADER, 401); }
  if (eventId == null) { throw errors.invalidItemId(); }
  const seriesMeta = await verifyAccess(username, eventId, accessToken, metadata);
  const query = coerceStringParams(structuredClone(req.query));
  applyDefaultValues(query);
  validateQuery(query);
  await retrievePoints(seriesRepo, res, query, seriesMeta);
}
function coerceStringParams (params: any) {
  tryCoerceStringValues(params, {
    fromDeltaTime: 'number',
    toDeltaTime: 'number'
  });
  const query = {
    from: params.fromDeltaTime,
    to: params.toDeltaTime
  };
  return query;
}
function applyDefaultValues (query: any) {
  if (query.to == null) { query.to = timestamp.now(); }
}
function validateQuery (query: any) {
  if (query.from != null && isNaN(query.from)) { throw errors.invalidParametersFormat("'from' must contain seconds since epoch."); }
  if (isNaN(query.to)) { throw errors.invalidParametersFormat("'to' must contain seconds since epoch."); }
  if (query.from != null && query.to != null && query.to < query.from) { throw errors.invalidParametersFormat("'to' must be >= 'from'."); }
}
async function verifyAccess (username: any, eventId: any, authToken: any, metadata: any) {
  const seriesMeta = await metadata.forSeries(username, eventId, authToken);
  if (!seriesMeta.canRead()) { throw errors.forbidden(); }
  return seriesMeta;
}
async function retrievePoints (seriesRepo: any, res: any, query: any, seriesMeta: any) {
  const seriesInstance = await seriesRepo.get(...seriesMeta.namespaceAndName());
  const data = await seriesInstance.query(query);
  const responseObj = new SeriesResponse(data);
  responseObj.answer(res);
}
export default querySeriesData;
export { querySeriesData };
