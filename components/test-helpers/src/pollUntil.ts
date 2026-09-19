/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */

/**
 * Re-run `read` until `until(value)` holds, then return that value. When the
 * deadline passes, return the last value read so the caller's own assertions
 * fail with a meaningful message instead of a bare timeout.
 *
 * For side effects the server writes AFTER it has answered: the audit record
 * (written once the response is sent) and the access usage counters (updated
 * after the method chain has moved on). A test that reads them back right
 * after the call races that write; a slow CI runner loses the race.
 *
 * - The default deadline (1500 ms) stays under mocha's 2000 ms base timeout,
 *   so a missing value reaches the caller's assertion, not a test timeout.
 * - A `read` that throws rejects at once; it is not retried.
 * - Only for positive expectations. An absence ("no row was written") cannot
 *   be waited for this way.
 */
async function pollUntil<T> (
  read: () => Promise<T>,
  until: (value: T) => boolean,
  { timeoutMs = 1500, intervalMs = 50 }: { timeoutMs?: number; intervalMs?: number } = {}
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  let value = await read();
  while (!until(value) && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
    value = await read();
  }
  return value;
}

export { pollUntil };
