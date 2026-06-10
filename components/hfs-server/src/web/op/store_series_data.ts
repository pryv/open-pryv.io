/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */
import { createRequire } from 'node:module';
import type { Request, Response } from 'express';
const require = createRequire(import.meta.url);

type SeriesMetaLike = {
  isTrashedOrDeleted: () => boolean;
  canWrite: () => boolean;
  namespaceAndName: () => [string, string];
  produceRowType: (typeRepo: unknown) => unknown;
};
type CtxLike = {
  series: { get: (namespace: string, name: string) => Promise<{ append: (data: unknown) => Promise<unknown> }> };
  metadata: { forSeries: (userName: string, eventId: string, accessToken: unknown) => Promise<SeriesMetaLike> };
  typeRepository: unknown;
  metadataUpdater: { scheduleUpdate: (req: unknown) => Promise<unknown> };
};

//  POST /events/:event_id/series - Store data in a series.
const errors = require('errors').factory;
const business = require('business');
const ApiConstants = require('../api_constants.ts');
const TracedOperations = require('./traced_operations.ts').default;
const setCommonMeta = require('api-server/src/methods/helpers/setCommonMeta.ts').setCommonMeta;
/** POST /events/:event_id/series - Store data in a series.
 */
async function storeSeriesData (ctx: CtxLike, req: Request, res: Response) {
  const trace = new TracedOperations(ctx);
  const series = ctx.series;
  const metadata = ctx.metadata;
  // Extract parameters from request:
  const userName = req.params.user_name as string;
  const eventId = req.params.event_id as string;
  const accessToken = req.headers[ApiConstants.AUTH_HEADER];
  // If params are not there, abort.
  if (accessToken == null) { throw errors.missingHeader(ApiConstants.AUTH_HEADER); }
  if (eventId == null) { throw errors.invalidItemId(); }
  // Access check: Can user write to this series?
  trace.start('seriesMeta/load');
  const seriesMeta = await metadata.forSeries(userName, eventId, accessToken);
  trace.finish('seriesMeta/load');
  // Trashed or Deleted: Abort.
  if (seriesMeta.isTrashedOrDeleted()) {
    throw errors.invalidOperation(`The referenced event "${eventId}" is trashed.`, { trashedReference: 'eventId' });
  }
  // No access permission: Abort.
  if (!seriesMeta.canWrite()) { throw errors.forbidden(); }
  // Parse request
  trace.start('parseData');
  const data = parseData(req.body, seriesMeta, ctx.typeRepository);
  if (data == null) {
    throw errors.invalidRequestStructure('Malformed request.');
  }
  trace.finish('parseData');
  // assert: data != null
  // Store data
  trace.start('append');
  const seriesInstance = await series.get(...seriesMeta.namespaceAndName());
  await seriesInstance.append(data);
  trace.finish('append');
  trace.start('metadataUpdate');
  const now = Number(new Date()) / 1e3;
  await ctx.metadataUpdater.scheduleUpdate({
    entries: [
      {
        userId: userName,
        eventId,
        author: accessToken,
        timestamp: now,
        dataExtent: data.minmax()
      }
    ]
  });
  trace.finish('metadataUpdate');
  res.status(200).json(setCommonMeta({ status: 'ok' }));
}
// Parses request data into a data matrix that can be used as input to the
// influx store. You should give this method the `req.body`.
//
function parseData (createRequest: unknown, meta: SeriesMetaLike, typeRepo: unknown): DataMatrix | null {
  try {
    const type = meta.produceRowType(typeRepo);
    return business.series.DataMatrix.parse(createRequest, type);
  } catch (err) {
    if (err instanceof business.series.ParseFailure) {
      throw errors.invalidRequestStructure((err as Error).message);
    }
    throw err;
  }
}
export default storeSeriesData;
export { storeSeriesData };

type DataMatrix = { minmax: () => unknown }; // shape of business.series.DataMatrix used here