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

module.exports = [
  {
    id: 'u_0',
    username: 'userzero',
    password: 't3st-Z3r0',
    email: 'zero@test.com',
    language: 'en',
    storageUsed: {
      // values are incorrect but that doesn't matter for tests
      dbDocuments: 0,
      attachedFiles: 275076
    }
  },
  {
    id: 'u_1',
    username: 'userone',
    password: 't3st-0n3',
    email: 'one@test.com',
    language: 'fr'
  },
  {
    id: 'u_2',
    username: '00000',
    password: 't3st-Numb3r',
    email: '00000@test.com',
    language: 'en'
  },
  // auditing
  {
    id: 'u_3',
    username: 'auditorUser',
    password: 't3st-tHr3e',
    email: 'auditor@test.com',
    language: 'en'
  },
  // websockets dash user
  {
    id: 'u_4',
    username: 'user-four',
    password: 't3st-f0uR',
    email: 'user-three@test.com',
    language: 'en'
  }
  // user with system stream permission accesses
  /* { // used to generate dump 1.7.1 - to remove when finished
    id: 'u_5',
    username: 'user-system-perms',
    password: 'walalala',
    email: 'user-system@pryv.com',
    language: 'en',
  }, */
];
