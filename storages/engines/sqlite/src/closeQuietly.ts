/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */

type WarnLogger = { warn: (message: string) => void };

/**
 * Close a cached database handle from an LRU `dispose`, logging a refusal
 * instead of throwing.
 *
 * lru-cache calls `dispose` before it removes the entry, so a throwing
 * `close()` (better-sqlite3 refuses while a statement iterator is open) made
 * `delete()` / `clear()` / an eviction throw and left the entry cached: the
 * stale-handle reopen then failed instead of reopening. The entry must always
 * leave the cache; a handle that refused to close is dropped and logged.
 */
function closeQuietly (close: () => void, logger: WarnLogger, what: string): void {
  try {
    close();
  } catch (err: unknown) {
    logger.warn(`could not close ${what}, dropped from the cache: ${(err as Error)?.message ?? err}`);
  }
}

export { closeQuietly };
