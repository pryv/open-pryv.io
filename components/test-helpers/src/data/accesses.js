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
const streams = require('./streams');
const timestamp = require('unix-timestamp');

module.exports = [
  {
    id: 'a_0',
    token: 'a_0_token',
    apiEndpoint: 'https://a_0_token@userzero.pryv.me/',
    name: 'pryv-test',
    type: 'personal',
    created: timestamp.now(),
    createdBy: 'test',
    modified: timestamp.now(),
    modifiedBy: 'test',
    lastUsed: 0,
    calls: {}
  },
  {
    id: 'a_1',
    token: 'a_1_token',
    apiEndpoint: 'https://a_1_token@userzero.pryv.me/',
    name: 'stream 0: read, stream 1: contribute, stream 2.0: manage',
    type: 'shared',
    permissions: [
      {
        streamId: streams[0].id,
        level: 'read'
      },
      {
        streamId: streams[1].id,
        level: 'contribute'
      },
      {
        streamId: streams[2].children[0].id,
        level: 'manage'
      }
    ],
    created: timestamp.now(),
    createdBy: 'test',
    modified: timestamp.now(),
    modifiedBy: 'test',
    lastUsed: 0,
    calls: {}
  },
  {
    id: 'a_2',
    token: 'a_2_token',
    apiEndpoint: 'https://a_2_token@userzero.pryv.me/',
    name: 'read all',
    type: 'shared',
    permissions: [
      {
        streamId: '*',
        level: 'read'
      }
    ],
    created: timestamp.now(),
    createdBy: 'test',
    modified: timestamp.now(),
    modifiedBy: 'test',
    lastUsed: 0,
    deviceName: null,
    calls: {}
  },
  {
    id: 'a_3',
    token: 'a_3_token',
    apiEndpoint: 'https://a_3_token@userzero.pryv.me/',
    name: 'no permission',
    type: 'shared',
    permissions: [],
    created: timestamp.now(),
    createdBy: 'test',
    modified: timestamp.now(),
    modifiedBy: 'test',
    lastUsed: 0,
    calls: {}
  },
  {
    id: 'a_4',
    token: 'a_4_token',
    apiEndpoint: 'https://a_4_token@userzero.pryv.me/',
    name: 'test-3rd-party-app-id',
    type: 'app',
    deviceName: 'Calvin\'s Amazing Transmogrifier',
    permissions: [
      {
        streamId: streams[0].id,
        level: 'contribute'
      }
    ],
    created: timestamp.now(),
    createdBy: 'test',
    modified: timestamp.now(),
    modifiedBy: 'test',
    lastUsed: 0,
    calls: {}
  },
  {
    id: 'a_5',
    token: 'a_5_token',
    apiEndpoint: 'https://a_5_token@userzero.pryv.me/',
    name: 'deleted shared (should expire)',
    type: 'shared',
    permissions: [
      {
        streamId: streams[0].id,
        level: 'read'
      }
    ],
    created: timestamp.now('-4y'),
    createdBy: 'test',
    modified: timestamp.now('-4y'),
    modifiedBy: 'test',
    lastUsed: timestamp.now('-3y1d'),
    calls: {},
    deleted: timestamp.now('-3y1d')
  },
  {
    id: 'a_6',
    token: 'a_6_token',
    apiEndpoint: 'https://a_6_token@userzero.pryv.me/',
    name: 'stream 2.1: manage',
    type: 'shared',
    permissions: [
      {
        streamId: streams[2].children[1].id,
        level: 'manage'
      }
    ],
    created: timestamp.now(),
    createdBy: 'test',
    modified: timestamp.now(),
    modifiedBy: 'test',
    lastUsed: 0,
    calls: {}
  }
  /* { // used to generate dump 1.7.1 - to remove when finished
    id: 'a_6',
    token: 'a_6_token',
    apiEndpoint: 'htpps://a_6_token@user-system-perms.pryv.me/',
    name: 'access with system stream permissions',
    type: 'app',
    permissions: [
      {
        streamId: '.account',
        level: 'read',
      },
      {
        streamId: '.email',
        level: 'contribute',
      },
    ],
    created: timestamp.now('-1y'),
    createdBy: 'test',
    modified: timestamp.now('-1y'),
    modifiedBy: 'test',
    lastUsed: timestamp.now('-1m'),
    calls: {},
    deleted: timestamp.now('-1m')
  } */
];
