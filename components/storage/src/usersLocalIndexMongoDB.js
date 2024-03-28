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
 * Contains UserName >> UserId Mapping
 */

class DBIndex {
  id4nameCollection;

  async init () {
    const { getDatabase } = require('storage');
    const db = await getDatabase();
    this.id4nameCollection = await db.getCollection({
      name: 'id4name',
      indexes: [
        {
          index: { userId: 1 },
          options: { unique: true }
        },
        {
          index: { username: 1 },
          options: { unique: true }
        }
      ]
    });
  }

  async getIdForName (username) {
    const res = await this.id4nameCollection.findOne({ username });
    return res?.userId;
  }

  async getNameForId (userId) {
    const res = await this.id4nameCollection.findOne({ userId });
    return res?.username;
  }

  async addUser (username, userId) {
    return await this.id4nameCollection.insertOne({ userId, username });
  }

  async deleteById (userId) {
    return await this.id4nameCollection.deleteOne({ userId });
  }

  /**
   * @returns {Object} An object whose keys are the usernames and values are the user ids.
   */
  async getAllByUsername () {
    const allCursor = this.id4nameCollection.find({});
    const users = {};
    for await (const user of allCursor) {
      users[user.username] = user.userId;
    }
    return users;
  }

  async deleteAll () {
    return await this.id4nameCollection.deleteMany({});
  }
}

module.exports = DBIndex;
