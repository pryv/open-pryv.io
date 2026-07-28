/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);

/**
 * The telemetry choke point.
 *
 * Every piece of telemetry this deployment emits is built here, from the
 * closed vocabulary in `schema.ts`, and nothing else observes the process.
 * That is the whole design: rather than filtering what a third-party agent
 * collected, we construct what leaves, so the emitted surface is the
 * schema, and auditing it means reading two files.
 *
 * Invariants worth preserving:
 *   - Validation failures DROP the datapoint and increment
 *     `telemetry.dropped` with a reason. They never throw, and they never
 *     forward "just this once".
 *   - Nothing here may block, slow or break a request. Aggregation is
 *     in-memory and O(1); sending happens on a timer, off the request
 *     path; a failing backend costs a counter, not a request.
 *   - Buffers are bounded. Under backpressure we drop and count.
 */

const {
  validateMetric, validateErrorAttributes, validateResource,
  METRICS, DROP_REASONS, knownErrorCodes
} = require('./schema.ts');
const { sanitizeError } = require('./sanitizeError.ts');
const { messageFor } = require('./errorRegistry.ts');
const {
  buildMetricsPayload, buildLogsPayload, emptyBuckets, bucketIndex
} = require('./otlp.ts');

type Attributes = Record<string, string>;

interface EmitterConfig {
  endpoint: string;
  headers: Record<string, string>;
  serviceName: string;
  serviceVersion: string;
  instanceId: string;
  worker: string;
  flushIntervalMs?: number;
  /** Optional sink; defaults to global fetch. Tests inject their own. */
  send?: (url: string, body: unknown, headers: Record<string, string>) => Promise<void>;
  /** Optional logger with warn(). */
  logger?: { warn: (msg: string) => void };
}

/** Bounded to keep a backend outage from growing memory without limit. */
const MAX_ERROR_RECORDS = 200;
const MAX_SERIES = 2000;
/**
 * The reporting interval is a PRIVACY control, not a tuning knob: it is
 * the granularity at which activity is observable, and the only lever on
 * the residual correlation risk at low traffic. Five minutes by default,
 * biased towards privacy over alerting latency; operators may widen it.
 */
const DEFAULT_FLUSH_INTERVAL_MS = 300000;
const MIN_FLUSH_INTERVAL_MS = 60000;
const MAX_FLUSH_INTERVAL_MS = 3600000;

/** Clamp so a misconfiguration cannot make activity finely observable. */
function clampInterval (requested: number | undefined): number {
  if (requested == null || !Number.isFinite(requested)) return DEFAULT_FLUSH_INTERVAL_MS;
  return Math.min(MAX_FLUSH_INTERVAL_MS, Math.max(MIN_FLUSH_INTERVAL_MS, requested));
}

let config: EmitterConfig | null = null;
let flushTimer: NodeJS.Timeout | null = null;
let intervalStartMs = 0;

/** counters: metric name → series key → { attributes, value } */
const counters: Map<string, Map<string, { attributes: Attributes, value: number }>> = new Map();
/** histograms: metric name → series key → point */
const histograms: Map<string, Map<string, {
  attributes: Attributes, count: number, sum: number, bucketCounts: number[]
}>> = new Map();
/**
 * Error reports, AGGREGATED by fault rather than kept per occurrence.
 *
 * Each distinct (code, class, method, stack) becomes one record with a
 * count, emitted at the flush boundary. This is a privacy control, not a
 * volume optimisation: a per-occurrence record carries a precise
 * timestamp, and "this method failed at 14:32:07.123 on this core" singles
 * out one person's one action to anyone holding a second timestamped
 * signal, the operator's own audit log included. Aggregating to the
 * interval removes the instant, and with it the correlation handle. The
 * cost, accepted deliberately, is that sub-interval ordering and exact
 * error times are no longer available from telemetry; they remain in the
 * operator's local logs.
 */
const errorGroups: Map<string, {
  code: string, message: string, attributes: Attributes, frames: string[], count: number
}> = new Map();

function isActive (): boolean {
  return config !== null;
}

function seriesKey (attributes: Attributes): string {
  return Object.keys(attributes).sort().map(function (k) { return k + '=' + attributes[k]; }).join('|');
}

function nowMs (): number {
  return Date.now();
}

/**
 * Count a drop. Deliberately bypasses validateMetric (the reason values are
 * the schema's own constants) and is itself bounded, so a storm of drops
 * cannot recurse or grow.
 *
 * `detail` names the offending value and is written to the LOCAL log only,
 * never to a payload. Without it, a misconfigured deployment reports a
 * rising `telemetry.dropped` with no way to find out what is being
 * refused — which is how the emitter's first deployment spent a cycle
 * being diagnosed from the outside. Local logs already contain
 * identifiers; this adds no exposure.
 */
function countDrop (reason: string, detail?: string): void {
  addToCounter(METRICS.DROPPED, { reason }, 1);
  if (detail != null && config?.logger != null) {
    config.logger.warn('observability: refused a datapoint (' + reason + '): ' + detail);
  }
}

