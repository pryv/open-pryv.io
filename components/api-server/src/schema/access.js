/**
 * @license
 * Copyright (c) 2020 Pryv S.A. https://pryv.com
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
 * 
 */
/**
 * JSON Schema specification for accesses.
 */

const Action = require('./Action');
const helpers = require('./helpers');
const object = helpers.object;
const array = helpers.array;
const string = helpers.string;
const _ = require('lodash');

/**
 * @param {Action} action
 */
exports = module.exports = function (action) {
  if (action === Action.STORE) { action = Action.READ; } // read items === stored items

  var base = object({
    'token': string({minLength: 1}),
    'name': string({minLength: 1}),
    'permissions': permissions(action),
    'lastUsed': helpers.number()
  }, {
    additionalProperties: false
  });
  helpers.addTrackingProperties(base);

  // explicitly forbid 'id' on create TODO: ignore it instead
  if (action !== Action.CREATE) {
    base.properties.id = string();
  }

  // explicitly forbid 'calls' on anything but store (purely internal)
  if (action === Action.STORE) {
    base.properties.calls = object({});
  }

  var personal = _.cloneDeep(base);
  _.extend(personal.properties, {
    'type': string({enum: ['personal']})
  });

  var app = _.cloneDeep(base);
  _.extend(app.properties, {
    'type': string({enum: ['app']}),
    'deviceName': string()
  });

  var shared = _.cloneDeep(base);
  _.extend(shared.properties, {
    'type': string({enum: ['shared']})
  });

  switch (action) {
    case Action.READ:
      personal.required = [ 'id', 'token', 'name', 'type',
        'created', 'createdBy', 'modified', 'modifiedBy' ];
      app.required = [ 'id', 'token', 'name', 'type', 'permissions',
        'created', 'createdBy', 'modified', 'modifiedBy' ];
      shared.required = [ 'id', 'token', 'name', 'type', 'permissions',
        'created', 'createdBy', 'modified', 'modifiedBy' ];
      break;
      
    case Action.CREATE:
      personal.required = [ 'name' ];
      app.required = [ 'name', 'permissions' ];
      shared.required = [ 'name', 'permissions' ];
      
      // Allow expireAfter to set expiry on new access
      app.properties.expireAfter = helpers.number(); 
      shared.properties.expireAfter = helpers.number(); 
      
      // Allow to attach clientData to new access
      personal.properties.clientData = helpers.object({}); 
      app.properties.clientData = helpers.object({}); 
      shared.properties.clientData = helpers.object({}); 

      break;
      
    case Action.UPDATE:
      // Allow expireAfter to set expiry on access
      app.properties.expireAfter = helpers.number(); 
      app.properties.expires = helpers.null(); 

      shared.properties.expireAfter = helpers.number(); 
      shared.properties.expires = helpers.null(); 
      
      // Allow to attach clientData to access
      personal.properties.clientData = helpers.object({}, {nullable: true}); 
      app.properties.clientData = helpers.object({}, {nullable: true}); 
      shared.properties.clientData = helpers.object({}, {nullable: true}); 

      break;
  }
    
  var res = {
    id: helpers.getTypeURI('access', action),
    anyOf: [ personal, app, shared ]
  };
  
  // whitelist for properties that can be updated
  if (action === Action.UPDATE) {
    res.alterableProperties = [
      'name', 'deviceName', 'permissions', 'expireAfter', 'expires', 'clientData'];
  }
  
  return res;
};

var permissionLevel = exports.permissionLevel = string({ enum: ['read', 'contribute', 'manage', 'create-only']});

var featureSetting = exports.featureSetting = string({ enum: ['forbidden']});

var permissions = exports.permissions = function (action) {
  var streamPermission = object({
    'streamId': {
      type: ['string', 'null']
    },
    'level': permissionLevel
  }, {
    id: 'streamPermission',
    additionalProperties: false,
    required: [ 'streamId', 'level' ]
  });
  if (action === Action.CREATE) {
    // accept additional props for the app authorization process
    streamPermission.properties.defaultName = string({pattern: '\\w+' /*not empty*/ });
    streamPermission.properties.name = string();
  }

  var tagPermission = object({
    'tag': string(),
    'level': permissionLevel
  }, {
    id: 'tagPermission',
    additionalProperties: false,
    required: [ 'tag', 'level' ]
  });

  var featurePermission = object({
    'feature': string(),
    'setting': featureSetting
  }, {
    id: 'featurePermission',
    additionalProperties: false,
    required: ['feature', 'setting']
  });

  return array({
    oneOf: [streamPermission, tagPermission, featurePermission]
  });
};
