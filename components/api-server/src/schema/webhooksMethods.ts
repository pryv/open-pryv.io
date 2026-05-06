/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
/**
 * JSON Schema specification of methods data for Webhooks.
 */

const Action = require('./Action');
const webhook = require('./webhook').default;
const helpers = require('./helpers');
const itemDeletion = require('./itemDeletion').default;
const object = helpers.object;
const string = helpers.string;

const __ex_get = {
    params: object({}, {
      id: 'webhooks.get'
    }),
    result: object({
      webhooks: {
        type: 'array',
        items: webhook(Action.READ)
      }
    }, { required: ['webhooks'] })
  };
export { __ex_get as get };
const __ex_getOne = {
    params: object({
      // in path for HTTP requests
      id: string()
    }, {
      id: 'webhooks.getOne',
      required: ['id']
    }),
    result: object({
      webhook: webhook(Action.READ)
    }, { required: ['webhook'] })
  };
export { __ex_getOne as getOne };
const __ex_create = {
    params: webhook(Action.CREATE),
    result: object({
      webhook: webhook(Action.READ)
    }, { required: ['webhook'] })
  };
export { __ex_create as create };
const __ex_update = {
    params: object({
      // in path for HTTP requests
      id: string(),
      // = body of HTTP requests
      update: webhook(Action.UPDATE)
    }, {
      id: 'webhooks.update',
      required: ['id', 'update']
    }),
    result: object({
      webhook: webhook(Action.READ)
    }, {
      required: ['webhook']
    })
  };
export { __ex_update as update };
const __ex_del = {
    params: object({
      // in path for HTTP requests
      id: string()
    }, {
      id: 'webhooks.delete',
      required: ['id']
    }),
    result: object({ webhookDeletion: itemDeletion }, {
      required: ['webhookDeletion'],
      additionalProperties: false
    })
  };
export { __ex_del as del };
const __ex_test = {
    params: object({
      // in path for HTTP requests
      id: string()
    }, {
      id: 'webhooks.test',
      required: ['id']
    }),
    result: object({
      webhook: webhook(Action.READ)
    }, { required: ['webhook'] })
  };
export { __ex_test as test };
