/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */

/**
 * Host capabilities registry for storage engine plugins.
 *
 * Plugins can declare `requiredInternals` in their manifest.json.
 * The host (service-core) registers capabilities here, and the pluginLoader
 * passes the requested subset to each engine's factory function.
 *
 * Available internals:
 * - userLocalDirectory: resolves per-user local filesystem paths
 * - accountStreams: account streams config cache (was SystemStreamsSerializer)
 * - storeKeyValueData: key-value store for plugin metadata
 */

const registry: any = {};

/**
 * Register a host capability that plugins can request.
 * @param name - Capability name (e.g. 'userLocalDirectory')
 * @param value - The capability (function, object, etc.)
 */
function register (name: any, value: any) {
  if (typeof name !== 'string' || !name) {
    throw new Error('Internal name must be a non-empty string');
  }
  registry[name] = value;
}

/**
 * Resolve the requested internals for a plugin.
 * @param requiredInternals - Names from manifest.requiredInternals
 * @param engineName - Engine name (for error messages)
 */
function resolve (requiredInternals: any, engineName: any) {
  const result: any = {};
  if (!requiredInternals) return result;

  for (const name of requiredInternals) {
    if (!(name in registry)) {
      throw new Error(`Engine "${engineName}" requires internal "${name}" which is not registered. Available: ${Object.keys(registry).join(', ') || '(none)'}`);
    }
    result[name] = registry[name];
  }
  return result;
}

/**
 * Get all registered internals (for debugging).
 */
function listRegistered () {
  return Object.keys(registry);
}

/**
 * Clear all registered internals (for testing).
 */
function clearAll () {
  for (const key of Object.keys(registry)) {
    delete registry[key];
  }
}

/**
 * Check if a given internal is registered.
 */
function isRegistered (name: any) {
  return name in registry;
}

export { register, resolve, listRegistered, isRegistered, clearAll };