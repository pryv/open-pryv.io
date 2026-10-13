/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);

const ds = require('@pryv/datastore');
const audit = require('audit').default;
const { localStorePrepareOptions, localStorePrepareQuery } = require('storage/src/localStoreEventQueries.ts');

// Every audit record carries an `action-…` stream id, so the `actions` parent
// holds the whole log. Not `accesses`: some records have no access (MFA, SSO,
// OAuth2 rows without an access id), so that parent stays an exact match.
const WHOLE_LOG_PARENTS = ['actions'];

type StreamItem = { any?: string[], not?: string[] } | string;

/**
 * A query naming the `actions` parent reaches the store with the parent plus
 * every child term (the expansion lists them all): turn that `any` into
 * `['*']`, so the store reads by time instead of matching hundreds of terms on
 * every row of a log that can hold millions. An account export names
 * `accesses` and `actions` together, in one `any`, so it takes this path. The
 * parent is only there when the access may read it (`events.get` refuses a
 * stream it cannot read), and `not` items (children it may not read) are kept,
 * so the rows returned are the same.
 */
function wholeLogAsWildcard (streams: unknown): unknown {
  if (!Array.isArray(streams)) return streams;
  const isParent = (id: unknown) => typeof id === 'string' && WHOLE_LOG_PARENTS.includes(id);
  return streams.map((block: StreamItem[] | StreamItem) => {
    if (isParent(block)) return [{ any: ['*'] }];
    if (!Array.isArray(block)) return block;
    return block.map((item: StreamItem) => {
      if (isParent(item)) return { any: ['*'] };
      if (item != null && typeof item === 'object' && Array.isArray(item.any) && item.any.some(isParent)) {
        return { any: ['*'] };
      }
      return item;
    });
  });
}

const auditUserEvents: unknown = ds.createUserEvents({
  async getStreamed (userId: string, storeQuery: unknown, storeOptions: unknown) {
    const userDB = await audit.storage.forUser(userId);
    const sq = storeQuery as { streams?: unknown };
    if (sq != null && sq.streams != null) {
      storeQuery = Object.assign({}, sq, { streams: wholeLogAsWildcard(sq.streams) });
    }
    const query = localStorePrepareQuery(storeQuery);
    const options = localStorePrepareOptions(storeOptions);
    return userDB.getEventsStreamed({ query, options });
  }
});
export default auditUserEvents;
export { auditUserEvents, wholeLogAsWildcard };
