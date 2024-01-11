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
const streams = require('./streams.js');

module.exports = [
  // events for the main test stream (no overlap)
  {
    id: 'c_0_e_0',
    streamId: streams[0].children[0].children[0].id,
    time: 1374017471.897,
    duration: 3600,
    type: 'activity/pryv',
    tags: ['super', 'cali', 'fragilistic', 'expiali', 'docious'],
    description: 'First period event, with attachments',
    attachments: {
      document: {
        fileName: 'document.pdf',
        type: 'application/pdf',
        size: 6701
      },
      image: {
        fileName: 'image.png',
        type: 'image/png',
        size: 2765
      }
    },
    modified: 1374114671.898
  },
  {
    id: 'c_0_e_1',
    streamId: streams[0].children[0].children[1].id,
    time: 1374021071.898,
    duration: 7140,
    type: 'activity/pryv',
    tags: [],
    clientData: {
      stringProp: 'O Brother',
      numberProp: 1
    },
    modified: 1374021071.898
  },
  {
    id: 'c_0_e_2',
    streamId: 'c_0',
    time: 1374024671.898,
    type: 'picture/attached',
    tags: ['super'],
    description: '陳容龍',
    attachments: {
      imageBigger: {
        fileName: 'image-bigger.jpg',
        type: 'image/jpeg',
        size: 177476
      }
    },
    modified: 1374024671.898
  },
  {
    id: 'c_0_e_3',
    streamId: streams[0].children[0].children[1].id,
    time: 1374035471.898,
    type: 'activity/pryv',
    duration: 5460,
    tags: ['super', 'cali'],
    modified: 1374035471.898
  },
  {
    id: 'c_0_e_4',
    streamId: streams[0].children[0].children[1].id,
    time: 1374039071.898,
    type: 'activity/pryv',
    tags: [],
    description: 'Mark for specific folder',
    modified: 1374039071.898
  },
  {
    id: 'c_0_e_5',
    streamId: streams[0].children[1].id,
    time: 1374040931.898,
    duration: 3600,
    type: 'activity/pryv',
    tags: [],
    modified: 1374040931.898
  },
  {
    id: 'c_0_e_6',
    streamId: streams[0].children[2].id,
    time: 1374078671.898,
    duration: 7200,
    type: 'activity/pryv',
    tags: [],
    modified: 1374078671.898
  },
  {
    id: 'c_0_e_7',
    streamId: streams[0].children[2].id,
    time: 1374082271.898,
    type: 'activity/pryv',
    tags: [],
    modified: 1374082271.898
  },
  {
    id: 'c_0_e_8',
    streamId: streams[0].children[2].children[0].id,
    time: 1374085871.898,
    duration: 3600,
    type: 'activity/pryv',
    tags: [],
    modified: 1374085871.898
  },
  {
    id: 'c_0_e_9',
    streamId: streams[0].children[0].id,
    time: 1374111071.898,
    duration: null, // running
    type: 'activity/pryv',
    tags: [],
    description: 'One hour ago',
    modified: 1374111071.898
  },
  {
    id: 'c_0_e_10',
    streamId: streams[0].children[0].children[0].id,
    time: 1374112871.898,
    type: 'activity/pryv',
    tags: [],
    description: 'Deleted event',
    trashed: true,
    modified: 1374113771.898
  },
  // also have events for each of the other root test streams
  {
    id: 'c_1_e_11',
    streamId: streams[1].children[0].id,
    time: 1374021071.898,
    duration: 7140,
    type: 'test/test',
    tags: [],
    modified: 1374021071.898
  },
  {
    id: 'c_1_e_12',
    streamId: streams[1].children[0].id,
    time: 1374111071.898,
    duration: null, // running
    type: 'activity/pryv',
    tags: [],
    description: 'One hour ago',
    modified: 1374111071.898
  },
  {
    id: 'c_2_e_13',
    streamId: streams[2].children[0].id,
    time: 1374024671.898,
    type: 'test/test',
    tags: [],
    description: 'Mark for no particular folder',
    modified: 1374024671.898
  },
  {
    id: 'c_3_e_14',
    streamId: streams[3].children[0].id,
    time: 1374035471.898,
    type: 'test/test',
    duration: 5460,
    tags: [],
    modified: 1374035471.898
  }
];
