/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);

const Action = require('api-server/src/schema/Action');
const event = require('api-server/src/schema/event').default;
const helpers = require('api-server/src/schema/helpers');
const object = helpers.object;
const array = helpers.array;
const string = helpers.string;
const number = helpers.number;
const boolean = helpers.boolean;
const auditMethods = {
  get: {
    params: object({
      streams: {},
      types: array(string()),
      fromTime: number(),
      toTime: number(),
      sortAscending: boolean(),
      skip: number(),
      limit: number(),
      modifiedSince: number()
    }, { id: 'auditLogs.get' }),
    result: object({
      auditLogs: array(event(Action.READ))
    }, {
      required: ['auditLogs']
    })
  }
};
export default auditMethods;
export const get = auditMethods.get;
