/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */
import type {} from 'node:fs';

const assert = require('assert');
const { error } = require('./errors');
// 'series' layer depends on the 'types' layer.
const Row = require('./row');
/** Data in matrix form. Columns have names, rows have numbers, starting at 0.
 */
class DataMatrix {
  columns;

  data;
  // @return {number} number of rows this data matrix has.

  length;
  // Parses a data matrix given a javascript object of the right form
  // ('flatJSON'). This method will throw a ParseFailure if the internal
  // structure of the object is not correct.
  //
  /** @static
   * @param {unknown} obj
   * @param {SeriesRowType} type
   * @returns {DataMatrix}
   */
  static parse (obj, type) {
    const out = this.empty();
    const parser = new Parser(out);
    parser.parse(obj, type);
    return out;
  }

  /** Constructs an empty matrix.
   * @static
   * @returns {DataMatrix}
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
   * @return {void}
   */
  constructor (columns, data) {
    this.columns = columns;
    this.setData(data);
  }

  /** Updates the data attribute internally, keeping length === data.length.
   * @param {Array<any>} data
   * @returns {void}
   */
  setData (data) {
    this.data = data;
    this.length = data.length;
  }

  /** Accesses the nth element of the array. If the index is out of bounds,
   * an error is thrown.
   * @param {number} idx
   * @returns {import("/Users/sim/Code/Pryv/dev/service-core/data_matrix.ts-to-jsdoc").Element[]}
   */
  at (idx) {
    assert.ok(idx >= 0);
    assert.ok(idx < this.length);
    return this.data[idx];
  }

  // Returns the row at index `idx`.
  //
  /**
   * @param {number} idx
   * @returns {any}
   */
  atRow (idx) {
    const raw = this.at(idx);
    return new Row(raw, this.columns);
  }

  /** Iterates over each row of the data matrix.
   * @param {(row: Row, idx: number) => void} fn
   * @returns {void}
   */
  eachRow (fn) {
    this.data.forEach((row, idx) => {
      const rowObj = new Row(row, this.columns);
      fn(rowObj, idx);
    });
  }

  // Transforms this matrix in place by calling `fn` for each cell, replacing
  // its value with what fn returns.
  //
  /**
   * @param {(colName: string, cellVal: Element) => Element} fn
   * @returns {void}
   */
  transform (fn) {
    for (const row of this.data) {
      row.forEach((cell, idx) => (row[idx] = fn(this.columns[idx], cell)));
    }
  }

  // Returns a tuple of [from, to] for the dataset in this matrix, indicating
  // the earliest (`from`) and the latest (`to`) deltaTime in the data set.
  // No assumptions are made about the order of the data. If the matrix is
  // empty, this method throws an error.
  //
  /**
   * @returns {import("/Users/sim/Code/Pryv/dev/service-core/data_matrix.ts-to-jsdoc").DataExtent}
   */
  minmax () {
    if (this.length <= 0) { throw new Error('Precondition error: matrix is empty.'); }
    // assert: length > 0 => at least one row is available
    const first = this.atRow(0).deltaTime();
    let [min, max] = [first, first];
    this.eachRow((row) => {
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
  out;
  constructor (out) {
    this.out = out;
  }

  /**
   * @param {unknown} obj
   * @param {SeriesRowType} type
   * @returns {void}
   */
  parse (obj, type) {
    const out = this.out;
    if (obj == null || typeof obj !== 'object') { throw error('flatJSON structure must be an object.'); }
    // assert: obj is a {}
    if (obj.format !== FLAT_JSON) { throw error('"format" field must contain the string "flatJSON".'); }
    const fields = this.checkFields(obj.fields);
    const points = obj.points;
    if (points == null || !Array.isArray(points)) { throw error('"points" field must be a list of data points.'); }
    // assert: fields, points are both arrays
    if (!type.validateColumns(fields)) { throw error('"fields" field must contain valid field names for the series type.'); }
    if (!type.validateAllRows(points, fields)) { throw error('"points" matrix must contain correct data types according to series type.'); }
    out.columns = fields;
    out.setData(points);
    out.transform((columnName, cellValue) => {
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

  /**
   * @param {any} val
   * @returns {string[]}
   */
  checkFields (val) {
    if (val == null) { throw error('Field names must be a list.'); }
    if (!Array.isArray(val)) { throw error('Field names must be a list.'); }
    for (const el of val) {
      if (typeof el !== 'string') { throw error('Field names must be strings.'); }
    }
    return val;
  }
}
module.exports = DataMatrix;

/** @typedef {string | number} Element */

/** @typedef {Array<Element>} RawRow */

/** @typedef {number} EpochTime */

/**
 * @typedef {{
 *   from: EpochTime;
 *   to: EpochTime;
 * }} DataExtent
 */
