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
 * Handed a bare express app, supertest binds a fresh ephemeral port for every
 * single request and tears it down again. Across a full suite that is
 * thousands of bind/close cycles, and the port churn is a real source of
 * cross-talk: a connection can reach a port that has just been recycled, so a
 * request occasionally receives a response belonging to another listener on
 * the machine, or a desynchronised one. The symptom is unrelated suites
 * failing at random under load (spurious 404s, socket "Parse Error", hook
 * timeouts) while each of them passes in isolation.
 *
 * Binding once and reusing the listening server removes the churn. Servers are
 * cached per app instance, so a suite that builds its own application gets its
 * own server and never talks to another suite's app by accident.
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
