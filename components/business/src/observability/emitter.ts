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

const { validateMetric, validateErrorAttributes, METRICS, DROP_REASONS, knownErrorCodes } = require('./schema.ts');
const { sanitizeError } = require('./sanitizeError.ts');
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
const DEFAULT_FLUSH_INTERVAL_MS = 60000;

let config: EmitterConfig | null = null;
let flushTimer: NodeJS.Timeout | null = null;
let intervalStartMs = 0;

/** counters: metric name → series key → { attributes, value } */
const counters: Map<string, Map<string, { attributes: Attributes, value: number }>> = new Map();
/** histograms: metric name → series key → point */
const histograms: Map<string, Map<string, {
  attributes: Attributes, count: number, sum: number, bucketCounts: number[]
}>> = new Map();
let errorRecords: Array<{ timeMs: number, code: string, attributes: Attributes, frames: string[] }> = [];

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
 */
function countDrop (reason: string): void {
  addToCounter(METRICS.DROPPED, { reason }, 1);
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
    countDrop(check.reason);
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
  const attributes: Attributes = { 'error.code': code, 'error.class': errorClass };
  if (methodId != null) attributes['method.id'] = methodId;
  const check = validateErrorAttributes(attributes);
  if (!check.ok) {
    countDrop(check.reason);
    return;
  }
  if (errorRecords.length >= MAX_ERROR_RECORDS) {
    countDrop(DROP_REASONS.BUFFER_FULL);
    return;
  }
  errorRecords.push({ timeMs: nowMs(), code, attributes, frames });
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
  const errorsOut = errorRecords;
  counters.clear();
  histograms.clear();
  errorRecords = [];
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

  const logsPayload = buildLogsPayload({ errors: errorsOut, resourceAttributes: resource });
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
  const interval = cfg.flushIntervalMs || DEFAULT_FLUSH_INTERVAL_MS;
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
  errorRecords = [];
  intervalStartMs = 0;
}

/** Test-only: inspect what is buffered. */
function _buffered () {
  const countersOut: Record<string, Array<{ attributes: Attributes, value: number }>> = {};
  for (const [name, series] of counters) countersOut[name] = Array.from(series.values());
  const histogramsOut: Record<string, Array<{ attributes: Attributes, count: number, sum: number }>> = {};
  for (const [name, series] of histograms) histogramsOut[name] = Array.from(series.values());
  return { counters: countersOut, histograms: histogramsOut, errors: errorRecords.slice() };
}

export {
  init, isActive, recordApiCall, reportError, flush, shutdown, knownErrorCodes,
  _reset, _buffered
};
export type { EmitterConfig };
