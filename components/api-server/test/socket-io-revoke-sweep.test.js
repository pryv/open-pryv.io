/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);

/**
 * [SNRS] The periodic client-revoke socket sweep reaches live connections.
 *
 * A socket authenticates once at handshake and then dispatches messages
 * without re-auth, so nothing in the request path re-checks it. Two things
 * revalidate an open connection: a pubsub notification on an access change,
 * and a periodic timer that exists precisely for when that notification never
 * arrives (a broker loss, say). The timer calls the manager-level entry point.
 *
 * That entry point once did not exist: the method was implemented on the
 * per-namespace class only, so the timer threw `is not a function` on every
 * tick and the sweep never ran, silently, because the throw was caught and
 * logged at warn. These tests pin the manager-level shape and its fan-out, so
 * a rename cannot quietly restore a no-op timer.
 */

const assert = require('node:assert/strict');
const Manager = require('api-server/src/socket-io/Manager.ts').default;

/** A manager whose collaborators are never used by the sweep. */
function makeManager () {
  const logger = { warn () {}, info () {}, debug () {}, error () {} };
  return new Manager(logger, {}, {}, {}, null);
}

/** Stands in for a NamespaceContext, recording that it was swept. */
function fakeContext () {
  return {
    swept: 0,
    revalidateConnections () { this.swept++; }
  };
}

describe('[SNRS] client-revoke socket sweep', function () {
  it('[SNRS1] the manager exposes the entry point the periodic sweep calls', function () {
    const manager = makeManager();
    assert.equal(typeof manager.revalidateConnections, 'function',
      'socket-io/index.ts calls manager.revalidateConnections() on a timer; ' +
      'if it is not a function the sweep throws every tick and never runs');
  });

  it('[SNRS2] sweeping fans out over every open namespace', function () {
    const manager = makeManager();
    const a = fakeContext();
    const b = fakeContext();
    manager.contexts.set('alice', a);
    manager.contexts.set('bob', b);

    manager.revalidateConnections();

    assert.equal(a.swept, 1, "alice's namespace must be revalidated");
    assert.equal(b.swept, 1, "bob's namespace must be revalidated");

    // A second tick sweeps again: the backstop is periodic, not once-only.
    manager.revalidateConnections();
    assert.equal(a.swept, 2);
    assert.equal(b.swept, 2);
  });

  it('[SNRS3] sweeping with no open namespace is a no-op, not a throw', function () {
    const manager = makeManager();
    assert.doesNotThrow(() => manager.revalidateConnections());
  });
});
