/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */

/**
 * SeriesConnection interface.
 * Both InfluxConnection and PGSeriesConnection must implement these methods.
 */

export type SeriesPoint = {
  measurement?: string;
  tags?: Record<string, string>;
  fields?: Record<string, unknown>;
  timestamp?: number;
  [k: string]: unknown;
};

export interface SeriesConnection {
  createDatabase (name: string): Promise<void> | void;
  dropDatabase (name: string): Promise<void> | void;
  writeMeasurement (measurement: string, points: SeriesPoint[]): Promise<void> | void;
  dropMeasurement (measurement: string): Promise<void> | void;
  writePoints (points: SeriesPoint[]): Promise<void> | void;
  query (q: string | object): Promise<unknown> | unknown;
  getDatabases (): Promise<string[]> | string[];
}

const REQUIRED_METHODS: string[] = [
  'createDatabase',
  'dropDatabase',
  'writeMeasurement',
  'dropMeasurement',
  'writePoints',
  'query',
  'getDatabases'
];

function validateSeriesConnection (instance: unknown): SeriesConnection {
  const obj = instance as Record<string, unknown>;
  for (const method of REQUIRED_METHODS) {
    if (typeof obj[method] !== 'function') {
      throw new Error(`SeriesConnection implementation missing method: ${method}`);
    }
  }
  return obj as unknown as SeriesConnection;
}

export { validateSeriesConnection, REQUIRED_METHODS };