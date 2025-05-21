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
/**
 * JSON Schema specification for events.
 */

const Action = require('./Action');
const helpers = require('./helpers');
const object = helpers.object;
const array = helpers.array;
const string = helpers.string;
const number = helpers.number;
const boolean = helpers.boolean;

/**
 * @param {Action} action
 */
exports = module.exports = function (action) {
  // read items === stored items
  if (action === Action.STORE) {
    action = Action.READ;
  }

  const schema = object({
    id: string(),
    time: number(),
    duration: number({ nullable: true }),
    streamId: string(),
    streamIds: array(string(), { nullable: false, minItems: 1 }),
    tags: array(string(), { nullable: true }),
    type: string({ pattern: '^(series:)?[a-z0-9-]+/[a-z0-9-]+$' }),
    content: {},
    description: string({ nullable: true }),
    clientData: object({}, { nullable: true }),
    trashed: boolean({ nullable: true }),
    integrity: string({ nullable: true })
  }, {
    id: helpers.getTypeURI('event', action),
    additionalProperties: false
  });

  helpers.addTrackingProperties(schema, action);

  if (action !== Action.CREATE) {
    schema.properties.id = string();
  }

  if (action === Action.CREATE) {
    // only allow cuid-like strings for custom ids
    schema.properties.id.pattern = '(?=^\\:[a-z0-9-]+\\:)(^\\:[a-z0-9-]+\\:[a-z0-9A-Z-]{1,256})|(^c[a-z0-9-]{24}$)';
    // only allow "files" (raw file data) on create; no further checks as it's
    // created internally
    schema.properties.files = array(object({}));
  }

  // forbid attachments except on read and update (ignored for the latter)
  if (action === Action.READ) {
    schema.properties.attachments = exports.attachments;
  } else if (action === Action.UPDATE) {
    schema.properties.attachments = { type: 'array' };
    // whitelist for properties that can be updated
    schema.alterableProperties = ['streamId', 'streamIds', 'time', 'duration', 'type',
      'content', 'tags', 'references', 'description', 'clientData', 'trashed'];
  }

  switch (action) {
    case Action.READ:
      schema.required = ['id', 'streamId', 'streamIds', 'time', 'type',
        'created', 'createdBy', 'modified', 'modifiedBy'];
      break;
    case Action.CREATE:
      schema.required = ['type'];
      schema.anyOf = [{ required: ['streamId'] }, { required: ['streamIds'] }];
      break;
  }

  return schema;
};

exports.attachments = array(object({
  id: string(),
  fileName: string(),
  type: string(),
  size: number(),
  readToken: string(),
  integrity: string()
}, {
  required: ['id', 'fileName', 'type', 'size', 'readToken'],
  additionalProperties: false
}));
