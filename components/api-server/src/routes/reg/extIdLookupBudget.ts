/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */
import { createAddressBudget } from './addressBudget.ts';

/**
 * Per-address budget of the external-id probes: `POST /reg/ext-id/cores`
 * (each lookup counts) and the claim refusals of `account.externalIds.claim` /
 * `.replace` (each 409 counts, a successful claim does not). Whoever holds a
 * namespace key can compute candidate values for a low-entropy id space; the
 * budget bounds how fast an address can test them.
 */

const PROBES_PER_WINDOW = 10;
const WINDOW_MS = 60 * 1000;

const extIdLookupBudget = createAddressBudget({ namespace: 'ext-id-probe-ip/', perWindow: PROBES_PER_WINDOW, windowMs: WINDOW_MS });

export { extIdLookupBudget, PROBES_PER_WINDOW, WINDOW_MS };
