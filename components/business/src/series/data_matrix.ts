/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const assert = require('assert');
const { error } = require('./errors.ts');
// 'series' layer depends on the 'types' layer.
const Row = require('./row.ts').default;
/** Data in matrix form. Columns have names, rows have numbers, starting at 0.
 */
type Element = string | number | null;
type RawRow = Element[];
type EpochTime = number;
type DataExtent = {
  from: EpochTime;
  to: EpochTime;
};
type SeriesRowType = {
  validateColumns (fields: string[]): boolean;
  validateAllRows (points: RawRow[], fields: string[]): boolean;
  isOptionalField (name: string): boolean;
  forField (name: string): { coerce (cell: Element): Element };
};
type FlatJSON = {
  format?: string;
  fields?: unknown;
  points?: unknown;
  [k: string]: unknown;
};

class DataMatrix {
  columns: string[];

  data: RawRow[];
  // number of rows in this data matrix

  length: number;
  // Parses a data matrix given a javascript object of the right form
  // ('flatJSON'). This method will throw a ParseFailure if the internal
  // structure of the object is not correct.
  //
  static parse (obj: unknown, type: SeriesRowType): DataMatrix {
    const out = this.empty();
    const parser = new Parser(out);
    parser.parse(obj, type);
    return out;
  }

  /** Constructs an empty matrix.
   * @static
   */
  static empty () {
    return new DataMatrix([], []);
  }

  /** Store data inside the data matrix. This replaces the
   * existing content of this matrix with the content you
   * give as parameter.
   *
   * NOTE data must be rectangular; it can contain as many
   *  rows as you want (outer array), but should always
   *  contain columns.length columns (inner array). This is
   *  not checked, but further operations will take place
   *  only on known columns.
   *
   * @param columns {Array<string>} column names to use for
   *  this matrix.
   * @param data {Array<Array<Element>} data
   */
  constructor (columns: string[], data: RawRow[]) {
    this.columns = columns;
    this.data = data;
    this.length = data.length;
  }

  /** Updates the data attribute internally, keeping length === data.length.
   */
  setData (data: RawRow[]) {
    this.data = data;
    this.length = data.length;
  }

  /** Accesses the nth element of the array. If the index is out of bounds,
   * an error is thrown.
   */
  at (idx: number): RawRow {
    assert.ok(idx >= 0);
    assert.ok(idx < this.length);
    return this.data[idx];
  }

  // Returns the row at index `idx`.
  //
  atRow (idx: number): InstanceType<typeof Row> {
    const raw = this.at(idx);
    return new Row(raw, this.columns);
  }

  /** Iterates over each row of the data matrix.
   */
  eachRow (fn: (row: InstanceType<typeof Row>, idx: number) => void) {
    this.data.forEach((row: RawRow, idx: number) => {
      const rowObj = new Row(row, this.columns);
      fn(rowObj, idx);
    });
  }

  // Transforms this matrix in place by calling `fn` for each cell, replacing
  // its value with what fn returns.
  //
  transform (fn: (columnName: string, cellValue: Element) => Element) {
    for (const row of this.data) {
      row.forEach((cell: Element, idx: number) => (row[idx] = fn(this.columns[idx], cell)));
    }
  }

  // Returns a tuple of [from, to] for the dataset in this matrix, indicating
  // the earliest (`from`) and the latest (`to`) deltaTime in the data set.
  // No assumptions are made about the order of the data. If the matrix is
  // empty, this method throws an error.
  //
  minmax () {
    if (this.length <= 0) { throw new Error('Precondition error: matrix is empty.'); }
    // assert: length > 0 => at least one row is available
    const first = this.atRow(0).deltaTime();
    let [min, max] = [first, first];
    this.eachRow((row: InstanceType<typeof Row>) => {
      const deltaTime = row.deltaTime();
      min = Math.min(min, deltaTime);
      max = Math.max(max, deltaTime);
    });
    return {
      from: min,
      to: max
    };
  }
}
const FLAT_JSON = 'flatJSON';

class Parser {
  out: DataMatrix;
  constructor (out: DataMatrix) {
    this.out = out;
  }

  parse (obj: unknown, type: SeriesRowType): void {
    const out = this.out;
    if (obj == null || typeof obj !== 'object') { throw error('flatJSON structure must be an object.'); }
    const objRec = obj as FlatJSON;
    // assert: obj is a {}
    if (objRec.format !== FLAT_JSON) { throw error('"format" field must contain the string "flatJSON".'); }
    const fields = this.checkFields(objRec.fields);
    const points = objRec.points;
    if (points == null || !Array.isArray(points)) { throw error('"points" field must be a list of data points.'); }
    // assert: fields, points are both arrays
    if (!type.validateColumns(fields)) { throw error('"fields" field must contain valid field names for the series type.'); }
    if (!type.validateAllRows(points, fields)) { throw error('"points" matrix must contain correct data types according to series type.'); }
    out.columns = fields;
    out.setData(points);
    out.transform((columnName: string, cellValue: Element) => {
      try {
        if (type.isOptionalField(columnName) && cellValue === null) { return null; }
        const cellType = type.forField(columnName);
        const coercedValue = cellType.coerce(cellValue);
        return coercedValue;
      } catch (e) {
        throw error(`Error during field coercion of [${columnName}] => [${cellValue}]: ${e}`);
      }
    });
  }

  checkFields (val: unknown): string[] {
    if (val == null) { throw error('Field names must be a list.'); }
    if (!Array.isArray(val)) { throw error('Field names must be a list.'); }
    for (const el of val) {
      if (typeof el !== 'string') { throw error('Field names must be strings.'); }
    }
    return val;
  }
}
export default DataMatrix;
export { DataMatrix };
export type { DataExtent };
