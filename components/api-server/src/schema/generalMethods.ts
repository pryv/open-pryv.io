/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
/**
 * JSON Schema specification of general methods data.
 */

const Action = require('./Action.ts');
const access = require('./access.ts').default;
const helpers = require('./helpers.ts');
const object = helpers.object;
const string = helpers.string;
const array = helpers.array;

const __ex_getAccessInfo = {
    params: object({}, { id: 'getAccessInfo' }),
    result: object({
      type: {
        type: 'string',
        enum: ['personal', 'app', 'shared']
      },
      name: string(),
      permissions: access.permissions(Action.READ)
    }, {
      required: ['type', 'name', 'permissions']
    })
  };
export { __ex_getAccessInfo as getAccessInfo };
/**
 * Most calls in one batch. Matches the chunk size of the JavaScript client
 * library (`Connection.api()` sends at most this many calls per batch), so no
 * client of the library is refused.
 */
const BATCH_MAX_CALLS = 1000;
export { BATCH_MAX_CALLS };
const __ex_callBatch = {
    params: array(object({
      method: string(),
      params: {
        type: ['object', 'array']
      }
    }, {
      required: ['method', 'params']
    }), { maxItems: BATCH_MAX_CALLS }),
    result: object({
      results: array(object({}))
    })
  };
export { __ex_callBatch as callBatch };
