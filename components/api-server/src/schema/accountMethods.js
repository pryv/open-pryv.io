/**
 * @license
 * Copyright (C) 2020–2023 Pryv S.A. https://pryv.com
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
 * JSON Schema specification of methods data for user information.
 */

const Action = require('./Action');
const helpers = require('./helpers');
const user = require('./user')(Action.READ);

const accountDetails = helpers.object({
  username: user.properties.username,
  email: user.properties.email,
  language: user.properties.language,
  storageUsed: user.properties.storageUsed
}, {
  required: ['username', 'email', 'storageUsed', 'language'],
  additionalProperties: false
});

// TODO: all this will change after user info is moved to profiles (so that users collection only
//       deals with users' status

module.exports = {
  get: {
    params: helpers.object({}),
    result: helpers.object({
      account: accountDetails
    }, {
      required: ['account']
    })
  },

  update: {
    params: helpers.object({
      // = body of HTTP requests
      update: helpers.object({
        email: helpers.email,
        language: helpers.language
      }, { additionalProperties: false })
    }, {
      required: ['update']
    }),
    result: helpers.object({
      account: accountDetails
    }, {
      required: ['account']
    })
  },

  changePassword: {
    params: helpers.object({
      oldPassword: helpers.string(),
      newPassword: helpers.string({
        minLength: 6,
        maxLength: 100
      })
    }, {
      required: ['oldPassword', 'newPassword'],
      additionalProperties: false
    }),
    result: helpers.object({}, { additionalProperties: false })
  },

  requestPasswordReset: {
    params: helpers.object({
      appId: helpers.string(),
      origin: helpers.string()
    }, {
      required: ['appId']
    }),
    result: helpers.object({}, { additionalProperties: false })
  },

  resetPassword: {
    params: helpers.object({
      appId: helpers.string(),
      origin: helpers.string(),
      resetToken: helpers.string(),
      newPassword: helpers.string({
        minLength: 6,
        maxLength: 100
      })
    }, {
      required: ['appId', 'resetToken', 'newPassword']
    }),
    result: helpers.object({}, { additionalProperties: false })
  }
};
