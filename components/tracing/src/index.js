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
const { Tracing, DummyTracing } = require('./Tracing');
const { getHookerTracer } = require('./HookedTracer');
const dataBaseTracer = require('./databaseTracer');
const { getConfigUnsafe } = require('@pryv/boiler');
const isTracingEnabled = getConfigUnsafe(true).get('trace:enable');
const launchTags = getConfigUnsafe(true).get('trace:tags');
module.exports.DummyTracing = DummyTracing;
module.exports.dataBaseTracer = dataBaseTracer;
module.exports.getHookerTracer = getHookerTracer;
/**
 * Starts a root span. For socket.io usage.
 * @param {string} name
 * @param {{} | undefined | null} tags
 * @returns {any}
 */
function initRootSpan (name, tags = {}) {
  if (!isTracingEnabled) { return new DummyTracing(); }
  const myTags = Object.assign(Object.assign({}, launchTags), tags);
  const tracing = new Tracing();
  tracing.startSpan(name, { tags: myTags });
  return tracing;
}
module.exports.initRootSpan = initRootSpan;
/**
 * Returns an ExpressJS middleware that starts a span and attaches the "tracing" object to the request parameter.
 */
module.exports.tracingMiddleware = (name = 'express1', tags) => {
  return function (req, res, next) {
    if (req.tracing != null) {
      console.log('XXXXX tracing already set', new Error());
      return next();
    }
    const tracing = initRootSpan(name, tags);
    res.on('close', () => {
      const extra = req.context?.methodId || req.url;
      tracing.finishSpan(name, name + ':' + extra);
    });
    req.tracing = tracing;
    next();
  };
};
