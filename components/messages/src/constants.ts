/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */

const SERVER_READY = 'server-ready';

const WEBHOOKS_CREATE = 'wh.creates'; // {username, webhook}
const WEBHOOKS_ACTIVATE = 'wh.activates'; // {username, webhook}
const WEBHOOKS_DELETE = 'wh.deletes'; // {username, webhook}

const SERIES_UPDATE_EVENTID_USERNAME = 'events.update'; // {username, event: { id }}
const SERIES_DELETE_EVENTID_USERNAME = 'events.delete'; // {username, event: { id }}

// usernamed-based events
const USERNAME_BASED_EVENTS_CHANGED = 'events-changed';
const USERNAME_BASED_STREAMS_CHANGED = 'streams-changed';
const USERNAME_BASED_ACCESSES_CHANGED = 'accesses-changed';
const USERNAME_BASED_ACCOUNT_CHANGED = 'account-changed';
// pubsub working mode
const TRANSPORT_MODE_ALL = 'all'; // all messages matching are serialized
const TRANSPORT_MODE_KEY = 'key'; // subscriptions and emit are bound to a key (eg username)
const TRANSPORT_MODE_NONE = 'none'; // don't use transport
// backward compat aliases
const NATS_MODE_ALL = TRANSPORT_MODE_ALL;
const NATS_MODE_KEY = TRANSPORT_MODE_KEY;
const NATS_MODE_NONE = TRANSPORT_MODE_NONE;

export {
  SERVER_READY,
  WEBHOOKS_CREATE,
  WEBHOOKS_ACTIVATE,
  WEBHOOKS_DELETE,
  SERIES_UPDATE_EVENTID_USERNAME,
  SERIES_DELETE_EVENTID_USERNAME,
  USERNAME_BASED_EVENTS_CHANGED,
  USERNAME_BASED_STREAMS_CHANGED,
  USERNAME_BASED_ACCESSES_CHANGED,
  USERNAME_BASED_ACCOUNT_CHANGED,
  TRANSPORT_MODE_ALL,
  TRANSPORT_MODE_KEY,
  TRANSPORT_MODE_NONE,
  NATS_MODE_ALL,
  NATS_MODE_KEY,
  NATS_MODE_NONE
};
