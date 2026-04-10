/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */
const _ = require('lodash');
const assert = require('assert');
/** A single row of the data matrix. Stores a reference to the original
 * matrix; this is like a pointer, not like a value. It is used during iteration
 * to reference individual rows.
 */
class Row {
  values;

  columnNames;
  /** Constructs a row - internal constructor. Use DataMatrix to produce rows.
   */
  constructor (values, columnNames) {
    this.values = values;
    this.columnNames = columnNames;
  }

  /** Turns this row into an object that has the columns as keys and the row
   * values as values. Remove columns with null values;
   *
   * @example
   *    row.toStruct() # => { col1: 'value1', col2: 'value2' }
   *
   * @return {any} The current row in object (struct) form.
   */
  toStruct () {
    const obj = _.zipObject(this.columnNames, this.values);
    return _.pickBy(obj, (val) => val !== null);
  }

  /** Returns a single field value.
   *
   * You need to make sure that you access an actual column,
   * otherwise this method throws an error.
   * @param {string} column
   * @returns {any}
   */
  get (column) {
    const idx = this.columnNames.indexOf(column);
    if (idx < 0) { throw new Error(`No such column ${column}.`); }
    assert.ok(idx < this.values.length);
    assert.ok(idx >= 0);
    return this.values[idx];
  }

  // Returns this rows deltaTime. If the deltaTime is not available, a runtime
  // error is thrown.
  //
  /**
   * @returns {number}
   */
  deltaTime () {
    const value = this.get('deltaTime');
    if (typeof value !== 'number') { throw new Error('Deltatime must be a number'); }
    if (value < 0) { throw new Error('Deltatime must be greater than 0'); }
    return value;
  }
}
module.exports = Row;