function addToCounter (name: string, attributes: Attributes, delta: number): void {
  let series = counters.get(name);
  if (series == null) {
    series = new Map();
    counters.set(name, series);
  }
  const key = seriesKey(attributes);
  const existing = series.get(key);
  if (existing != null) {
    existing.value += delta;
    return;
  }
  if (series.size >= MAX_SERIES) return; // bounded; the drop counter itself is capped
  series.set(key, { attributes, value: delta });
}

function addToHistogram (name: string, attributes: Attributes, valueMs: number): void {
  let series = histograms.get(name);
  if (series == null) {
    series = new Map();
    histograms.set(name, series);
  }
  const key = seriesKey(attributes);
  let point = series.get(key);
  if (point == null) {
    if (series.size >= MAX_SERIES) return;
    point = { attributes, count: 0, sum: 0, bucketCounts: emptyBuckets() };
    series.set(key, point);
  }
  point.count += 1;
  point.sum += valueMs;
  point.bucketCounts[bucketIndex(valueMs)] += 1;
}

/**
 * Record one completed API call: a call counter, a duration observation,
 * and (when it failed) an error counter.
 *
 * @param methodId — a registered API method id.
 * @param statusClass — '2xx' | '3xx' | '4xx' | '5xx'.
 * @param durationMs — wall-clock duration of the call.
 * @param errorCode — registry code when the call failed.
 */
function recordApiCall (
  methodId: string, statusClass: string, durationMs: number, errorCode?: string | null
): void {
  if (config == null) return;
  const attributes: Attributes = { 'method.id': methodId, 'status.class': statusClass };
  const check = validateMetric(METRICS.CALLS, attributes, 1);
  if (!check.ok) {
    countDrop(check.reason, 'method.id=' + methodId + ' status.class=' + statusClass);
    return;
  }
  addToCounter(METRICS.CALLS, attributes, 1);
  if (Number.isFinite(durationMs)) {
    addToHistogram(METRICS.DURATION, attributes, durationMs);
  }
  if (errorCode != null) {
    const errorAttributes: Attributes = { 'method.id': methodId, 'error.code': errorCode };
    const errorCheck = validateMetric(METRICS.ERRORS, errorAttributes, 1);
    if (!errorCheck.ok) {
      countDrop(errorCheck.reason);
      return;
    }
    addToCounter(METRICS.ERRORS, errorAttributes, 1);
  }
}

/**
 * Report one server-side failure: registry code, class name and sanitized
 * stack. Client-side (4xx) failures are counted by `recordApiCall` and do
 * not come through here.
 */
function reportError (err: unknown, code: string, methodId?: string | null): void {
  if (config == null) return;
  const { errorClass, frames } = sanitizeError(err);
  const stack = frames.join('\n');
  const attributes: Attributes = { 'error.code': code, 'error.class': errorClass };
  if (methodId != null) attributes['method.id'] = methodId;
  // The stack is validated with everything else: it is the one field
  // carrying free-form text, so it is exactly the field that must not be
  // trusted on the sanitizer's word alone.
  const check = validateErrorAttributes(Object.assign({ 'error.stack': stack }, attributes));
  if (!check.ok) {
    countDrop(check.reason);
    return;
  }
  const key = attributes['error.code'] + '|' + errorClass + '|' + (methodId ?? '') + '|' + stack;
  const existing = errorGroups.get(key);
  if (existing != null) {
    existing.count += 1;
    return;
  }
  if (errorGroups.size >= MAX_ERROR_RECORDS) {
    countDrop(DROP_REASONS.BUFFER_FULL);
    return;
  }
  // The message is resolved here, from the hard-coded catalogue keyed by
  // the already-validated code, so the serializer only ever encodes a
  // compile-time constant.
  errorGroups.set(key, { code, message: messageFor(code), attributes, frames, count: 1 });
}

function resourceAttributes (): Attributes {
  const cfg = config as EmitterConfig;
  return {
    'service.name': cfg.serviceName,
    'service.version': cfg.serviceVersion,
    'service.instance.id': cfg.instanceId,
    'service.worker': cfg.worker
  };
}

/** Take everything buffered and reset, so a slow send never double-counts. */
function drain () {
  const countersOut: Record<string, Array<{ attributes: Attributes, value: number }>> = {};
  for (const [name, series] of counters) countersOut[name] = Array.from(series.values());
  const histogramsOut: Record<string, Array<{
    attributes: Attributes, count: number, sum: number, bucketCounts: number[]
  }>> = {};
  for (const [name, series] of histograms) histogramsOut[name] = Array.from(series.values());
  // Validate the count here, with the rest of the record's fields: it is
  // appended by the serializer, so without this it would be the one emitted
  // field the schema never saw. A group whose count is out of range is
  // dropped rather than sent with an unchecked value.
  const errorsOut = Array.from(errorGroups.values()).filter(function (group) {
    const check = validateErrorAttributes({ 'error.count': String(group.count) });
    if (!check.ok) countDrop(check.reason, 'error.count=' + group.count);
    return check.ok;
  });
  counters.clear();
  histograms.clear();
  errorGroups.clear();
  return { countersOut, histogramsOut, errorsOut };
}

