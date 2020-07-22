'use strict';
// @flow

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
      'streams': array(string()),
      'tags': array(string()),
      'types': array(string()),
      'fromTime': number(),
      'toTime': number(),
      'sortAscending': boolean(),
      'skip': number(),
      'limit': number(),
      'state': string({ enum: ['default', 'trashed', 'all']}),
      'modifiedSince': number(),
      'includeDeletions': boolean()
    }, { id: 'events.get' }),
    result: object({
      'events': array(event(Action.READ)),
      'eventDeletions': array(itemDeletion)
    }, {
      required: [ 'events' ]
    })
  },

  getOne: {
    params: object({
      'id': string(),
      'includeHistory': boolean()
    }, {id: 'events.getOne'}),
    result: object({
      'event': event(Action.READ),
      'history': array(event(Action.READ))
    }, {
      required: [ 'event' ]
    })
  },

  create: {
    params: event(Action.CREATE),
    result: object({
      'event': event(Action.READ),
    }, {
      required: [ 'event' ],
      additionalProperties: false
    })
  },

  update: {
    params: object({
      // in path for HTTP requests
      'id': string(),
      // = body of HTTP requests
      'update': event(Action.UPDATE)
    }, {
      id: 'events.update',
      required: [ 'id', 'update' ]
    }),
    result: object({
      'event': event(Action.READ),
    }, {
      required: [ 'event' ],
      additionalProperties: false
    })
  },

  del: {
    params: object({
      // in path for HTTP requests
      'id': string()
    }, {
      id: 'events.delete',
      required: [ 'id' ]
    }),
    result: {
      anyOf: [
        object({event: event(Action.READ)}, {
          required: ['event'],
          additionalProperties: false
        }),
        object({eventDeletion: itemDeletion}, {
          required: ['eventDeletion'],
          additionalProperties: false
        })
      ]
    }
  },

  deleteAttachment: {
    params: object({
      // in path for HTTP requests
      'id': string(),
      // in path for HTTP requests
      'fileId': string()
    }, {
      required: [ 'id', 'fileId' ]
    })
  }
};
