/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */
import type {} from 'node:fs';

'use strict';
/**
 * JSON Schema specification of methods data for events.
 */
const Action = require('./Action');
const event = require('./event');
const itemDeletion = require('./itemDeletion');
const helpers = require('./helpers');
const object = helpers.object;
const array = helpers.array;
const string = helpers.string;
const number = helpers.number;
const boolean = helpers.boolean;
module.exports = {
  get: {
    params: object({
      streams: {},
      types: array(string({ pattern: '^(series:)?[a-z0-9-]+/(\\*|[a-z0-9-]+)$' }), { nullable: true }),
      fromTime: number(),
      toTime: number(),
      sortAscending: boolean(),
      skip: number(),
      limit: number(),
      state: string({ enum: ['default', 'trashed', 'all'] }),
      modifiedSince: number(),
      includeDeletions: boolean(),
      auth: string(),
      running: boolean()
    }, { id: 'events.get', additionalProperties: false }),
    result: object({
      events: array(event(Action.READ)),
      eventDeletions: array(itemDeletion)
    }, {
      required: ['events']
    })
  },
  getOne: {
    params: object({
      id: string(),
      includeHistory: boolean()
    }, { id: 'events.getOne' }),
    result: object({
      event: event(Action.READ),
      history: array(event(Action.READ))
    }, {
      required: ['event']
    })
  },
  create: {
    params: event(Action.CREATE),
    result: object({
      event: event(Action.READ)
    }, {
      required: ['event'],
      additionalProperties: false
    })
  },
  update: {
    params: object({
      // in path for HTTP requests
      id: string(),
      // = body of HTTP requests
      update: event(Action.UPDATE)
    }, {
      id: 'events.update',
      required: ['id', 'update']
    }),
    result: object({
      event: event(Action.READ)
    }, {
      required: ['event'],
      additionalProperties: false
    })
  },
  del: {
    params: object({
      // in path for HTTP requests
      id: string()
    }, {
      id: 'events.delete',
      required: ['id']
    }),
    result: {
      anyOf: [
        object({ event: event(Action.READ) }, {
          required: ['event'],
          additionalProperties: false
        }),
        object({ eventDeletion: itemDeletion }, {
          required: ['eventDeletion'],
          additionalProperties: false
        })
      ]
    }
  },
  deleteAttachment: {
    params: object({
      // in path for HTTP requests
      id: string(),
      // in path for HTTP requests
      fileId: string()
    }, {
      required: ['id', 'fileId']
    })
  }
};
