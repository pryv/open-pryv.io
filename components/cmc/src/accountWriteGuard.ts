/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */
import type { CmcLogger } from './_types.ts';

/**
 * CMC plugin: no write for an account that is gone.
 *
 * The plugin's background work outlives the request that started it: the
 * dispatch of a trigger after its 201 (an accept reads the requester's offer
 * for up to 15 s), the retry loop, the member sweep, the post-hooks of
 * accesses.update and accesses.delete. The account can be erased meanwhile,
 * and the erasure neither waits for that work nor cancels it. A write landing
 * after the erasure removed the account's data would then create rows for an
 * account that no longer exists (on PostgreSQL a plain insert keyed by the
 * user id; on SQLite a new database in a directory the erasure kept), which
 * nothing reads or removes afterwards. The retry record such a write makes
 * holds the trigger's content, the requester's capability URL with its token
 * included.
 *
 * `guardAccountWrites` wraps a mall so that each create or update first asks
 * `accountActive(userId)` (the host answers false once the account is gone or
 * its erasure has started). When it is not active the write is dropped: an
 * info line names the operation and the record, never its content, and the
 * call rejects with an AccountGoneError, which the callers handle as any
 * failed write. Reads and deletes pass through unchanged.
 */

const ACCOUNT_GONE = 'cmc-account-gone';

/** The groups and methods of a mall that write. */
const WRITE_METHODS: Readonly<Record<string, ReadonlySet<string>>> = {
  events: new Set(['create', 'update', 'updateWithMerge']),
  streams: new Set(['create', 'update']),
  accesses: new Set(['create', 'update']),
};

class AccountGoneError extends Error {
  code = ACCOUNT_GONE;
  constructor (operation: string) {
    super('cmc: ' + operation + ' dropped, the account is erased');
    this.name = 'AccountGoneError';
  }
}

function isAccountGoneError (err: unknown): boolean {
  return (err as { code?: unknown } | null | undefined)?.code === ACCOUNT_GONE;
}

type AccountActive = (userId: string) => Promise<boolean> | boolean;

/** What names the record a write is about: its id, type and streams, never its content. */
function recordRef (method: string, target: unknown): Record<string, unknown> {
  if (method === 'updateWithMerge') return { id: target };
  const t = target as { id?: unknown; type?: unknown; streamIds?: unknown } | null | undefined;
  const ref: Record<string, unknown> = {};
  if (t?.id != null) ref.id = t.id;
  if (typeof t?.type === 'string') ref.type = t.type;
  if (Array.isArray(t?.streamIds)) ref.streamIds = t.streamIds;
  return ref;
}

function guardAccountWrites<M extends object> (mall: M, deps: { accountActive: AccountActive; logger?: CmcLogger }): M {
  const guardedGroups = new WeakMap<object, object>();

  function guardGroup (name: string, group: object): object {
    const known = guardedGroups.get(group);
    if (known != null) return known;
    const writes = WRITE_METHODS[name];
    const guarded = new Proxy(group, {
      get (target, prop) {
        const value = Reflect.get(target, prop, target);
        if (typeof value !== 'function') return value;
        // Bound to the group itself: the mall's groups are class instances
        // whose methods may use private fields.
        if (typeof prop !== 'string' || !writes.has(prop)) return value.bind(target);
        const operation = name + '.' + prop;
        return async function guardedWrite (userId: string, ...rest: unknown[]) {
          if (!(await deps.accountActive(userId))) {
            deps.logger?.info?.('cmc: write dropped, the account is erased or being erased', {
              userId, operation, ...recordRef(prop, rest[0]),
            });
            throw new AccountGoneError(operation);
          }
          return await value.call(target, userId, ...rest);
        };
      },
    });
    guardedGroups.set(group, guarded);
    return guarded;
  }

  return new Proxy(mall, {
    get (target, prop) {
      const value = Reflect.get(target, prop, target);
      if (typeof prop === 'string' && Object.hasOwn(WRITE_METHODS, prop) && value != null && typeof value === 'object') {
        return guardGroup(prop, value);
      }
      return value;
    },
  });
}

export { guardAccountWrites, isAccountGoneError, AccountGoneError, WRITE_METHODS };
export type { AccountActive };
