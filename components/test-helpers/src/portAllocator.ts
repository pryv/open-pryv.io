/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);

/**
 * Port allocation utility for test servers
 * Enables parallel test execution by dynamically allocating free ports
 */

const net = require('net');

// Lazy logger - only initialize when boiler is ready
let logger: any = null;
function getLog () {
  if (!logger) {
    try {
      const { getLogger } = require('@pryv/boiler');
      logger = getLogger('port-allocator');
    } catch (e) {
      // Boiler not initialized yet, use console
      logger = { debug: () => {} };
    }
  }
  return logger;
}

// Base port for dynamic allocation
// Use random starting point to avoid conflicts between parallel test processes.
// Range: 10000-49151, below the IANA / macOS ephemeral range (49152-65535),
// where the OS places `listen(0)` servers and outgoing client sockets.
const BASE_PORT_MIN = 10000;
const BASE_PORT_MAX = 49151;
let nextPort = BASE_PORT_MIN + Math.floor(Math.random() * (BASE_PORT_MAX - BASE_PORT_MIN));

// Test servers bind this address (DynamicInstanceManager's `http.ip` default,
// TestServerContext children). The probe must bind the same one: on macOS a
// probe on 0.0.0.0 succeeds over a port another process holds on 127.0.0.1,
// and the server then fails with EADDRINUSE.
const DEFAULT_HOST = '127.0.0.1';

/**
 * Allocates a free port for testing
 * @param host - The address the server will bind
 */
async function allocatePort (host: string = DEFAULT_HOST) {
  // Keep trying until we find a free port, wrapping around the range once.
  for (let tried = 0; tried <= BASE_PORT_MAX - BASE_PORT_MIN; tried++) {
    if (nextPort > BASE_PORT_MAX) nextPort = BASE_PORT_MIN;
    const port = nextPort++;

    if (await isPortAvailable(port, host)) {
      getLog().debug(`Allocated port ${port}`);
      return port;
    }

    getLog().debug(`Port ${port} unavailable, trying next`);
  }
  throw new Error('Port allocator: exhausted port range');
}

/**
 * Checks if a port is available by attempting to bind to it
 * @param port - The port to check
 * @param host - The address the server will bind
 */
function isPortAvailable (port: any, host: string = DEFAULT_HOST) {
  return new Promise((resolve) => {
    const server = net.createServer();

    server.on('error', () => {
      server.close();
      resolve(false);
    });

    // Resolve only once the probe socket is closed, so the caller's own
    // bind does not race the probe's release of the port.
    server.listen(port, host, () => {
      server.close(() => resolve(true));
    });
  });
}

/**
 * Allocates multiple ports at once
 * @param count - Number of ports to allocate
 */
async function allocatePorts (count: any) {
  const ports: number[] = [];
  for (let i = 0; i < count; i++) {
    ports.push(await allocatePort());
  }
  return ports;
}

/**
 * Resets the port allocator (useful for test setup)
 * @param basePort - Starting port number (defaults to random in range)
 */
function reset (basePort: any) {
  nextPort = basePort || (BASE_PORT_MIN + Math.floor(Math.random() * (BASE_PORT_MAX - BASE_PORT_MIN)));
}

export { allocatePort, allocatePorts, isPortAvailable, reset };
