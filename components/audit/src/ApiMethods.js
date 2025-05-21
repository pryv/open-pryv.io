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

const ALL_METHODS = [
  'getAccessInfo',
  'callBatch',
  'auth.login',
  'auth.logout',
  'auth.register',
  'auth.usernameCheck',
  'auth.emailCheck',
  'auth.delete',
  'accesses.get',
  'accesses.create',
  'accesses.update',
  'accesses.delete',
  'accesses.checkApp',
  'service.info',
  'webhooks.get',
  'webhooks.getOne',
  'webhooks.create',
  'webhooks.update',
  'webhooks.delete',
  'webhooks.test',
  'account.get',
  'account.update',
  'account.changePassword',
  'account.requestPasswordReset',
  'account.resetPassword',
  'followedSlices.get',
  'followedSlices.create',
  'followedSlices.update',
  'followedSlices.delete',
  'profile.getPublic',
  'profile.getApp',
  'profile.get',
  'profile.updateApp',
  'profile.update',
  'streams.get',
  'streams.create',
  'streams.update',
  'streams.delete',
  'events.get',
  'events.getOne',
  'events.create',
  'events.update',
  'events.delete',
  'events.getAttachment',
  'events.deleteAttachment',
  'system.checkPlatformIntegrity',
  'system.createUser',
  'system.deactivateMfa',
  'system.getUserInfo',
  'audit.getLogs'
];

const NOT_AUDITED_METHODS = [
  'service.info',
  'system.getUserInfo',
  'auth.usernameCheck',
  'auth.emailCheck',
  'system.checkPlatformIntegrity'
];

const AUDITED_METHODS = ALL_METHODS.filter(m => !NOT_AUDITED_METHODS.includes(m));

// doesnt include non-audited ones
const WITHOUT_USER_METHODS = [
  'auth.register',
  'system.createUser',
  'system.deactivateMfa'
];

const WITH_USER_METHODS = AUDITED_METHODS.filter(m => !WITHOUT_USER_METHODS.includes(m));

const allMethodsMap = buildMap(ALL_METHODS);

function throwIfMethodIsNotDeclared (methodId) {
  if (methodId.includes('*')) return; // including to register for wildcards such as "followedSlices.*", or "*"
  if (allMethodsMap[methodId]) return;
  throw new Error('Attempting to add a method not declared in audit, methodId: "' + methodId + '". Please add it to components/audit/src/ApiMethods.js#ALL_METHODS');
}

module.exports = {
  AUDITED_METHODS,
  AUDITED_METHODS_MAP: buildMap(AUDITED_METHODS),
  ALL_METHODS,
  ALL_METHODS_MAP: allMethodsMap,
  WITHOUT_USER_METHODS,
  WITHOUT_USER_METHODS_MAP: buildMap(WITHOUT_USER_METHODS),
  WITH_USER_METHODS,
  throwIfMethodIsNotDeclared
};

/**
 * Builds a map with an { i => true } entry for each array element
 * @param {Array<*>} array
 */
function buildMap (array) {
  const map = {};
  array.forEach(i => {
    map[i] = true;
  });
  return map;
}
