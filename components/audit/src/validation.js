/**
 * @license
 * Copyright (C) 2020–2025 Pryv S.A. https://pryv.com
 *
 * This file is part of Open-Pryv.io and released under BSD-Clause-3 License
 *
 * Redistribution and use in source and binary forms, with or without
 * modification, are permitted provided that the following conditions are met:
 *
 * 1. Redistributions of source code must retain the above copyright notice,
 *   this list of conditions and the following disclaimer.
 *
 * 2. Redistributions in binary form must reproduce the above copyright notice,
 *   this list of conditions and the following disclaimer in the documentation
 *   and/or other materials provided with the distribution.
 *
 * 3. Neither the name of the copyright holder nor the names of its contributors
 *   may be used to endorse or promote products derived from this software
 *   without specific prior written permission.
 *
 * THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS "AS IS"
 * AND ANY EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT LIMITED TO, THE
 * IMPLIED WARRANTIES OF MERCHANTABILITY AND FITNESS FOR A PARTICULAR PURPOSE ARE
 * DISCLAIMED. IN NO EVENT SHALL THE COPYRIGHT HOLDER OR CONTRIBUTORS BE LIABLE
 * FOR ANY DIRECT, INDIRECT, INCIDENTAL, SPECIAL, EXEMPLARY, OR CONSEQUENTIAL
 * DAMAGES (INCLUDING, BUT NOT LIMITED TO, PROCUREMENT OF SUBSTITUTE GOODS OR
 * SERVICES; LOSS OF USE, DATA, OR PROFITS; OR BUSINESS INTERRUPTION) HOWEVER
 * CAUSED AND ON ANY THEORY OF LIABILITY, WHETHER IN CONTRACT, STRICT LIABILITY,
 * OR TORT (INCLUDING NEGLIGENCE OR OTHERWISE) ARISING IN ANY WAY OUT OF THE USE
 * OF THIS SOFTWARE, EVEN IF ADVISED OF THE POSSIBILITY OF SUCH DAMAGE.
 *
 * SPDX-License-Identifier: BSD-3-Clause
 */

const helpers = require('api-server/src/schema/helpers');
const validator = require('api-server/src/schema/validation');

const { ALL_METHODS, ALL_METHODS_MAP } = require('./ApiMethods');

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

/**
 * @param {identifier} userId
 * @param {PryvEvent} event
 */
function eventForUser (userId, event) {
  // validate uiserid
  if (!userId) return 'missing userId passed in validation';
  return eventWithoutUser(event);
}

function eventWithoutUser (event) {
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

function filter (filter) {
  const isValid = validator.validate(filter, filterSchema);
  if (!isValid) {
    throw new Error('Invalid "audit:filter" configuration parameter: \n' +
    JSON.stringify(filter, null, 2) +
    '\n' +
    JSON.stringify(validator.getLastError(), null, 2));
  }
  validateFunctions(filter.methods.include);
  validateFunctions(filter.methods.exclude);
  function validateFunctions (methods) {
    methods.forEach(m => {
      if (isMethodAggregate(m)) return isValidAggregate(m);
      return ALL_METHODS_MAP[m];
    });

    function isMethodAggregate (m) {
      const parts = m.split('.');
      if (parts.length !== 2) return false;
      if (parts[1] !== 'all') return false;
      return true;
    }

    function isValidAggregate (m) {
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

module.exports = {
  eventForUser,
  eventWithoutUser,
  filter
};
