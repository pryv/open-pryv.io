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

const SystemStreamsSerializer = require('business/src/system-streams/serializer');

module.exports = async function platformCheckIntegrity (platformWideDB) {
  const { getUsersRepository } = require('business/src/users/repository'); // to avoid some circular import

  // --- platformDB
  const allEntries = platformWideDB.getAllWithPrefix('user');
  const platformEntryByUser = {};
  for (const entry of allEntries) {
    if (platformEntryByUser[entry.username] == null) platformEntryByUser[entry.username] = {};
    platformEntryByUser[entry.username][entry.field] = { value: entry.value, isUnique: entry.isUnique };
  }

  const errors = [];
  // Retrieve all existing users
  const usersRepository = await getUsersRepository();
  const usersFromRepository = await usersRepository.getAll();
  const indexedFields = SystemStreamsSerializer.getIndexedAccountStreamsIdsWithoutPrefix();

  const infos = {
    usersCountOnPlatform: Object.keys(platformEntryByUser).length,
    usersCountOnRepository: usersFromRepository.length
  };

  for (let i = 0; i < usersFromRepository.length; i++) {
    const userRepo = usersFromRepository[i];
    if (userRepo == null) {
      errors.push('Found null or undefined user in usersRepository when listing with getAll()"');
      continue;
    }
    const username = userRepo.username;
    if (username == null) {
      errors.push('Found null or undefined username in usersRepository for user with id: "' + userRepo.id + '"');
      continue;
    }

    for (const field of indexedFields) {
      const valueRepo = userRepo[field];

      if (valueRepo == null) continue; // we do not expect to find null values in repo

      const isUnique = SystemStreamsSerializer.isUniqueAccountField(field);

      if (platformEntryByUser[username] == null) {
        errors.push(`Cannot find username "${username}" data in platform db while looking for field "${field}" expected value:  "${valueRepo}"`);
        continue;
      } else if (platformEntryByUser[username][field] == null) {
        errors.push(`Cannot find field "${field}" for username "${username}" in the platform db expected value is :  "${valueRepo}"`);
      } else if (platformEntryByUser[username][field].value !== valueRepo) {
        errors.push(`Expected value "${valueRepo}" of field "${field}" for username "${username}" in the platform db but found value :  "${platformEntryByUser[username][field].value}"`);
      } else if (platformEntryByUser[username][field].isUnique !== isUnique) {
        const txt = isUnique ? 'unique found indexed' : 'indexed found unique';
        errors.push(`Expected value "${valueRepo}" of field "${field}" for username "${username}" in the platform db to be "${txt}"`);
      }
      // all tests passed delete entry from platformEntryByUser
      delete platformEntryByUser[username][field];
      // if user in platformEntryByUser is empty delete it
      if (Object.keys(platformEntryByUser[username]).length === 0) delete platformEntryByUser[username];
    }
  }

  // data left in platformEntryByUser is what has not be found in users from repository
  for (const username of Object.keys(platformEntryByUser)) {
    const userFromRepository = await usersRepository.getUserByUsername(username);
    if (userFromRepository == null) {
      errors.push(`Found data for user with username "${username}" in the platform db but cannot find this user in the Repository (System Streams)`);
    }
    for (const field of Object.keys(platformEntryByUser[username])) {
      errors.push(`Found field "${field}" with value: "${platformEntryByUser[username][field].value}" for username "${username}" in the platform db but not in the Repository (System Streams)`);
    }
  }
  return {
    title: 'Platform DB vs users repository',
    infos,
    errors
  };
};
