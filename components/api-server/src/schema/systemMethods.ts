/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
/**
 * JSON Schema specification of methods data for system.
 */

const Action = require('./Action.ts');
const helpers = require('./helpers.ts');
const user = require('./user.ts').default;

const __ex_createUser = {
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
  };
export { __ex_createUser as createUser };
const __ex_getUserInfo = {
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
  };
export { __ex_getUserInfo as getUserInfo };
const __ex_deactivateMfa = {
    params: helpers.object({
      username: helpers.username
    }, { required: ['username'] })
  };
export { __ex_deactivateMfa as deactivateMfa };
