/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
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
// pubsub working mode
module.exports.TRANSPORT_MODE_ALL = 'all'; // all messages matching are serialized
module.exports.TRANSPORT_MODE_KEY = 'key'; // subscriptions and emit are bound to a key (eg username)
module.exports.TRANSPORT_MODE_NONE = 'none'; // don't use transport
// backward compat aliases
module.exports.NATS_MODE_ALL = module.exports.TRANSPORT_MODE_ALL;
module.exports.NATS_MODE_KEY = module.exports.TRANSPORT_MODE_KEY;
module.exports.NATS_MODE_NONE = module.exports.TRANSPORT_MODE_NONE;
