/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);

/**
 * Turn the environment master handed this worker into an initialized
 * emitter.
 *
 * Master resolves the effective observability config once (PlatformDB +
 * local YAML, with local `enabled: false` always winning) and passes the
 * result to every fork through `buildObservabilityEnv`. Workers therefore
 * agree on the posture without each one querying PlatformDB at boot.
 *
 * Unlike the agent this replaces, nothing here has to run before other
 * requires: no library is being patched, so startup happens where the
 * information lives — after the API method registry is complete, since
 * those ids are the emitter's method vocabulary.
 */

const observability = require('./index.ts');
const { endpointRefusal } = require('./endpointPolicy.ts');

const ENV = {
  ENABLED: 'PRYV_OBS_ENABLED',
  ENDPOINT: 'PRYV_OBS_ENDPOINT',
  HEADERS: 'PRYV_OBS_HEADERS',
  SERVICE_NAME: 'PRYV_OBS_SERVICE_NAME',
  INSTANCE_ID: 'PRYV_OBS_INSTANCE_ID',
  FLUSH_SECONDS: 'PRYV_OBS_FLUSH_SECONDS'
} as const;

interface StartupOptions {
  methodIds: Iterable<string>;
  serviceVersion: string;
  logger?: { warn: (msg: string) => void, info?: (msg: string) => void };
  env?: NodeJS.ProcessEnv;
}

type StartupResult = { activated: boolean, reason?: string };

/**
 * @returns whether the emitter was attached, and why not when it wasn't.
 */
function startFromEnv (options: StartupOptions): StartupResult {
  const env = options.env || process.env;
  // Tests never emit unless they initialize the façade themselves.
  if (env.NODE_ENV === 'test') return { activated: false, reason: 'NODE_ENV=test' };
  if (env[ENV.ENABLED] !== 'true') return { activated: false, reason: 'not enabled' };
  const endpoint = env[ENV.ENDPOINT];
  if (!endpoint) return { activated: false, reason: 'no endpoint configured' };

  // The transport rule belongs to the emitter, not to the tool that happens
  // to write the value: PlatformDB and the environment are both reachable
  // without the CLI. Failing closed here means a misconfigured destination
  // costs telemetry, never an unencrypted payload on the wire.
  const refusal = endpointRefusal(endpoint);
  if (refusal != null) return { activated: false, reason: refusal };

  // An empty vocabulary would attach an emitter that refuses every
  // datapoint as an unknown method id: telemetry that looks configured
  // and reports nothing. Refusing here turns that into one legible line
  // instead of a silent inert deployment, which is how the previous
  // generation of this layer went unnoticed for weeks.
  const methodIds = Array.from(options.methodIds);
  if (methodIds.length === 0) {
    return {
      activated: false,
      reason: 'no API methods registered yet — start observability after the method registry is populated'
    };
  }

  let headers: Record<string, string> = {};
  if (env[ENV.HEADERS]) {
    try {
      headers = JSON.parse(env[ENV.HEADERS] as string);
    } catch {
      return { activated: false, reason: 'headers are not valid JSON' };
    }
  }

  try {
    observability.init({
      endpoint,
      headers,
      serviceName: env[ENV.SERVICE_NAME] || 'open-pryv.io',
      serviceVersion: options.serviceVersion,
      instanceId: env[ENV.INSTANCE_ID] || '',
      worker: workerId(),
      methodIds,
      // Operator-set reporting interval; the emitter clamps it. Absent
      // means the emitter's privacy-biased default.
      flushIntervalMs: flushIntervalMs(env[ENV.FLUSH_SECONDS]),
      logger: options.logger
    });
  } catch (err) {
    return { activated: false, reason: (err as Error).message };
  }
  return { activated: true };
}

/**
 * Which process this is, so concurrent workers do not publish colliding
 * series. `cluster.worker.id` in a fork, 'master' otherwise. Infrastructure
 * identity only.
 */
function flushIntervalMs (seconds: string | undefined): number | undefined {
  if (!seconds) return undefined;
  const parsed = Number(seconds);
  return Number.isFinite(parsed) ? parsed * 1000 : undefined;
}

function workerId (): string {
  const cluster = require('cluster');
  return (cluster.worker != null && cluster.worker.id != null) ? String(cluster.worker.id) : 'master';
}

export { startFromEnv, workerId, ENV };
export type { StartupOptions, StartupResult };
