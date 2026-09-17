/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */

/**
 * Stream plumbing for the response path.
 *
 * ⚑ Why this exists: `.pipe()` does NOT propagate `destroy` upstream. A source
 * that owns a scarce resource — a pooled database client held open by a
 * server-side cursor, a file descriptor — is wrapped in several Transforms
 * before it reaches the HTTP response. With `.pipe()`, the client going away
 * destroys the response and the outermost Transform, and every boundary below
 * swallows it: the source stays suspended, holding its resource, forever. A
 * handful of aborted requests is then enough to starve a connection pool.
 *
 * `stream.pipeline()` forwards destroy along the whole chain, so every wrap
 * site on that path must use it. Keeping the call in one helper is what makes
 * "no `.pipe()` on the response path" checkable.
 *
 * Exception: `api-server/src/middleware/attachment-access.ts` is a single hop
 * with no transform where a source error before the first byte must leave the
 * response usable for a status; it keeps `.pipe()` and propagates the
 * response's 'close' to the source by hand. Also `api-server/src/hfsIngress.ts`,
 * whose request hop keeps `.pipe()` for the same reason (an upstream failure
 * while the body is still arriving must still answer 502, and `pipeline()` would
 * destroy the client's socket with the request) and propagates the request's
 * 'close' by hand; its response hop uses `pipeline()`.
 */

import { pipeline } from 'node:stream';
import type { Readable, Writable } from 'node:stream';

type AnyStream = Readable | Writable;

/**
 * Wrap `source` in `transforms`, forwarding destroy in both directions, and
 * return the last transform so call sites read like the `.pipe()` chain they
 * replace.
 *
 * Errors are deliberately NOT handled here. Every chain built with this helper
 * ends up inside the outer `pipeline()` that writes the HTTP response, and that
 * one callback sees the same error; handling it here too would either swallow
 * it or report it twice. `pipeline` keeps an `'error'` listener attached to
 * every stream it manages, so nothing here can crash the process with an
 * unhandled `'error'` event.
 */
export function pipeThrough<T extends AnyStream> (source: Readable, ...transforms: [...AnyStream[], T]): T {
  if (transforms.length === 0) {
    throw new Error('pipeThrough needs at least one transform');
  }
  // The ARRAY form, not the variadic one: the variadic overloads are fixed-arity
  // tuples, so a spread of unknown length does not match any of them.
  // eslint-disable-next-line @typescript-eslint/no-empty-function
  pipeline([source, ...transforms] as [Readable, ...AnyStream[]], () => {});
  return transforms[transforms.length - 1] as T;
}
