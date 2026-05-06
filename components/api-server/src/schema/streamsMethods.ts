/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
/**
 * JSON Schema specification of methods data for event streams.
 */

const Action = require('./Action');
const stream = require('./stream').default;
const itemDeletion = require('./itemDeletion').default;
const helpers = require('./helpers');
const object = helpers.object;
const array = helpers.array;
const string = helpers.string;
const number = helpers.number;
const boolean = helpers.boolean;

const updatedEvent = helpers.object({
  id: helpers.string(),
  action: helpers.string()
}, {
  id: 'updatedEvent',
  required: ['id', 'action'],
  additionalProperties: false
});

const __ex_get = {
    params: object({
      parentId: string(),
      state: string({ enum: ['default', 'all'] }),
      includeDeletionsSince: number()
    }),
    result: object({
      streams: array({ $ref: '#/definitions/stream' }),
      eventDeletions: array(itemDeletion)
    }, {
      definitions: {
        // TODO: clean this schema $ref thing up
        stream: stream(Action.READ, false, '#/definitions/stream')
      },
      required: ['streams']
    })
  };
export { __ex_get as get };
const __ex_create = {
    params: stream(Action.CREATE),
    result: object({
      stream: stream(Action.READ, true)
    }, {
      required: ['stream'],
      additionalProperties: false
    })
  };
export { __ex_create as create };
const __ex_update = {
    params: object({
      // in path for HTTP requests
      id: string(),
      // = body of HTTP requests
      update: { $ref: '#/definitions/stream' }
    }, {
      definitions: {
        // TODO: clean this schema $ref thing up
        stream: stream(Action.UPDATE, false, '#/definitions/stream')
      },
      required: ['id', 'update']
    }),
    result: object({
      stream: stream(Action.READ, true)
    }, {
      required: ['stream'],
      additionalProperties: false
    })
  };
export { __ex_update as update };
const __ex_del = {
    params: object({
      // in path for HTTP requests
      id: string(),
      // in query string for HTTP requests
      mergeEventsWithParent: boolean()
    }, {
      required: ['id']
    }),
    result: {
      anyOf: [
        object({ stream: stream(Action.READ, true) }, {
          required: ['stream'],
          additionalProperties: false
        }),
        object({ streamDeletion: itemDeletion, updatedEvents: array(updatedEvent) }, {
          required: ['streamDeletion'],
          additionalProperties: false
        })
      ]
    }
  };
export { __ex_del as del };
