/**
 * @license
 * Copyright (C) 2020-2021 Pryv S.A. https://pryv.com 
 * 
 * This file is part of Open-Pryv.io and released under BSD-Clause-3 License
 * 
 * Redistribution and use in source and binary forms, with or without 
 * modification, are permitted provided that the following conditions are met:
 * 
 * 1. Redistributions of source code must retain the above copyright notice, 
 *    this list of conditions and the following disclaimer.
 * 
 * 2. Redistributions in binary form must reproduce the above copyright notice, 
 *    this list of conditions and the following disclaimer in the documentation 
 *    and/or other materials provided with the distribution.
 * 
 * 3. Neither the name of the copyright holder nor the names of its contributors 
 *    may be used to endorse or promote products derived from this software 
 *    without specific prior written permission.
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
 * Dummy Data Store. 
 * Send predicatable static data
 */

const { DataStore, UserStreams, UserEvents }  = require('../../interfaces/DataStore');

class Dummy extends DataStore {

  constructor() {  super(); }

  async init(config) {
    // get config and load approriated data store components;
    this._streams = new DummyUserStreams();
    this._events = new DummyUserEvents();
    return this;
  }

  get streams() { return this._streams; }
  get events() { return this._events; }

}


class DummyUserStreams extends UserStreams {
  async get(uid, params) {
    let streams = [{
      id: 'myself',
      name: uid,
      children: [
        {
          id: 'mariana',
          name: 'Mariana'
        },{
          id: 'antonia',
          name: 'Antonia'
        }
      ]
    }];


    UserStreams.applyDefaults(streams);
    
    function findStream(streamId, arrayOfStreams) {
      for (let stream of arrayOfStreams) {
        if (stream.id === streamId) return stream;
        if (stream.children) {
          const found = findStream(streamId, stream.children);
          if (found) return found;
        }
      }
      return [];
    }

    if (params.id && params.id !== '*') { // filter tree
      streams = findStream(params.id, streams);
    }

    
    return streams;
  }
}

class DummyUserEvents extends UserEvents {
  async get(uid, params) {
    const events = [{
      id: 'dummyevent0',
      type: 'note/txt',
      content: 'hello',
      time: Date.now() / 1000,
    }];
    UserEvents.applyDefaults(events);
    return events;
  }
}

module.exports = Dummy;
