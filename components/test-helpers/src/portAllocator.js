/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */

/**
 * Port allocation utility for test servers
 * Enables parallel test execution by dynamically allocating free ports
 */

const net = require('net');

// Lazy logger - only initialize when boiler is ready
let logger = null;
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

/**
 * Allocates a free port for testing
 * @returns {Promise<number>} A port number that can be bound to
 */
async function allocatePort () {
  // Keep trying until we find a free port
  while (true) {
    const port = nextPort++;

    // Safety limit
    if (port > 65000) {
      throw new Error('Port allocator: exhausted port range');
    }

    if (await isPortAvailable(port)) {
      getLog().debug(`Allocated port ${port}`);
      return port;
    }

    getLog().debug(`Port ${port} unavailable, trying next`);
  }
}

/**
 * Checks if a port is available by attempting to bind to it
 * @param {number} port - The port to check
 * @returns {Promise<boolean>} True if the port is available
 */
function isPortAvailable (port) {
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
 * @param {number} count - Number of ports to allocate
 * @returns {Promise<number[]>} Array of allocated port numbers
 */
async function allocatePorts (count) {
  const ports = [];
  for (let i = 0; i < count; i++) {
    ports.push(await allocatePort());
  }
  return ports;
}

/**
 * Resets the port allocator (useful for test setup)
 * @param {number} basePort - Starting port number (defaults to random in range)
 */
function reset (basePort) {
  nextPort = basePort || (BASE_PORT_MIN + Math.floor(Math.random() * (BASE_PORT_MAX - BASE_PORT_MIN)));
}

module.exports = {
  allocatePort,
  allocatePorts,
  isPortAvailable,
  reset
};
