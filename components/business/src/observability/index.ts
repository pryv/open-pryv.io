/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);

/**
 * Observability façade — the only telemetry entry point for the rest of
 * the codebase.
 *
 * Design in one paragraph: no third-party agent runs in this process and
 * nothing auto-instruments anything. Telemetry is CONSTRUCTED by our own
 * code from the closed vocabulary in `schema.ts` and shipped over
 * OTLP/HTTP to whichever backend the operator configured. What can leave
 * is therefore a property of two files that can be read end to end, not
 * of a vendor library's evolving defaults. Concretely, what leaves is:
 * per-method call counts, durations and error counts (identifiers from
 * our own API registry, status classes, error codes), plus stack traces
 * for server-side faults with all paths rewritten repository-relative.
 * URLs, headers, parameters, payloads, usernames and error messages have
 * no representation in the schema, so they cannot be emitted.
 *
 * Everything is a no-op until `init()` runs, and every call is
 * exception-safe: telemetry must never break a request.
 */

const emitter = require('./emitter.ts');
const schema = require('./schema.ts');
const { classify } = require('./errorRegistry.ts');
const { allErrorCodes } = require('./errorRegistry.ts');

interface ObservabilityInit {
  endpoint: string;
  headers: Record<string, string>;
  serviceName: string;
  serviceVersion: string;
  instanceId: string;
  worker: string;
  methodIds: Iterable<string>;
  flushIntervalMs?: number;
  send?: (url: string, body: unknown, headers: Record<string, string>) => Promise<void>;
  logger?: { warn: (msg: string) => void };
}

/**
 * Attach the emitter and register the vocabularies. Called once per
 * process, from the boot shim, when the operator has enabled
 * observability.
 */
function init (options: ObservabilityInit): void {
  schema.registerMethodIds(options.methodIds);
  schema.registerErrorCodes(allErrorCodes());
  emitter.init({
    endpoint: options.endpoint,
    headers: options.headers,
    serviceName: options.serviceName,
    serviceVersion: options.serviceVersion,
    instanceId: options.instanceId,
    worker: options.worker,
    flushIntervalMs: options.flushIntervalMs,
    send: options.send,
    logger: options.logger
  });
}

function isActive (): boolean {
  return emitter.isActive();
}

/**
 * Record one finished API call.
 *
 * @param methodId — the API method id (must be one registered at init).
 * @param durationMs — wall-clock duration.
 * @param err — the failure, when the call failed.
 */
function recordApiCall (methodId: string, durationMs: number, err?: unknown): void {
  if (!emitter.isActive()) return;
  try {
    if (err == null) {
      emitter.recordApiCall(methodId, '2xx', durationMs, null);
      return;
    }
    const { code, statusClass, reportable } = classify(err);
    emitter.recordApiCall(methodId, statusClass, durationMs, code);
    if (reportable) emitter.reportError(err, code, methodId);
  } catch { /* never let telemetry break a request */ }
}

/**
 * Report a server-side failure that did not arise from an API call (the
 * certificate renewer, registration forwarding, background work).
 */
function recordError (err: unknown, methodId?: string | null): void {
  if (!emitter.isActive()) return;
  try {
    const { code } = classify(err);
    emitter.reportError(err, code, methodId ?? null);
  } catch { /* idem */ }
}

/** Send whatever is buffered (used at shutdown and by tests). */
async function flush (): Promise<void> {
  try { await emitter.flush(); } catch { /* idem */ }
}

async function shutdown (): Promise<void> {
  try { await emitter.shutdown(); } catch { /* idem */ }
}

/** Test-only: reset all state. */
function _reset (): void {
  emitter._reset();
  schema._resetVocabularies();
}

export { init, isActive, recordApiCall, recordError, flush, shutdown, _reset };
export type { ObservabilityInit };
