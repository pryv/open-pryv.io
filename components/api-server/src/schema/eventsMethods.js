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
'use strict';
/**
 * JSON Schema specification of methods data for events.
 */
const Action = require('./Action');
const event = require('./event');
const itemDeletion = require('./itemDeletion');
const helpers = require('./helpers');
const object = helpers.object;
const array = helpers.array;
const string = helpers.string;
const number = helpers.number;
const boolean = helpers.boolean;
module.exports = {
  get: {
    params: object({
      streams: {},
      tags: array(string()),
      types: array(string({ pattern: '^(series:)?[a-z0-9-]+/(\\*|[a-z0-9-]+)$' }), { nullable: true }),
      fromTime: number(),
      toTime: number(),
      sortAscending: boolean(),
      skip: number(),
      limit: number(),
      state: string({ enum: ['default', 'trashed', 'all'] }),
      modifiedSince: number(),
      includeDeletions: boolean(),
      auth: string(),
      running: boolean()
    }, { id: 'events.get', additionalProperties: false }),
    result: object({
      events: array(event(Action.READ)),
      eventDeletions: array(itemDeletion)
    }, {
      required: ['events']
    })
  },
  getOne: {
    params: object({
      id: string(),
      includeHistory: boolean()
    }, { id: 'events.getOne' }),
    result: object({
      event: event(Action.READ),
      history: array(event(Action.READ))
    }, {
      required: ['event']
    })
  },
  create: {
    params: event(Action.CREATE),
    result: object({
      event: event(Action.READ)
    }, {
      required: ['event'],
      additionalProperties: false
    })
  },
  update: {
    params: object({
      // in path for HTTP requests
      id: string(),
      // = body of HTTP requests
      update: event(Action.UPDATE)
    }, {
      id: 'events.update',
      required: ['id', 'update']
    }),
    result: object({
      event: event(Action.READ)
    }, {
      required: ['event'],
      additionalProperties: false
    })
  },
  del: {
    params: object({
      // in path for HTTP requests
      id: string()
    }, {
      id: 'events.delete',
      required: ['id']
    }),
    result: {
      anyOf: [
        object({ event: event(Action.READ) }, {
          required: ['event'],
          additionalProperties: false
        }),
        object({ eventDeletion: itemDeletion }, {
          required: ['eventDeletion'],
          additionalProperties: false
        })
      ]
    }
  },
  deleteAttachment: {
    params: object({
      // in path for HTTP requests
      id: string(),
      // in path for HTTP requests
      fileId: string()
    }, {
      required: ['id', 'fileId']
    })
  }
};
