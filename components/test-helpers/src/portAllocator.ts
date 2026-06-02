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
// Use random starting point to avoid conflicts between parallel test processes
// Range: 10000-50000 (avoiding well-known ports and ephemeral port range)
const BASE_PORT_MIN = 10000;
const BASE_PORT_MAX = 50000;
let nextPort = BASE_PORT_MIN + Math.floor(Math.random() * (BASE_PORT_MAX - BASE_PORT_MIN));

const allocatedPorts = new Set<number>();
const freedPorts: number[] = [];

/**
 * Allocates a free port for testing.
 * Reuses freed ports (FIFO) before falling back to monotonic allocation.
 */
async function allocatePort () {
  // First try freed-pool: a previously-released port that the OS has
  // since released too. Skip any that are still bound by a slow consumer.
  while (freedPorts.length > 0) {
    const port = freedPorts.shift() as number;
    if (await isPortAvailable(port)) {
      allocatedPorts.add(port);
      getLog().debug(`Reallocated freed port ${port}`);
      return port;
    }
    getLog().debug(`Freed port ${port} still bound, skipping`);
  }
  // Fall through to monotonic allocation.
  while (true) {
    const port = nextPort++;

    // Safety limit
    if (port > 65000) {
      throw new Error('Port allocator: exhausted port range');
    }

    if (await isPortAvailable(port)) {
      allocatedPorts.add(port);
      getLog().debug(`Allocated port ${port}`);
      return port;
    }

    getLog().debug(`Port ${port} unavailable, trying next`);
  }
}

/**
 * Returns a port to the pool. Safe to call with a port that was never
 * allocated (no-op). Idempotent on repeat releases.
 */
function releasePort (port: number) {
  if (allocatedPorts.delete(port)) {
    freedPorts.push(port);
    getLog().debug(`Released port ${port}`);
  }
}

/**
 * Checks if a port is available by attempting to bind to it
 * @param port - The port to check
 */
function isPortAvailable (port: any) {
  return new Promise((resolve) => {
    const server = net.createServer();

    server.on('error', () => {
      server.close();
      resolve(false);
    });

    server.listen(port, '0.0.0.0', () => {
      server.close();
      resolve(true);
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
  allocatedPorts.clear();
  freedPorts.length = 0;
}

export { allocatePort, allocatePorts, releasePort, isPortAvailable, reset };
