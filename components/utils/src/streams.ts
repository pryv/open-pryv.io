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
 */

import { createRequire } from 'node:module';
import type { Readable, Writable } from 'node:stream';
const require = createRequire(import.meta.url);

const { pipeline } = require('stream');

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
  // eslint-disable-next-line @typescript-eslint/no-empty-function
  pipeline(source, ...transforms, () => {});
  return transforms[transforms.length - 1] as T;
}
