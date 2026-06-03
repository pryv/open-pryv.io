/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);

const helpers = require('api-server/src/schema/helpers.ts');
const validator = require('api-server/src/schema/validation.ts');

const { ALL_METHODS, ALL_METHODS_MAP } = require('./ApiMethods.ts');

/**
 * Utilities to validate Messages
 */

const filterSchema = helpers.object({
  methods: helpers.object({
    include: helpers.array(helpers.string(), { nullable: false }),
    exclude: helpers.array(helpers.string(), { nullable: false })
  },
  {
    id: 'Audit Filter: methods',
    required: ['include', 'exclude'],
    additionalProperties: false
  })
},
{
  id: 'Audit Filter',
  additionalProperties: false
});

interface AuditEvent {
  type?: string;
  createdBy?: string;
  streamIds?: string[];
  [k: string]: unknown;
}

interface AuditFilter {
  methods: {
    include: string[];
    exclude: string[];
  };
}

function eventForUser (userId: string | null | undefined, event: AuditEvent | null | undefined): string | true {
  // validate uiserid
  if (!userId) return 'missing userId passed in validation';
  return eventWithoutUser(event);
}

function eventWithoutUser (event: AuditEvent | null | undefined): string | true {
  if (!event) return 'event is null';
  if (!event.type) return 'event.type is missisng';
  if (!event.createdBy) return 'event.createBy is missing';
  if (!event.streamIds || !Array.isArray(event.streamIds) || event.streamIds.length < 1) {
    return 'event.streamIds is invalid';
  }
  const typeSplit = event.type.split('/');
  if (typeSplit[0] !== 'log') {
    return ('event.type is not in the format of "log/*"');
  }
  return true;
}

function filter (filter: AuditFilter): void {
  const isValid = validator.validate(filter, filterSchema);
  if (!isValid) {
    throw new Error('Invalid "audit:filter" configuration parameter: \n' +
    JSON.stringify(filter, null, 2) +
    '\n' +
    JSON.stringify(validator.getLastError(), null, 2));
  }
  validateFunctions(filter.methods.include);
  validateFunctions(filter.methods.exclude);
  function validateFunctions (methods: string[]): void {
    methods.forEach((m: string) => {
      if (isMethodAggregate(m)) return isValidAggregate(m);
      return ALL_METHODS_MAP[m];
    });

    function isMethodAggregate (m: string): boolean {
      const parts = m.split('.');
      if (parts.length !== 2) return false;
      if (parts[1] !== 'all') return false;
      return true;
    }

    function isValidAggregate (m: string): boolean {
      const parts = m.split('.');
      for (let i = 0; i < ALL_METHODS.length; i++) {
        if (ALL_METHODS[i].startsWith(parts[0])) return true;
      }
      throw new Error('Invalid "audit:filter" configuration parameter: \n' +
        'invalid aggregate method provided: "' + m + '".\n' +
        JSON.stringify(filter, null, 2)
      );
    }
  }
}

export { eventForUser, eventWithoutUser, filter };
