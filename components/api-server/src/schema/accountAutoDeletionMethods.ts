/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */
import * as helpers from './helpers.ts';

/**
 * JSON Schema specification of the account auto-deletion methods. The
 * schema bounds the types; the values (date format, bounds, policy) are
 * checked by the method, which names the failing rule.
 */

const get = {
  params: helpers.object({})
};
export { get };

const set = {
  params: helpers.object({
    mode: helpers.string({ enum: ['default', 'never', 'date', 'inactivity'] }),
    date: helpers.string({ maxLength: 40 }),
    inactivityDays: helpers.getBaseSchema('integer', { minimum: 1 }),
    action: helpers.string({ enum: ['delete', 'transfer'] }),
    // Transfer settings (`action: 'transfer'`), refused while that action is
    // not offered: accepted here so the answer says why.
    transfer: helpers.object({}),
    acknowledgeNoReminders: helpers.boolean(),
    password: helpers.string({ maxLength: 1000 })
  }, {
    required: ['mode'],
    additionalProperties: false
  })
};
export { set };
