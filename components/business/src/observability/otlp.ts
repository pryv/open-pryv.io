/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */
import type {} from 'node:fs';

/**
 * OTLP/HTTP (JSON encoding) payload builders.
 *
 * Hand-rolled on purpose: no vendor SDK and no OpenTelemetry SDK is
 * installed, because an SDK is exactly the kind of dependency that
 * auto-instruments and widens the emitted surface without anyone
 * noticing. What ships here is a serializer for datapoints that the
 * emitter has already validated against the allow-list.
 *
 * OTLP is the wire format so the backend is a URL: New Relic ingests it
 * natively, as do Grafana, Datadog, Honeycomb, Elastic and a self-hosted
 * OpenTelemetry Collector. Backends without OTLP ingest are reached
 * through a Collector inside the operator's trust boundary.
 */

/** OTLP AggregationTemporality: 1 = DELTA (we always report deltas). */
const DELTA = 1;
/** OTLP SeverityNumber for ERROR. */
const SEVERITY_ERROR = 17;

/** Fixed histogram bounds in milliseconds. */
const DURATION_BOUNDS: readonly number[] = [5, 10, 25, 50, 100, 250, 500, 1000, 2500, 5000, 10000];

type Attributes = Record<string, string>;

function toKeyValues (attributes: Attributes): Array<Record<string, unknown>> {
  return Object.keys(attributes).map(function (key) {
    return { key, value: { stringValue: attributes[key] } };
  });
}

function toResource (resourceAttributes: Attributes): Record<string, unknown> {
  return { attributes: toKeyValues(resourceAttributes) };
}

const SCOPE = { name: 'open-pryv.io/observability' };

interface CounterPoint { attributes: Attributes, value: number }
interface HistogramPoint {
  attributes: Attributes;
  count: number;
  sum: number;
  bucketCounts: number[];
}
interface MetricsInput {
  counters: Record<string, CounterPoint[]>;
  histograms: Record<string, HistogramPoint[]>;
  startTimeMs: number;
  endTimeMs: number;
  resourceAttributes: Attributes;
}

/**
 * Milliseconds to OTLP nanoseconds. The product exceeds
 * `Number.MAX_SAFE_INTEGER`, so the last ~256 ns are not exact. That is
 * irrelevant here and mildly helpful: every timestamp we emit is an
 * interval boundary, deliberately coarse to the minute or more.
 */
function nanos (millis: number): string {
  return String(Math.round(millis) * 1000000);
}

/** Build an OTLP ExportMetricsServiceRequest body. */
function buildMetricsPayload (input: MetricsInput): Record<string, unknown> {
  const start = nanos(input.startTimeMs);
  const end = nanos(input.endTimeMs);
  const metrics: Array<Record<string, unknown>> = [];

  for (const name of Object.keys(input.counters)) {
    const points = input.counters[name];
    if (points.length === 0) continue;
    metrics.push({
      name,
      sum: {
        aggregationTemporality: DELTA,
        isMonotonic: true,
        dataPoints: points.map(function (point) {
          return {
            attributes: toKeyValues(point.attributes),
            startTimeUnixNano: start,
            timeUnixNano: end,
            asInt: String(point.value)
          };
        })
      }
    });
  }

  for (const name of Object.keys(input.histograms)) {
    const points = input.histograms[name];
    if (points.length === 0) continue;
    metrics.push({
      name,
      unit: 'ms',
      histogram: {
        aggregationTemporality: DELTA,
        dataPoints: points.map(function (point) {
          return {
            attributes: toKeyValues(point.attributes),
            startTimeUnixNano: start,
            timeUnixNano: end,
            count: String(point.count),
            sum: point.sum,
            bucketCounts: point.bucketCounts.map(String),
            explicitBounds: DURATION_BOUNDS.slice()
          };
        })
      }
    });
  }

  if (metrics.length === 0) return {};
  return {
    resourceMetrics: [{
      resource: toResource(input.resourceAttributes),
      scopeMetrics: [{ scope: SCOPE, metrics }]
    }]
  };
}

interface ErrorRecord {
  /** Hard-coded text for the error code, resolved by the caller. */
  message: string;
  attributes: Attributes;
  frames: string[];
  count: number;
}
interface LogsInput {
  errors: ErrorRecord[];
  intervalEndMs: number;
  resourceAttributes: Attributes;
}

/**
 * Build an OTLP ExportLogsServiceRequest body for error reports.
 *
 * Two properties are deliberate and load-bearing:
 *
 * **The body is a hard-coded message chosen by error code** (resolved by
 * the emitter from the repository's own message catalogue). The thrown
 * error's message is never consulted, so the body is a compile-time
 * constant, identical on every deployment. This module is a pure
 * serializer: it never derives a value, it only encodes what it is
 * handed, so there is one place to audit for what may be emitted.
 *
 * **Every record is timestamped at the interval boundary**, and carries a
 * count, because the emitter aggregates by fault rather than keeping one
 * record per occurrence. A precise per-occurrence timestamp would single
 * out an individual action to anyone holding a second timestamped signal;
 * the interval boundary carries no such handle.
 */
function buildLogsPayload (input: LogsInput): Record<string, unknown> {
  if (input.errors.length === 0) return {};
  const timestamp = nanos(input.intervalEndMs);
  const logRecords = input.errors.map(function (record) {
    const attributes = toKeyValues(record.attributes);
    if (record.frames.length > 0) {
      attributes.push({ key: 'error.stack', value: { stringValue: record.frames.join('\n') } });
    }
    attributes.push({ key: 'error.count', value: { intValue: String(record.count) } });
    return {
      timeUnixNano: timestamp,
      severityNumber: SEVERITY_ERROR,
      severityText: 'ERROR',
      body: { stringValue: record.message },
      attributes
    };
  });
  return {
    resourceLogs: [{
      resource: toResource(input.resourceAttributes),
      scopeLogs: [{ scope: SCOPE, logRecords }]
    }]
  };
}

/** Bucket index counts for one observation, against DURATION_BOUNDS. */
function emptyBuckets (): number[] {
  return new Array(DURATION_BOUNDS.length + 1).fill(0);
}

function bucketIndex (valueMs: number): number {
  for (let i = 0; i < DURATION_BOUNDS.length; i++) {
    if (valueMs <= DURATION_BOUNDS[i]) return i;
  }
  return DURATION_BOUNDS.length;
}

export {
  buildMetricsPayload,
  buildLogsPayload,
  emptyBuckets,
  bucketIndex,
  DURATION_BOUNDS,
  DELTA,
  SEVERITY_ERROR
};
export type { MetricsInput, LogsInput, CounterPoint, HistogramPoint, ErrorRecord };
