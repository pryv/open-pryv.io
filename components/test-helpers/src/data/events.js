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
const streams = require('./streams');
const timestamp = require('unix-timestamp');
const { TAG_PREFIX } = require('api-server/src/methods/helpers/backwardCompatibility');
const { integrity } = require('business');

const events = [
  {
    id: getTestEventId(0),
    streamId: streams[0].children[0].id,
    time: timestamp.now('-27h'),
    duration: timestamp.duration('1h'),
    type: 'activity/pryv',
    tags: ['super', 'cali', 'fragilistic', 'expiali', 'docious'],
    description: 'First period event, with attachments',
    attachments: [
      {
        id: 'document',
        fileName: 'document.pdf',
        type: 'application/pdf',
        size: 6701
      },
      {
        id: 'image',
        fileName: 'image (space and special chars)é__.png',
        type: 'image/png',
        size: 2765
      }
    ],
    created: timestamp.now(),
    createdBy: 'test',
    modified: timestamp.now(),
    modifiedBy: 'test'
  },
  {
    id: getTestEventId(1),
    streamId: streams[0].children[1].id,
    time: timestamp.now('-26h'),
    duration: timestamp.duration('0h59m'),
    type: 'activity/pryv',
    tags: [],
    clientData: {
      stringProp: 'O Brother',
      otherStringProp: 'Constant sorrow',
      numberProp: 1
    },
    created: timestamp.now('-26h'),
    createdBy: 'test',
    modified: timestamp.now('-26h'),
    modifiedBy: 'test'
  },
  {
    id: getTestEventId(2),
    streamId: streams[0].id,
    time: timestamp.now('-25h'),
    type: 'picture/attached',
    duration: 0, // must be treated just like no duration
    tags: ['super'],
    description: '陳容龍',
    attachments: [
      {
        id: 'imageBigger',
        fileName: 'image-bigger.jpg',
        type: 'image/jpeg',
        size: 177476
      }
    ],
    created: timestamp.now('-25h'),
    createdBy: 'test',
    modified: timestamp.now('-25h'),
    modifiedBy: 'test'
  },
  {
    id: getTestEventId(3),
    streamId: streams[0].children[1].id,
    time: timestamp.now('-22h'),
    type: 'activity/pryv',
    duration: timestamp.duration('1h31m'),
    tags: ['super', 'cali'],
    created: timestamp.now('-22h'),
    createdBy: 'test',
    modified: timestamp.now('-22h'),
    modifiedBy: 'test'
  },
  {
    id: getTestEventId(4),
    streamId: streams[0].children[1].id,
    time: timestamp.now('-21h'),
    type: 'note/webclip',
    content: { url: 'http://yay.boo', body: 'Happy-happy-dance-dance' },
    tags: [],
    description: 'Mark for specific stream',
    created: timestamp.now('-21h'),
    createdBy: 'test',
    modified: timestamp.now('-21h'),
    modifiedBy: 'test'
  },
  {
    id: getTestEventId(5),
    streamId: streams[1].id,
    time: timestamp.now('-20h29m'),
    duration: timestamp.duration('1h'),
    type: 'activity/pryv',
    tags: [],
    created: timestamp.now('-20h29m'),
    createdBy: 'test',
    modified: timestamp.now('-20h29m'),
    modifiedBy: 'test'
  },
  {
    id: getTestEventId(6),
    streamId: streams[2].id,
    time: timestamp.now('-10h'),
    duration: timestamp.duration('2h'),
    type: 'activity/pryv',
    tags: [],
    created: timestamp.now('-10h'),
    createdBy: 'test',
    modified: timestamp.now('-10h'),
    modifiedBy: 'test'
  },
  {
    id: getTestEventId(7),
    streamId: streams[2].id,
    time: timestamp.now('-9h'),
    type: 'activity/pryv',
    tags: [],
    created: timestamp.now('-9h'),
    createdBy: 'test',
    modified: timestamp.now('-9h'),
    modifiedBy: 'test'
  },
  {
    id: getTestEventId(8),
    streamId: streams[2].children[0].id,
    time: timestamp.now('-8h'),
    duration: timestamp.duration('1h'),
    type: 'activity/test',
    content: 'test',
    tags: [],
    created: timestamp.now('-8h'),
    createdBy: 'test',
    modified: timestamp.now('-8h'),
    modifiedBy: 'test'
  },
  {
    id: getTestEventId(9),
    streamId: streams[0].children[0].id,
    time: timestamp.now('-1h'),
    duration: null, // running
    type: 'activity/pryv',
    tags: [],
    description: 'One hour ago',
    created: timestamp.now('-1h'),
    createdBy: 'test',
    modified: timestamp.now('-1h'),
    modifiedBy: 'test'
  },
  {
    id: getTestEventId(10),
    streamId: streams[0].children[0].id,
    time: timestamp.now('-30m'),
    type: 'temperature/c',
    content: 37.2,
    tags: [],
    description: 'Deleted event',
    trashed: true,
    created: timestamp.now('-15m'),
    createdBy: 'test',
    modified: timestamp.now('-15m'),
    modifiedBy: 'test'
  },
  {
    id: getTestEventId(11),
    streamId: streams[1].children[0].id,
    time: timestamp.now('-15m'),
    duration: null, // running
    type: 'activity/pryv',
    tags: ['fragilistic'],
    description: '15 mins ago',
    created: timestamp.now('-15m'),
    createdBy: 'test',
    modified: timestamp.now('-15m'),
    modifiedBy: 'test'
  },
  {
    id: getTestEventId(12),
    streamId: streams[3].id,
    time: timestamp.now(),
    type: 'picture/attached',
    tags: [],
    attachments: [
      {
        id: 'animatedGif',
        fileName: 'animated.gif',
        type: 'image/gif',
        size: 88134
      }
    ],
    created: timestamp.now(),
    createdBy: 'test',
    modified: timestamp.now(),
    modifiedBy: 'test'
  },

  // deletions
  {
    id: getTestEventId(13),
    deleted: timestamp.now('-5m')
  },
  {
    id: getTestEventId(14),
    deleted: timestamp.now('-1d')
  },
  {
    id: getTestEventId(15),
    deleted: timestamp.now('-2y') // to be cleaned up by Mongo TTL
  },

  // auditing
  {
    id: getTestEventId(16),
    streamId: streams[7].id,
    time: timestamp.now('+32h'),
    duration: timestamp.duration('1m'),
    type: 'activity/pryv',
    tags: ['super', 'cali', 'fragilistic', 'expiali', 'docious'],
    description: 'top of the history array, most recent modified event',
    created: timestamp.now('-9h'),
    createdBy: 'test',
    modified: timestamp.now('-3h'),
    modifiedBy: 'test'
  },
  {
    id: getTestEventId(17),
    headId: getTestEventId(16),
    streamId: streams[7].id,
    time: timestamp.now('+32h'),
    duration: timestamp.duration('1m'),
    type: 'activity/pryv',
    tags: ['super', 'cali', 'fragilistic', 'expiali', 'docious'],
    description: 'bottom of the history, event upon creation.',
    created: timestamp.now('-9h'),
    createdBy: 'test',
    modified: timestamp.now('-9h'),
    modifiedBy: 'test'
  },
  {
    id: getTestEventId(18),
    headId: getTestEventId(16),
    streamId: streams[7].id,
    time: timestamp.now('+32h'),
    duration: timestamp.duration('1m'),
    type: 'activity/pryv',
    tags: ['super', 'cali', 'fragilistic', 'expiali', 'docious'],
    description: 'middle of the history, first modification',
    created: timestamp.now('-9h'),
    createdBy: 'test',
    modified: timestamp.now('-6h'),
    modifiedBy: 'test'
  },
  {
    id: getTestEventId(19),
    streamId: streams[7].id,
    time: timestamp.now('3h'),
    type: 'activity/pryv',
    tags: [],
    description: 'trashed event used to simplify deletion tests.',
    trashed: true,
    created: timestamp.now('-2h'),
    createdBy: 'test',
    modified: timestamp.now(),
    modifiedBy: 'test'
  },
  {
    id: getTestEventId(20),
    headId: getTestEventId(19),
    streamId: streams[7].id,
    time: timestamp.now('2h'),
    type: 'activity/pryv',
    tags: [],
    description: 'trashed event used to simplify deletion tests.',
    trashed: true,
    created: timestamp.now('-2h'),
    createdBy: 'test',
    modified: timestamp.now('-1h'),
    modifiedBy: 'test'
  },
  {
    id: getTestEventId(21),
    headId: getTestEventId(19),
    streamId: streams[7].id,
    time: timestamp.now('1h'),
    type: 'activity/pryv',
    tags: [],
    description: 'trashed event used to simplify deletion tests.',
    trashed: true,
    created: timestamp.now('-2h'),
    createdBy: 'test',
    modified: timestamp.now('-2h'),
    modifiedBy: 'test'
  },
  {
    id: getTestEventId(22),
    streamId: streams[7].id,
    time: timestamp.now('+43h'),
    type: 'activity/pryv',
    tags: [],
    description: 'simple event with nothing special A',
    created: timestamp.now('-1h'),
    createdBy: 'test',
    modified: timestamp.now('-1h'),
    modifiedBy: 'test'
  },
  {
    id: getTestEventId(23),
    streamId: streams[7].id,
    time: timestamp.now('-5h'),
    duration: null, // running
    type: 'activity/pryv',
    tags: [],
    description: 'event started one hour ago on a normal stream',
    created: timestamp.now('-1h'),
    createdBy: 'test',
    modified: timestamp.now('-1h'),
    modifiedBy: 'test'
  },
  {
    id: getTestEventId(24),
    streamId: streams[8].id,
    time: timestamp.now('-6h'),
    duration: null, // running
    type: 'activity/pryv',
    tags: [],
    description: 'event started one hour ago on a singleActivity stream',
    created: timestamp.now('-1h'),
    createdBy: 'test',
    modified: timestamp.now('-1h'),
    modifiedBy: 'test'
  },
  {
    id: getTestEventId(25),
    streamId: streams[7].children[0].id,
    time: timestamp.now('+41h'),
    type: 'activity/pryv',
    tags: [],
    description: 'simple event with nothing special B',
    created: timestamp.now('-1h'),
    createdBy: 'test',
    modified: timestamp.now('-30m'),
    modifiedBy: 'test'
  },
  {
    id: getTestEventId(26),
    headId: getTestEventId(25),
    streamId: streams[7].children[0].id,
    time: timestamp.now('+41h'),
    type: 'activity/pryv',
    tags: [],
    description: 'simple event with nothing special - original version',
    created: timestamp.now('-1h'),
    createdBy: 'test',
    modified: timestamp.now('-1h'),
    modifiedBy: 'test'
  },
  {
    id: getTestEventId(27),
    streamId: streams[8].id,
    time: 0,
    type: 'note/txt',
    tags: [],
    content: 'I am a simple event with time 0',
    description: 'simple event with time 0',
    created: 0,
    createdBy: 'test',
    modified: 0,
    modifiedBy: 'test'
  },
  {
    id: getTestEventId(29),
    deleted: timestamp.now('-4m'),
    trashed: true,
    streamId: streams[7].children[0].id,
    time: timestamp.now(),
    type: 'activity/pryv',
    tags: [],
    description: 'Event deleted and trashed but kept with full content',
    created: timestamp.now('-1h'),
    createdBy: 'test',
    modified: timestamp.now('-30m'),
    modifiedBy: 'test'
  }
].map(function (event) {
  if (event.streamId) {
    event.streamIds = [event.streamId];
    delete event.streamId;
  }
  if (event.tags != null) {
    for (const tag of event.tags) {
      event.streamIds.push(TAG_PREFIX + tag);
    }
    // tags are deleted in resetEvents(), just before writing the fixtures in MongoDB
  }

  let origId = null;
  if (event.headId) { // remove headId to compute integrity
    origId = event.id;
    event.id = event.headId;
    delete event.headId;
  }
  integrity.events.set(event, false);
  if (origId) {
    event.headId = event.id;
    event.id = origId;
  }
  return event;
});

module.exports = events;

/**
 * Creates a cuid-like id (required event id format).
 * @param n
 */
function getTestEventId (n) {
  n = n + '';
  return 'cthisistesteventno' + (n.length >= 7 ? n : new Array(7 - n.length + 1).join('0') + n);
}
