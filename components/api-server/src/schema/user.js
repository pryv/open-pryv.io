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
 * JSON Schema specification for users.
 */

var Action = require('./Action'),
    helpers = require('./helpers');

/**
 * @param {Action} action
 */
module.exports = function (action) {
  var schema = {
    id: helpers.getTypeURI('user', action),
    type: 'object',
    additionalProperties: false,
    properties: {
      username: helpers.username,
      email: helpers.email,
      language: helpers.language,
      appId: helpers.string(),
      referer: helpers.string({ nullable: true }), 
      invitationToken: helpers.string({ nullable: true }), 
      storageUsed: helpers.object({
        dbDocuments: helpers.number(),
        attachedFiles: helpers.number()
      }, {required: [ 'dbDocuments', 'attachedFiles' ]})
    }
  };

  // explicitly forbid 'id' on create
  if (action !== Action.CREATE) {
    schema.properties.id = helpers.string();
  }

  // only accept password hash on create (request from registration-server) (and store of course)
  if (action === Action.CREATE || action === Action.STORE) {
    schema.properties.passwordHash = helpers.string();
  }

  switch (action) {
  case Action.READ:
    schema.required = [ 'id', 'username', 'email', 'language' ];
    break;
    case Action.STORE:
    schema.required = ['id', 'username', 'email', 'language', 'storageUsed' ];
    // TODO ILIA - load custom streams correctly here as is done in schema/authMethods
    schema.additionalProperties = true;
    break;
  case Action.CREATE:
    schema.required = [ 'username', 'passwordHash', 'email', 'language' ];
    break;
  }

  return schema;
};
