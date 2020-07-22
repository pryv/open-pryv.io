/**
 * JSON Schema specification of methods data for accesses.
 */

const Action = require('./Action');
const access = require('./access');
const error = require('./methodError');
const helpers = require('./helpers');
const itemDeletion = require('./itemDeletion');
const object = helpers.object;
const string = helpers.string;
const boolean = helpers.boolean;

module.exports = {
  get: {
    params: object({}, {
      id: 'accesses.get',
      includeDeletions: boolean(),
      includeExpired: boolean(),
    }),
    result: object({
      'accesses': {
        type: 'array',
        items: access(Action.READ)
      },
      'accessDeletions': {
        type: 'array',
        items: access(Action.READ)
      },
    }, {
      required: [ 'accesses' ]
    })
  },

  create: {
    params: access(Action.CREATE),
    result: object({
      'access': access(Action.READ)
    }, {
      required: [ 'access' ]
    })
  },

  del: {
    params: object({
      // in path for HTTP requests
      'id': string()
    }, {
      id: 'accesses.delete',
      required: [ 'id' ]
    }),
    result: object({accessDeletion: itemDeletion}, {
      required: ['accessDeletion'],
      additionalProperties: false
    })
  },

  getInfo: {
    params: object({}, {
      id: 'accesses.getInfo'
    }),
    result: object({
      'type': string({enum: ['personal', 'app', 'shared']}),
      'name': string(),
      'permissions': access.permissions(Action.READ),
      'user': object({
        'username': string(),
      }),
    }, {
      required: [ 'type', 'name', 'permissions' ],
      additionalProperties: false
    })
  },

  checkApp: {
    params: object({
      'requestingAppId': string(),
      'deviceName': string(),
      'requestedPermissions': access.permissions(Action.CREATE),
      'clientData': object({}),
    }, {
      id: 'accesses.checkApp',
      required: [ 'requestingAppId', 'requestedPermissions' ],
      additionalProperties: false,
    }),
    result: object({
      'matchingAccess': access(Action.READ),
      'mismatchingAccess': access(Action.READ),
      'checkedPermissions': access.permissions(Action.CREATE),
      'error': error
    }, {
      additionalProperties: false
    })
  }
};
