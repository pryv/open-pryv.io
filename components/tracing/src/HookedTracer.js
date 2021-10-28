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

const ah = require('./hooks');
const { Tags } = require('opentracing');

/**
 * return currentTracer or null if not available
 */
 module.exports.getHookedTracer = (name: string, tags: ?{}): HookedTracer  => {
  const requestContext = ah.getRequestContext();
  //console.log(requestContext);
  return new HookedTracer(requestContext?.data?.tracing, name, tags);
}

class HookedTracer {
  tracing: ?Tracing;
  name: string;
  running: boolean;

  constructor(tracing: ?Tracing, name: string, tags: ?{}) {
    this.tracing = tracing;
    this.name = name;
    this.running = true;
    if (tracing == null) {
      //console.log('Null request Context', name);
    } else {
      //console.log('Start', name);
      this.name = this.tracing.startSpan(this.name, tags);
    }
  }

  tag(tags: ?{}) {
    if (! this.running) throw new Error('Cannot tag a finished span ' + this.name);
    if (tags == null) return;
    for (const [key, value] of Object.entries(tags)) {
      if (this.tracing != null) {
        this.tracing.tagSpan(this.name, key, value);
      }
    }
  }

  finishOnCallBack(cb: FinishCallback): FinishCallback {
    const that = this;
    return function(err, result) {
      if (err != null) { 
        const tags = {'errorId': err.id};
        tags[Tags.ERROR] = true;
        that.tag(tags);
      }
      that.finish();
      cb(err, result);
    }
  }

  finish(tags: ?{}) { 
    if (! this.running) throw new Error('Cannot finish a finished span ' + this.name);
    if (this.tracing == null) {
      return;
    }

    this.tag(tags);
    this.running = false;
    this.tracing.finishSpan(this.name);
  }
}

type FinishCallback = (err?: Error | null, result?: mixed) => mixed;
