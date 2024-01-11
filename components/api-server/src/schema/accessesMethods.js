/**
 * @license
 * Copyright (C) 2020–2024 Pryv S.A. https://pryv.com
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
 * JSON Schema specification of methods data for accesses.
 */

const Action = require('./Action');
const access = require('./access');
const error = require('./methodError');
const helpers = require('./helpers');
const itemDeletion = require('./itemDeletion');
const object = helpers.object;
const string = helpers.string;
const boolean = helpers.boolean;

module.exports = {
  get: {
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
  },

  create: {
    params: access(Action.CREATE),
    result: object({
      access: access(Action.READ)
    }, {
      required: ['access']
    })
  },

  del: {
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
  },

  getInfo: {
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
  },

  checkApp: {
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
  }
};
