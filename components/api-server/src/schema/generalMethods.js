/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */
/**
 * JSON Schema specification of general methods data.
 */

const Action = require('./Action');
const access = require('./access');
const helpers = require('./helpers');
const object = helpers.object;
const string = helpers.string;
const array = helpers.array;

module.exports = {
  getAccessInfo: {
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
  },

  callBatch: {
    params: array(object({
      method: string(),
      params: {
        type: ['object', 'array']
      }
    }, {
      required: ['method', 'params']
    })),
    result: object({
      results: array(object({}))
    })
  }
};
