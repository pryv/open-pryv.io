/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */

/**
 * Shared secrets — hand a secret to a third party by one-time key.
 *
 * The creator stores a secret payload and gets back a key; the third party
 * exchanges that key, exactly once, for the secret. The point is to stop
 * putting real secrets (access tokens and the like) in URL query parameters,
 * where they end up in browser history, referrers and server logs.
 *
 * Like CMC, this is a namespace-owning plugin rather than a storage engine:
 * items are ordinary events under `:_shared-secrets:<accessId>` in the local
 * store, reusing `duration` for the TTL and `trashed` for "no longer pending".
 */

export * from './constants.ts';
export * as key from './key.ts';
export * from './item.ts';
export * from './provisioning.ts';
export * from './guards.ts';
