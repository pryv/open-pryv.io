/**
 * JSON Schema specification of methods data for event streams.
 */

var Action = require('./Action'),
    stream = require('./stream'),
    itemDeletion = require('./itemDeletion'),
    helpers = require('./helpers'),
    object = helpers.object,
    array = helpers.array,
    string = helpers.string,
    number = helpers.number,
    boolean = helpers.boolean;

module.exports = {
  get: {
    params: object({
      'parentId': string(),
      'state': string({enum: ['default', 'all']}),
      'includeDeletionsSince': number()
    }),
    result: object({
      'streams': array({$ref: '#/definitions/stream'}),
      'eventDeletions': array(itemDeletion)
    }, {
      definitions: {
        // TODO: clean this schema $ref thing up
        'stream': stream(Action.READ, false, '#/definitions/stream')
      },
      required: [ 'streams' ]
    })
  },

  create: {
    params: stream(Action.CREATE),
    result: object({
      'stream': stream(Action.READ, true)
    }, {
      required: [ 'stream' ],
      additionalProperties: false
    })
  },

  update: {
    params: object({
      // in path for HTTP requests
      'id': string(),
      // = body of HTTP requests
      'update': {$ref: '#/definitions/stream'}
    }, {
      definitions: {
        // TODO: clean this schema $ref thing up
        'stream': stream(Action.UPDATE, false, '#/definitions/stream')
      },
      required: [ 'id', 'update' ]
    }),
    result: object({
      'stream': stream(Action.READ, true)
    }, {
      required: [ 'stream' ],
      additionalProperties: false
    })
  },

  del: {
    params: object({
      // in path for HTTP requests
      'id': string(),
      // in query string for HTTP requests
      'mergeEventsWithParent': boolean()
    }, {
      required: [ 'id' ]
    }),
    result: {
      anyOf: [
        object({stream: stream(Action.READ, true)}, {
          required: ['stream'],
          additionalProperties: false
        }),
        object({streamDeletion: itemDeletion}, {
          required: ['streamDeletion'],
          additionalProperties: false
        })
      ]
    }
  }
};
