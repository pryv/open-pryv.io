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
const __ex_getAccess = {
    params: helpers.object({
      accessId: helpers.string()
    }, {
      required: ['accessId']
    })
  };
export { __ex_getAccess as getAccess };

// External-id namespaces (admin). The name rule is enforced again by the
// platform layer, which owns the rows.
const extIdNamespace = helpers.string({ pattern: '^[a-z0-9][a-z0-9-]{1,62}$' });
const __ex_extIdNamespacesGet = {
    params: helpers.object({ namespace: extIdNamespace }, { required: ['namespace'] })
  };
export { __ex_extIdNamespacesGet as extIdNamespacesGet };
const __ex_extIdNamespacesSet = {
    params: helpers.object({
      namespace: extIdNamespace,
      label: helpers.string({ minLength: 1, maxLength: 80 }),
      defaultMode: helpers.string({ enum: ['hint', 'forced'] })
    }, { required: ['namespace'] })
  };
export { __ex_extIdNamespacesSet as extIdNamespacesSet };
const __ex_extIdNamespacesDelete = {
    params: helpers.object({
      namespace: extIdNamespace,
      force: helpers.boolean()
    }, { required: ['namespace'] })
  };
export { __ex_extIdNamespacesDelete as extIdNamespacesDelete };
// The value's format is checked by the service, which never echoes it. The
// username is a lookup key resolved by the caller through the platform: a
// legacy name outside today's username rule must still be answered.
const __ex_extIdHolds = {
    params: helpers.object({
      username: helpers.string({ minLength: 1, maxLength: 100 }),
      namespace: extIdNamespace,
      blindedValue: helpers.string()
    }, { required: ['username', 'namespace', 'blindedValue'] })
  };
export { __ex_extIdHolds as extIdHolds };
