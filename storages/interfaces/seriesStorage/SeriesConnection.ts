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

export interface SeriesConnection {
  createDatabase (name: string): Promise<void> | void;
  dropDatabase (name: string): Promise<void> | void;
  writeMeasurement (measurement: string, points: any[]): Promise<void> | void;
  dropMeasurement (measurement: string): Promise<void> | void;
  writePoints (points: any[]): Promise<void> | void;
  query (q: string | object): Promise<any> | any;
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

function validateSeriesConnection (instance: any): SeriesConnection {
  for (const method of REQUIRED_METHODS) {
    if (typeof instance[method] !== 'function') {
      throw new Error(`SeriesConnection implementation missing method: ${method}`);
    }
  }
  return instance;
}

module.exports = { validateSeriesConnection, REQUIRED_METHODS };
