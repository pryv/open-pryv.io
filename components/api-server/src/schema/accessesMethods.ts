/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
/**
 * JSON Schema specification of methods data for accesses.
 */

const Action = require('./Action.ts');
const access = require('./access.ts').default;
const error = require('./methodError.ts');
const helpers = require('./helpers.ts');
const itemDeletion = require('./itemDeletion.ts').default;
const object = helpers.object;
const string = helpers.string;
const boolean = helpers.boolean;

const __ex_get = {
    params: object({}, {
      id: 'accesses.get',
      includeDeletions: boolean(),
      includeExpired: boolean()
    }),
    result: object({
      accesses: {
        type: 'array',
        items: access(Action.READ)
      },
      accessDeletions: {
        type: 'array',
        items: access(Action.READ)
      }
    }, {
      required: ['accesses']
    })
  };
export { __ex_get as get };
const __ex_getOne = {
    params: object({
      id: string(),
      includeHistory: boolean()
    }, {
      id: 'accesses.getOne',
      required: ['id']
    }),
    result: object({
      access: access(Action.READ),
      current: string(),
      history: {
        type: 'array',
        items: access(Action.READ)
      }
    }, {
      required: ['access']
    })
  };
export { __ex_getOne as getOne };
const __ex_create = {
    params: access(Action.CREATE),
    result: object({
      access: access(Action.READ)
    }, {
      required: ['access']
    })
  };
export { __ex_create as create };
const __ex_update = {
    params: object({
      id: string(),
      update: access(Action.UPDATE)
    }, {
      id: 'accesses.update',
      required: ['id', 'update']
    }),
    result: object({
      access: access(Action.READ)
    }, {
      required: ['access']
    })
  };
export { __ex_update as update };
const __ex_del = {
    params: object({
      // in path for HTTP requests
      id: string()
    }, {
      id: 'accesses.delete',
      required: ['id']
    }),
    result: object({
      accessDeletion: itemDeletion,
      relatedDeletions: {
        type: 'array',
        items: itemDeletion
      }
    }, {
      required: ['accessDeletion'],
      additionalProperties: false
    })
  };
export { __ex_del as del };
const __ex_getInfo = {
    params: object({}, {
      id: 'accesses.getInfo'
    }),
    result: object({
      type: string({ enum: ['personal', 'app', 'shared'] }),
      name: string(),
      permissions: access.permissions(Action.READ),
      user: object({
        username: string()
      })
    }, {
      required: ['type', 'name', 'permissions'],
      additionalProperties: false
    })
  };
export { __ex_getInfo as getInfo };
const __ex_checkApp = {
    params: object({
      requestingAppId: string(),
      deviceName: string(),
      requestedPermissions: access.permissions(Action.CREATE),
      clientData: object({})
    }, {
      id: 'accesses.checkApp',
      required: ['requestingAppId', 'requestedPermissions'],
      additionalProperties: false
    }),
    result: object({
      matchingAccess: access(Action.READ),
      mismatchingAccess: access(Action.READ),
      checkedPermissions: access.permissions(Action.CREATE),
      error
    }, {
      additionalProperties: false
    })
  };
export { __ex_checkApp as checkApp };
