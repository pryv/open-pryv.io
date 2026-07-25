/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */

/**
 * Multiple emails per account.
 *
 * The legacy singular account field `:_system:email` stays authoritative as
 * the PRIMARY email; this module adds a guarded local-store container stream
 * (`:_emails:`) holding one event per email, pending addresses included. See
 * constants.ts for why the `:_system:` prefix cannot host it.
 */

export * from './constants.ts';
export * from './guards.ts';
export * from './container.ts';
export * as operations from './operations.ts';
