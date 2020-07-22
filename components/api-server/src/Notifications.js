/**
 * @license
 * Copyright (c) 2020 Pryv S.A. https://pryv.com
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
 * 
 */
// @flow

const EventEmitter = require('events');

// Notifications class distributes notifications inside the current process and
// via NATS server to the other api-server processes. Notifications are also
// sent to the axon PUB socket; this is mostly used by the tests. 
// 
class Notifications extends EventEmitter {
  axonSocket: EventEmitter; 
  
  // Construct a notifications instance. Normally called by the application 
  // start; one per process. 
  // 
  constructor(axonSocket: EventEmitter) {
    super();
    
    if (axonSocket == null)
      throw new Error('AF: axonSocket cannot be null');
    
    this.axonSocket = axonSocket;
  }
  
  serverReady() {
    this.dispatch('server-ready');
  }
  accountChanged(userName: string) {
    this.dispatch('account-changed', userName);
  }
  accessesChanged(userName: string) {
    this.dispatch('accesses-changed', userName);
  }
  followedSlicesChanged(userName: string) {
    this.dispatch('followed-slices-changed', userName);
  }
  streamsChanged(userName: string) {
    this.dispatch('streams-changed', userName);
  }
  eventsChanged(userName: string) {
    this.dispatch('events-changed', userName);
  }
  
  // Send the given `msg` to both internal and external listeners. This is an 
  // internal API, you probably want to use one of the other methods here. 
  //
  dispatch(msg: string, ...msgParts: Array<mixed>) {
    // Send the message to all listeners in-process
    this.emit(msg, ...msgParts);
    
    // And to all listeners on the axon PUB socket
    this.axonSocket.emit(msg, ...msgParts);
  }
}

module.exports = Notifications;

