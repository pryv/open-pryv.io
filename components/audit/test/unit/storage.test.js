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

/* global assert, cuid, audit, initTests */

describe('Audit Storage', () => {
  const userId = cuid();
  const createdBy = cuid();

  before(async () => {
    await initTests();
  });

  describe('receive message and write it into its own database', () => {
    let userStrorage;

    async function sendAndWait (event) {
      const e = Object.assign(
        {
          type: 'log/test',
          createdBy,
          streamIds: [':_audit:test'],
          content: {
            action: 'events.get',
            message: 'hello'
          }
        }, event);
      await audit.eventForUser(userId, e);
      return e;
    }

    before(async () => {
      userStrorage = await audit.storage.forUser(userId);
    });

    it('[KA8B] should have written the action in the user\'s database', async () => {
      const event = await sendAndWait({});
      const entries = userStrorage.getEvents({ query: [{ type: 'equal', content: { field: 'createdBy', value: createdBy } }] });
      assert.equal(entries.length, 1);
      assert.equal(entries[0].createdBy, createdBy);
      assert.deepEqual(entries[0].content, event.content);
    });

    it('[9VM3]  storage.getActions returns a list of available actions', async () => {
      await sendAndWait({ streamIds: ['access-toto', 'action-events.get'] });
      await sendAndWait({ streamIds: ['access-titi', 'action-events.create'] });
      await sendAndWait({ streamIds: ['access-titi', 'action-events.get'] });
      const actions = userStrorage.getAllActions();
      const accesses = userStrorage.getAllAccesses();
      assert.equal(actions.length, 2);
      assert.equal(accesses.length, 2);
    });
  });
});
