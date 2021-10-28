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

module.exports.SERVER_READY = 'server-ready';


module.exports.WEBHOOKS_CREATE = 'wh.creates'; // {username, webhook}
module.exports.WEBHOOKS_ACTIVATE = 'wh.activates'; // {username, webhook}
module.exports.WEBHOOKS_DELETE = 'wh.deletes'; // {username, webhook}

module.exports.SERIES_UPDATE_EVENTID_USERNAME = 'events.update'; // {username, event: { id }}
module.exports.SERIES_DELETE_EVENTID_USERNAME = 'events.delete'; // {username, event: { id }}

// usernamed-based events
module.exports.USERNAME_BASED_EVENTS_CHANGED = 'events-changed'; 
module.exports.USERNAME_BASED_STREAMS_CHANGED = 'streams-changed';
module.exports.USERNAME_BASED_ACCESSES_CHANGED = 'accesses-changed';
module.exports.USERNAME_BASED_ACCOUNT_CHANGED = 'account-changed';
module.exports.USERNAME_BASED_FOLLOWEDSLICES_CHANGED = 'followed-slices-changed';

// pubsub working mode
module.exports.NATS_MODE_ALL = 'all'; // all messages matching are serialized 
module.exports.NATS_MODE_KEY = 'key'; // subscriptions and emit are bound to a key (eg username)
module.exports.NATS_MODE_NONE = 'none'; // don't use nats