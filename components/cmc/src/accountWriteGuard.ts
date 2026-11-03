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
 * `accountStatus(userId)`:
 *   - 'active': the write goes through;
 *   - 'gone' (the account no longer exists): the write is dropped, logged at
 *     info;
 *   - 'erasing' (the account still exists but its erasure has started): the
 *     write is dropped, logged at warn at most once per account and
 *     WARN_INTERVAL_MS in this process (info otherwise). Outside the few
 *     seconds an erasure takes, this state is an erasure that stopped half
 *     way, which an operator has to complete; until then the account's CMC
 *     background work writes nothing.
 * A dropped write rejects with an AccountGoneError, which the callers handle
 * as any failed write. The log line names the operation and the record (its
 * id and type, never its content nor its streams, whose ids can name the
 * counterparty); the user id is the only identifier it keeps, on purpose.
 * Reads and deletes pass through unchanged.
 */

const ACCOUNT_GONE = 'cmc-account-gone';
const WARN_INTERVAL_MS = 10 * 60 * 1000;
const WARNED_MAX = 1000;

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

type AccountStatus = 'active' | 'gone' | 'erasing';
type AccountStatusFn = (userId: string) => Promise<AccountStatus> | AccountStatus;

/** What names the record a write is about: its id and type, never its content. */
function recordRef (method: string, target: unknown): Record<string, unknown> {
  if (method === 'updateWithMerge') return { id: target };
  const t = target as { id?: unknown; type?: unknown } | null | undefined;
  const ref: Record<string, unknown> = {};
  if (t?.id != null) ref.id = t.id;
  if (typeof t?.type === 'string') ref.type = t.type;
  return ref;
}

function guardAccountWrites<M extends object> (mall: M, deps: { accountStatus: AccountStatusFn; logger?: CmcLogger }): M {
  const guardedGroups = new WeakMap<object, object>();
  // Accounts whose half-done erasure was reported at warn, and when.
  const warned = new Map<string, number>();

  function logDrop (status: AccountStatus, fields: Record<string, unknown>): void {
    if (status === 'erasing') {
      const userId = fields.userId as string;
      const last = warned.get(userId);
      if (last == null || Date.now() - last > WARN_INTERVAL_MS) {
        warned.delete(userId);
        warned.set(userId, Date.now());
        if (warned.size > WARNED_MAX) warned.delete(warned.keys().next().value as string);
        deps.logger?.warn?.('cmc: write dropped, an erasure of this account has started and is not finished (complete it if it stopped)', fields);
        return;
      }
    }
    deps.logger?.info?.('cmc: write dropped, the account is erased or being erased', fields);
  }

  function guardGroup (name: string, group: object): object {
    const known = guardedGroups.get(group);
    if (known != null) return known;
    const writes = WRITE_METHODS[name];
    // One function per method, so a method read twice is the same value (a
    // method replaced on the group gets a new one).
    const methods = new Map<string, { value: unknown; fn: unknown }>();
    const guarded = new Proxy(group, {
      get (target, prop) {
        const value = Reflect.get(target, prop, target);
        if (typeof value !== 'function' || typeof prop !== 'string') return value;
        const known = methods.get(prop);
        if (known != null && known.value === value) return known.fn;
        let fn: unknown;
        if (!writes.has(prop)) {
          // Bound to the group itself: the mall's groups are class instances
          // whose methods may use private fields.
          fn = value.bind(target);
        } else {
          const operation = name + '.' + prop;
          fn = async function guardedWrite (userId: string, ...rest: unknown[]) {
            const status = await deps.accountStatus(userId);
            if (status !== 'active') {
              logDrop(status, { userId, operation, ...recordRef(prop, rest[0]) });
              throw new AccountGoneError(operation);
            }
            return await value.call(target, userId, ...rest);
          };
        }
        methods.set(prop, { value, fn });
        return fn;
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
export type { AccountStatus, AccountStatusFn };
