/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */
import * as helpers from './helpers.ts';

/**
 * JSON Schema specification of the audit methods. The schema bounds the
 * types; the time zone and the number of buckets are checked by the method.
 */

const count = helpers.getBaseSchema('integer', { minimum: 0 });
// Unix seconds up to year 5138: far beyond any audit row, and well inside the
// range a JS Date (and so the time-zone arithmetic) can represent.
const SUMMARY_MAX_TIME = 1e11;
const summaryTime = () => helpers.number({ minimum: 0, maximum: SUMMARY_MAX_TIME });

const getSummary = {
  params: helpers.object({
    fromTime: summaryTime(),
    toTime: summaryTime(),
    bucket: helpers.string({ enum: ['hour', 'day', 'week'] }),
    timezone: helpers.string({ minLength: 1, maxLength: 64 }),
    // Matched as the audit stream `access-<id>`: the character set keeps the
    // value a plain stream id term on both audit engines.
    accessIds: helpers.array(
      helpers.string({ minLength: 1, maxLength: 100, pattern: '^[A-Za-z0-9_:-]+$' }),
      { minItems: 1, maxItems: 50 }
    ),
    // access token in the query string (HTTP GET)
    auth: helpers.string()
  }, {
    required: ['fromTime', 'bucket'],
    additionalProperties: false
  }),
  result: helpers.object({
    summary: helpers.object({
      bucket: helpers.string({ enum: ['hour', 'day', 'week'] }),
      timezone: helpers.string(),
      fromTime: helpers.number(),
      toTime: helpers.number(),
      buckets: helpers.array(helpers.object({
        time: helpers.number(),
        total: count,
        reads: count,
        writes: count,
        session: count,
        other: count,
        errors: count
      }, {
        required: ['time', 'total', 'reads', 'writes', 'session', 'other', 'errors'],
        additionalProperties: false
      }))
    }, {
      required: ['bucket', 'timezone', 'fromTime', 'toTime', 'buckets'],
      additionalProperties: false
    })
  }, {
    required: ['summary'],
    additionalProperties: false
  })
};
export { getSummary };
