/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */
import type {} from 'node:fs';

/**
 * Build the `env` object master injects into every `cluster.fork({...})`
 * call, so workers start their emitter from the posture master resolved.
 *
 * Returns an empty object when observability is disabled or has no
 * endpoint — workers then see no observability env and stay silent.
 *
 * @param obs — output of `Platform.getObservabilityConfig()`.
 */

interface ObservabilityConfig {
  enabled: boolean;
  appName: string;
  hostname: string;
  otlp?: { endpoint?: string; headers?: Record<string, string>; flushIntervalSeconds?: number | null };
}

function buildObservabilityEnv (obs: ObservabilityConfig | null | undefined): Record<string, string> {
  if (!obs || !obs.enabled) return {};
  const endpoint = obs.otlp?.endpoint;
  if (!endpoint) return {};
  const env: Record<string, string> = {
    PRYV_OBS_ENABLED: 'true',
    PRYV_OBS_ENDPOINT: endpoint,
    PRYV_OBS_HEADERS: JSON.stringify(obs.otlp?.headers || {}),
    PRYV_OBS_SERVICE_NAME: obs.appName,
    PRYV_OBS_INSTANCE_ID: obs.hostname
  };
  const seconds = obs.otlp?.flushIntervalSeconds;
  if (seconds != null && Number.isFinite(seconds)) {
    env.PRYV_OBS_FLUSH_SECONDS = String(seconds);
  }
  return env;
}

export { buildObservabilityEnv };
export type { ObservabilityConfig };
