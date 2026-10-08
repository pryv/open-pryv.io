/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
/**
 * JSON Schema specification for Webhooks.
 */

const Action = require('./Action.ts');
const helpers = require('./helpers.ts');
const object = helpers.object;
const string = helpers.string;
const number = helpers.number;
const array = helpers.array;

const { MAX_URL_LENGTH } = require('business/src/webhooks/destination.ts');

export default function (action: string) {
  if (action === Action.STORE) { action = Action.READ; } // read items === stored items

  if (action === Action.CREATE) {
    // Only the fields a client sets; everything else (id, accessId, state,
    // retry settings, run counters, tracking properties) is assigned by the
    // server, and sending it is refused.
    return object({
      url: string({ maxLength: MAX_URL_LENGTH }),
      scopes: object({}, { additionalProperties: true })
    }, {
      required: ['url'],
      additionalProperties: false
    });
  }

  const base = object({
    id: string(),
    accessId: string(),
    url: string(),
    state: string(),
    runCount: number(),
    failCount: number(),
    lastRun: run,
    runs: array(run),
    currentRetries: number(),
    maxRetries: number(),
    minIntervalMs: number(),
    // Optional named-scope map { key -> { kind, query } } restricting which
    // changes fire this webhook. Validated/normalized in the webhooks method.
    scopes: object({}, { additionalProperties: true })
  },
  {
    additionalProperties: false
  });
  helpers.addTrackingProperties(base);

  switch (action) {
    case Action.READ:
      base.required = [
        'id',
        'accessId',
        'url',
        'state',
        'runCount',
        'failCount',
        'lastRun',
        'runs',
        'currentRetries',
        'maxRetries',
        'minIntervalMs',
        'created',
        'createdBy',
        'modified',
        'modifiedBy'
      ];
      break;
    case Action.UPDATE:
      base.alterableProperties = ['state', 'scopes'];
      base.properties.state = string({ enum: ['active', 'inactive'] });
      break;
  }

  return base;
};

const run = object({
  status: number(),
  timestamp: number()
},
{
  required: [
    'status',
    'timestamp'
  ]
}
);