async function defaultSend (url: string, body: unknown, headers: Record<string, string>): Promise<void> {
  const response = await fetch(url, {
    method: 'POST',
    headers: Object.assign({ 'content-type': 'application/json' }, headers),
    body: JSON.stringify(body)
  });
  if (!response.ok) {
    throw new Error('OTLP endpoint returned ' + response.status);
  }
}

function joinUrl (base: string, path: string): string {
  return base.replace(/\/+$/, '') + path;
}

/**
 * Send whatever is buffered. Never throws: a send failure is counted (in
 * the NEXT interval, since the current one has already been drained) and
 * logged at warn.
 */
async function flush (): Promise<void> {
  if (config == null) return;
  const cfg = config;
  const endMs = nowMs();
  const startMs = intervalStartMs;
  intervalStartMs = endMs;
  const { countersOut, histogramsOut, errorsOut } = drain();
  const resource = resourceAttributes();
  // Resource identity is validated like everything else: the service name
  // is the one operator-supplied string in the payload. A resource that
  // fails validation means the whole batch is unsafe to send.
  const resourceCheck = validateResource(resource);
  if (!resourceCheck.ok) {
    countDrop(DROP_REASONS.INVALID_RESOURCE);
    if (cfg.logger) cfg.logger.warn('observability: resource attributes rejected, batch dropped');
    return;
  }
  const send = cfg.send || defaultSend;

  const metricsPayload = buildMetricsPayload({
    counters: countersOut,
    histograms: histogramsOut,
    startTimeMs: startMs,
    endTimeMs: endMs,
    resourceAttributes: resource
  });
  if (Object.keys(metricsPayload).length > 0) {
    try {
      await send(joinUrl(cfg.endpoint, '/v1/metrics'), metricsPayload, cfg.headers);
    } catch (err) {
      countDrop(DROP_REASONS.SEND_FAILED);
      if (cfg.logger) cfg.logger.warn('observability: metrics send failed: ' + (err as Error).message);
    }
  }

  // Timestamped at the interval boundary, not at occurrence: see the
  // errorGroups note above.
  const logsPayload = buildLogsPayload({
    errors: errorsOut, intervalEndMs: endMs, resourceAttributes: resource
  });
  if (Object.keys(logsPayload).length > 0) {
    try {
      await send(joinUrl(cfg.endpoint, '/v1/logs'), logsPayload, cfg.headers);
    } catch (err) {
      countDrop(DROP_REASONS.SEND_FAILED);
      if (cfg.logger) cfg.logger.warn('observability: error-report send failed: ' + (err as Error).message);
    }
  }
}

/**
 * Attach the emitter. Until this runs, every record call is a no-op, which
 * is what keeps observability free when it is disabled.
 */
function init (cfg: EmitterConfig): void {
  if (config != null) throw new Error('observability emitter: already initialized');
  config = cfg;
  intervalStartMs = nowMs();
  const interval = clampInterval(cfg.flushIntervalMs);
  flushTimer = setInterval(function () {
    flush().catch(function () { /* flush never throws; belt and braces */ });
  }, interval);
  // Telemetry must not hold the process open at shutdown.
  if (typeof flushTimer.unref === 'function') flushTimer.unref();
}

/** Stop the timer and send whatever is left. */
async function shutdown (): Promise<void> {
  if (flushTimer != null) {
    clearInterval(flushTimer);
    flushTimer = null;
  }
  if (config == null) return;
  await flush();
  config = null;
}

/** Test-only: drop all state without sending. */
function _reset (): void {
  if (flushTimer != null) {
    clearInterval(flushTimer);
    flushTimer = null;
  }
  config = null;
  counters.clear();
  histograms.clear();
  errorGroups.clear();
  intervalStartMs = 0;
}

/** Test-only: inspect what is buffered. */
function _buffered () {
  const countersOut: Record<string, Array<{ attributes: Attributes, value: number }>> = {};
  for (const [name, series] of counters) countersOut[name] = Array.from(series.values());
  const histogramsOut: Record<string, Array<{ attributes: Attributes, count: number, sum: number }>> = {};
  for (const [name, series] of histograms) histogramsOut[name] = Array.from(series.values());
  return { counters: countersOut, histograms: histogramsOut, errors: Array.from(errorGroups.values()) };
}

export {
  init, isActive, recordApiCall, reportError, flush, shutdown, knownErrorCodes,
  clampInterval, DEFAULT_FLUSH_INTERVAL_MS, MIN_FLUSH_INTERVAL_MS, MAX_FLUSH_INTERVAL_MS,
  _reset, _buffered
};
export type { EmitterConfig };
