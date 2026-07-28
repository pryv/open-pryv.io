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
  timeMs: number;
  code: string;
  attributes: Attributes;
  frames: string[];
}
interface LogsInput {
  errors: ErrorRecord[];
  resourceAttributes: Attributes;
}

/**
 * Build an OTLP ExportLogsServiceRequest body for error reports.
 *
 * The record body is the error CODE, never a message. The stack travels as
 * a dedicated attribute holding the sanitized frames joined by newlines,
 * which is why it is assembled here rather than passed through the generic
 * attribute allow-list: it is not a label, it is the payload the operator
 * needs to locate the fault, and it has already been stripped of paths.
 */
function buildLogsPayload (input: LogsInput): Record<string, unknown> {
  if (input.errors.length === 0) return {};
  const logRecords = input.errors.map(function (record) {
    const attributes = toKeyValues(record.attributes);
    if (record.frames.length > 0) {
      attributes.push({ key: 'error.stack', value: { stringValue: record.frames.join('\n') } });
    }
    return {
      timeUnixNano: nanos(record.timeMs),
      severityNumber: SEVERITY_ERROR,
      severityText: 'ERROR',
      body: { stringValue: record.code },
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
