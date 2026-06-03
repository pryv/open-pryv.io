/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { createId: cuid } = require('@paralleldrive/cuid2');
const accountStreams = require('business/src/system-streams/index.ts');

type SystemStream = { id: string; isUnique?: boolean; isShown?: boolean; children?: SystemStream[]; [k: string]: unknown };
type Event = { streamIds: string[]; content: unknown; [k: string]: unknown };
type UserParams = {
  id?: string;
  username?: string;
  password?: string;
  events?: Event[];
  [k: string]: unknown;
};

function pick<T extends object> (obj: T, keys: readonly string[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  const rec = obj as unknown as Record<string, unknown>;
  for (const k of keys) if (k in rec) out[k] = rec[k];
  return out;
}

class User {
  // User properties that exists by default (email could not exist with specific config)

  id!: string;

  username: string;

  email: string | undefined;

  language: string | undefined;

  password: string | undefined;

  accessId: string | undefined;

  events: Event[] | undefined;
  /** @default [] */
  accountFields: string[] = [];
  /** @default [] */
  readableAccountFields: string[] = [];
  /** @default [] */
  accountFieldsWithPrefix: string[] = [];
  /** @default [] */
  uniqueAccountFields: string[] = [];
  [k: string]: unknown;
  constructor (params: UserParams) {
    this.username = params.username as string;
    buildAccountFields(this);
    loadAccountData(this, params);
    if (params.events != null) { this.events = buildAccountDataFromListOfEvents(this, params.events); }
    this.createIdIfMissing();
  }

  createIdIfMissing () {
    if (this.id == null) { this.id = cuid(); }
  }

  /**
   * Get only readable account information
   */
  getReadableAccount () {
    return pick(this, this.readableAccountFields.filter((x) => x !== 'dbDocuments' && x !== 'attachedFiles'));
  }

  /**
   * Get full account information
   */
  getFullAccount () {
    return pick(this, this.accountFields.filter((x) => x !== 'dbDocuments' && x !== 'attachedFiles'));
  }

  /**
   * Get fields provided by account methods
   */
  getLegacyAccount () {
    return pick(this, ['username', 'email', 'language', 'storageUsed']);
  }

  /**
   * Get account with id property added to it
   */
  getAccountWithId () {
    const res = pick(this, this.accountFields
      .concat('id')
      .filter((x: string) => x !== 'dbDocuments' && x !== 'attachedFiles'));
    res.username = this.username;
    return res;
  }
}
function buildAccountFields (user: User) {
  const accountMap = accountStreams.accountMap;
  user.accountFieldsWithPrefix = [];
  user.uniqueAccountFields = [];
  user.readableAccountFields = [];
  user.accountFields = [];
  for (const [streamId, stream] of Object.entries(accountMap) as Array<[string, SystemStream]>) {
    user.accountFieldsWithPrefix.push(streamId);
    const withoutPrefix = accountStreams.toFieldName(streamId);
    if (stream.isUnique === true) user.uniqueAccountFields.push(withoutPrefix);
    if (stream.isShown === true) user.readableAccountFields.push(withoutPrefix);
    user.accountFields.push(withoutPrefix);
  }
}
function loadAccountData (user: User, params: UserParams) {
  user.accountFields.forEach((field: string) => {
    if (field === 'dbDocuments' || field === 'attachedFiles') {
      // These are computed by Size.js, not stored as account fields
    } else {
      if (params[field] != null) { user[field] = params[field]; }
    }
  });
  if (params.password) {
    user.password = params.password;
  }
  if (params.id) {
    user.id = params.id;
  }
}
/**
 * Assign events data to user account fields
 */
function buildAccountDataFromListOfEvents (user: User, events: Event[]) {
  const account = buildAccountRecursive(accountStreams.accountChildren, events, {});
  Object.keys(account).forEach((param) => {
    user[param] = account[param];
  });
  return events;
}
/**
 * Takes the list of the streams, events list
 * and object where events will be saved in a tree structure
 * @param object streams
 * @param array events
 * @param object user
 */
function buildAccountRecursive (streams: SystemStream[], events: Event[], user: Record<string, unknown>): Record<string, unknown> {
  let streamIndex;
  for (streamIndex = 0; streamIndex < streams.length; streamIndex++) {
    const currentStream = streams[streamIndex];
    const streamIdWithPrefix = currentStream.id;
    const streamIdWithoutPrefix = accountStreams.toFieldName(streamIdWithPrefix);
    // if stream has children recursivelly call the same function
    if (Array.isArray(currentStream.children) &&
            currentStream.children.length > 0) {
      user[streamIdWithoutPrefix] = {};
      user[streamIdWithoutPrefix] = buildAccountRecursive(currentStream.children, events, user[streamIdWithoutPrefix] as Record<string, unknown>);
    }
    // get value for the stream element
    for (let i = 0; i < events.length; i++) {
      if (events[i].streamIds.includes(streamIdWithPrefix)) {
        user[streamIdWithoutPrefix] = events[i].content;
        break;
      }
    }
  }
  return user;
}
export default User;
export { User };