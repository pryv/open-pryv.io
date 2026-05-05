/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */

import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);

const testMessaging = require('./test_messaging');
const pubsub = require('./pubsub').default;

const constants = require('./constants');

export { testMessaging, pubsub };
export const SERVER_READY = constants.SERVER_READY;
export const WEBHOOKS_CREATE = constants.WEBHOOKS_CREATE;
export const WEBHOOKS_ACTIVATE = constants.WEBHOOKS_ACTIVATE;
export const WEBHOOKS_DELETE = constants.WEBHOOKS_DELETE;
export const SERIES_UPDATE_EVENTID_USERNAME = constants.SERIES_UPDATE_EVENTID_USERNAME;
export const SERIES_DELETE_EVENTID_USERNAME = constants.SERIES_DELETE_EVENTID_USERNAME;
export const USERNAME_BASED_EVENTS_CHANGED = constants.USERNAME_BASED_EVENTS_CHANGED;
export const USERNAME_BASED_STREAMS_CHANGED = constants.USERNAME_BASED_STREAMS_CHANGED;
export const USERNAME_BASED_ACCESSES_CHANGED = constants.USERNAME_BASED_ACCESSES_CHANGED;
export const USERNAME_BASED_ACCOUNT_CHANGED = constants.USERNAME_BASED_ACCOUNT_CHANGED;
export const TRANSPORT_MODE_ALL = constants.TRANSPORT_MODE_ALL;
export const TRANSPORT_MODE_KEY = constants.TRANSPORT_MODE_KEY;
export const TRANSPORT_MODE_NONE = constants.TRANSPORT_MODE_NONE;
export const NATS_MODE_ALL = constants.NATS_MODE_ALL;
export const NATS_MODE_KEY = constants.NATS_MODE_KEY;
export const NATS_MODE_NONE = constants.NATS_MODE_NONE;
