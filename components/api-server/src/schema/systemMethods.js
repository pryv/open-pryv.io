/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */
/**
 * JSON Schema specification of methods data for system.
 */

const Action = require('./Action');
const helpers = require('./helpers');
const user = require('./user');

module.exports = {
  createUser: {
    params: user(Action.CREATE),
    result: {
      type: 'object',
      additionalProperties: false,
      properties: {
        id: {
          type: 'string'
        }
      }
    }
  },
  getUserInfo: {
    params: helpers.object({
      username: helpers.string()
    }, {
      required: ['username']
    }),
    result: helpers.object({
      userInfo: helpers.object({
        username: helpers.string(),
        lastAccess: helpers.number(),
        callsTotal: helpers.number(),
        callsDetail: helpers.object({}),
        callsPerAccess: helpers.object({}),
        storageUsed: user(Action.READ).properties.storageUsed
      }, {
        additionalProperties: false,
        required: ['username', 'lastAccess', 'callsTotal', 'callsDetail', 'storageUsed']
      })
    }, {
      required: ['userInfo']
    })
  },
  deactivateMfa: {
    params: helpers.object({
      username: helpers.username
    }, { required: ['username'] })
  }
};
