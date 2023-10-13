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
const streams = require('./streams.js');

module.exports = [
  {
    token: 'a_0',
    name: 'pryv-browser',
    type: 'personal'
  },
  {
    token: 'a_1',
    name: 'channel 0: read + folder-specific, channel 1: contribute, channel 2: manage, ' +
        'others: read',
    type: 'shared',
    permissions: [
      {
        streamId: streams[0].id,
        level: 'read'
      },
      {
        streamId: streams[0].children[0].id,
        level: 'read'
      },
      {
        streamId: streams[0].children[1].id,
        level: 'contribute'
      },
      {
        streamId: streams[0].children[2].children[0].id,
        level: 'manage'
      },
      {
        streamId: streams[1].id,
        level: 'contribute'
      },
      {
        streamId: streams[2].id,
        level: 'manage'
      },
      {
        streamId: '*',
        level: 'read'
      }
    ]
  },
  {
    token: 'a_2',
    name: 'channel 0: read all',
    type: 'shared',
    permissions: [
      {
        streamId: streams[0].id,
        level: 'read'
      }
    ]
  },
  {
    token: 'a_3',
    name: 'no permission',
    type: 'shared',
    permissions: []
  },
  {
    token: 'a_4',
    name: 'test-3rd-party-app-id',
    type: 'app',
    deviceName: 'Calvin\'s Amazing Transmogrifier',
    permissions: [
      {
        streamId: streams[0].id,
        level: 'contribute'
      }
    ]
  }
];
