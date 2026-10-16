/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */
import { createAddressBudget } from './addressBudget.ts';

/**
 * Per-address budget of `POST /access/invitationtoken/check`.
 *
 * The check takes no credentials and answers whether a token is valid, so
 * without a budget it lets a caller try tokens at request rate. Each address
 * bucket may run CHECKS_PER_WINDOW checks in a window opened by its first;
 * past it the check is refused with 429 until the window ends (see
 * addressBudget.ts for the counting).
 */

const CHECKS_PER_WINDOW = 10;
const WINDOW_MS = 60 * 1000;

const budget = createAddressBudget({ namespace: 'invitation-check-ip/', perWindow: CHECKS_PER_WINDOW, windowMs: WINDOW_MS });

/**
 * Count one check from `ip`. Answers null when it may run, else the seconds
 * until the address's window ends. An empty `ip` (no address known) is not
 * counted.
 */
async function reserveInvitationCheck (ip: string | null | undefined): Promise<number | null> {
  return await budget.reserve(ip);
}

/** Drop the counters written by this process (tests). */
async function clear (): Promise<void> {
  await budget.clear();
}

export { reserveInvitationCheck, clear, CHECKS_PER_WINDOW, WINDOW_MS };
