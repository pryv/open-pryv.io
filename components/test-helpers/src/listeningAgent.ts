/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */

import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);

const supertest = require('supertest');

/**
 * A supertest agent bound to ONE listening server per express app.
 *
 * Handed a bare express app, supertest calls `app.listen(0)` with no host for
 * every request (Node binds `::`) but sends the request to `127.0.0.1:<port>`.
 * On macOS (BSD SO_REUSEADDR semantics) a socket another process binds to
 * `127.0.0.1` on that same port coexists with the `::` listener and wins the
 * connection, so the request is answered by a foreign server: spurious 404s,
 * `socket hang up`, "Parse Error", in full runs next to other test servers,
 * while each suite passes in isolation. Linux refuses that second bind.
 *
 * This agent binds `127.0.0.1` explicitly, once per app instance, and reuses
 * the listening server: a specific long-lived bind can neither be shadowed nor
 * recycled. Servers are cached per app, so a suite that builds its own
 * application gets its own server and never talks to another suite's app.
 */

type ExpressApp = {
  listen: (port: number, host: string) => NodeServer;
};
type NodeServer = {
  once: (event: string, handler: (err?: Error) => void) => unknown;
  unref: () => unknown;
  address: () => unknown;
};

const servers = new WeakMap<object, NodeServer>();

/**
 * Return a supertest agent for `app`, bound to a single listening server.
 * Safe to call repeatedly: the server is created once per app instance.
 */
export async function listeningAgent (app: ExpressApp): Promise<unknown> {
  let server = servers.get(app as unknown as object);
  if (server == null) {
    server = app.listen(0, '127.0.0.1');
    await new Promise<void>((resolve, reject) => {
      server!.once('listening', () => resolve());
      server!.once('error', (err?: Error) => reject(err));
    });
    // Keeping the process alive is the runner's business, not this socket's.
    server.unref();
    servers.set(app as unknown as object, server);
  }
  return supertest(server);
}

export default listeningAgent;
