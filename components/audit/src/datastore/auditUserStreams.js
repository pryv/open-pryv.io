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

const ds = require('@pryv/datastore');
const audit = require('audit');

/**
 * Children id: `access-{accessId}`
 */
const accessesStream = {
  id: 'accesses',
  name: 'Accesses',
  parentId: null,
  children: [],
  childrenHidden: true
};
Object.freeze(accessesStream);
/**
 * Children id: `action-{actionId}`
 */
const actionsStream = {
  id: 'actions',
  name: 'Actions',
  parentId: null,
  children: [],
  childrenHidden: true
};
Object.freeze(actionsStream);

const auditStreams = [accessesStream, actionsStream];
Object.freeze(auditStreams);

module.exports = ds.createUserStreams({
  async get (userId, query) {
    if (query.parentId === '*' || query.parentId == null) {
      return auditStreams;
    }
    const parent = await this.getOne(userId, query.parentId, query);
    if (parent == null) return [];
    return parent.children;
  },

  async getOne (userId, streamId, query) {
    // list accesses
    if (streamId === accessesStream.id) {
      const userStorage = await audit.storage.forUser(userId);
      const accesses = userStorage.getAllAccesses();
      if (accesses == null) return null;
      const res = accesses.map((access) => {
        return {
          id: access.term,
          name: access.term,
          children: [],
          parentId: accessesStream.id
        };
      });
      return Object.assign({}, accessesStream, {
        children: res,
        childrenHidden: false
      });
    }

    // list actions
    if (streamId === actionsStream.id) {
      const userStorage = await audit.storage.forUser(userId);
      const actions = userStorage.getAllActions();
      if (actions == null) return null;
      const res = actions.map((action) => {
        return {
          id: action.term,
          name: action.term,
          children: [],
          parentId: actionsStream.id
        };
      });
      return Object.assign({}, actionsStream, {
        children: res,
        childrenHidden: false
      });
    }

    if (streamId) {
      let parentId = null;
      if (streamId.startsWith('access-')) {
        parentId = accessesStream.id;
      } else if (streamId.startsWith('action-')) {
        parentId = actionsStream.id;
      }
      // here check that this access or action stream exists
      return {
        id: streamId,
        name: streamId,
        parentId,
        children: [],
        trashed: false
      };
    }

    return null;
  }
});
