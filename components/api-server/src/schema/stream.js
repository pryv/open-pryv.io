/**
 * @license
 * Copyright (C) 2020-2021 Pryv S.A. https://pryv.com 
 * 
 * This file is part of Open-Pryv.io and released under BSD-Clause-3 License
 * 
 * Redistribution and use in source and binary forms, with or without 
 * modification, are permitted provided that the following conditions are met:
 * 
 * 1. Redistributions of source code must retain the above copyright notice, 
 *    this list of conditions and the following disclaimer.
 * 
 * 2. Redistributions in binary form must reproduce the above copyright notice, 
 *    this list of conditions and the following disclaimer in the documentation 
 *    and/or other materials provided with the distribution.
 * 
 * 3. Neither the name of the copyright holder nor the names of its contributors 
 *    may be used to endorse or promote products derived from this software 
 *    without specific prior written permission.
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
 * JSON Schema specification for event streams.
 */

const Action = require('./Action');
const helpers = require('./helpers');
const object = helpers.object;
const array = helpers.array;
const string = helpers.string;
const boolean = helpers.boolean;

/**
 * @param {Action} action
 * @param {Boolean} ignoreChildren Whether to ignore `children` property
 * @param {String} refToStreamSchema
 */
module.exports = function (action, ignoreChildren, refToStreamSchema) {
  let schema = {
    id: helpers.getTypeURI('stream', action),
    type: 'object',
    additionalProperties: false,
    properties: {
      'id': string({minLength: 1}),
      'name': string({minLength: 1}),
      'parentId': string({nullable: true, minLength: 1}),
      'clientData': object({}, {nullable: true}),
      'trashed': boolean({nullable: true}),
      // ignored except on READ, accepted to simplify interaction with client frameworks
      'children': array({'$ref': refToStreamSchema || '#'}, {nullable: true}),
      'childrenHidden': boolean({nullable: true}),
    }
  };

  helpers.addTrackingProperties(schema, action);

  switch (action) {
    case Action.READ:
      schema.required = [ 'id', 'name', 'parentId',
        'created', 'createdBy', 'modified', 'modifiedBy' ];
      if (! ignoreChildren){ 
        schema.required.push('children');
      }
      break;
    case Action.STORE:
      schema.required = [ 'id', 'name', 'parentId',
        'created', 'createdBy', 'modified', 'modifiedBy' ];
      break;
    case Action.CREATE:
      schema.required = [ 'name' ];
      break;
    case Action.UPDATE:
      // whitelist for properties that can be updated
      schema.alterableProperties = ['name', 'parentId',
        'clientData', 'trashed'];
      break;
  }

  return schema;
};
