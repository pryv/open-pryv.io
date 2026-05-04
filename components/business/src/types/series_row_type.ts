/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */
import type {} from 'node:fs';

const logger = require('@pryv/boiler').getLogger('series_row_type');
const FIELD_DELTATIME = 'deltaTime';
const FIELD_TIMESTAMP = 'timestamp';
// Represents the type of the deltaTime column in series input data.
//

class SeriesDateType {
  deltaTo;
  constructor (eventTime) {
    this.deltaTo = eventTime;
  }

  /**
   * @param {number} secs
   * @returns {number}
   */
  secondsToNanos (secs) {
    if (secs < 0) { throw new Error('Deltatime must be greater than 0'); }
    return Math.trunc(secs * 1000 * 1000 * 1000);
  }

  /**
   * @param {any} value
   * @returns {any}
   */
  coerce (value) {
    switch (typeof value) {
      case 'number':
        return this.secondsToNanos(value - this.deltaTo);
      case 'string':
        return this.secondsToNanos(parseFloat(value) - this.deltaTo);
            // FALL THROUGH
    }
    throw new Error(`Cannot coerce ${value} into deltaTime.`);
  }
}
// Represents the type of a row in series input data.
//

class SeriesRowType {
  eventType;

  seriesMeta;

  applyDeltaTimeToSerie;
  constructor (eventType) {
    this.eventType = eventType;
    this.applyDeltaTimeToSerie = 0;
  }

  /**
   * @param {SeriesMetadata} seriesMeta
   * @returns {void}
   */
  setSeriesMeta (seriesMeta) {
    this.seriesMeta = seriesMeta;
  }

  // Returns the name of the type inside the series.
  //
  /**
   * @returns {any}
   */
  elementTypeName () {
    return this.eventType.typeName();
  }

  /**
   * Returns true if the columns given can be reconciled with this type.
   * WARNING If 'timestamp' column is found a column name will be renamed to "deltaTime"
   * and next coerce will convert timestamps to deltaTime relatively to the
   * Event time.
   * @param {Array<string>} columnNames
   * @returns {boolean}
   */
  validateColumns (columnNames) {
    const underlyingType = this.eventType;
    // ** do we need to transformation timestamp into deltatime
    // ** look for "timestamp" in the columns and rename it to deltatime..
    // ** advertise type to convert future measures and r
    const timestampColumn = columnNames.indexOf(FIELD_TIMESTAMP);
    if (timestampColumn >= 0) {
      columnNames[timestampColumn] = FIELD_DELTATIME;
      if (!this.seriesMeta) {
        throw new Error('Cannot transform to timestamp without knwowing the seriesMeta time');
      }
      this.applyDeltaTimeToSerie = this.seriesMeta.time;
    }
    // These names are all allowed once:
    const allowedFields = new Set(underlyingType.fields());
    allowedFields.add(FIELD_DELTATIME);
    logger.debug('Allowed are ', allowedFields);
    // Accumulator for the fields that we've already seen.
    const seenFields = new Set();
    for (const field of columnNames) {
      if (!allowedFields.has(field)) {
        logger.debug(`Field '${field}' is not allowed.`);
        return false;
      }
      // Fields are only allowed once; otherwise the storage op would be
      // ambiguous.
      if (seenFields.has(field)) {
        logger.debug(`Duplicate field '${field}'.`);
        return false;
      }
      seenFields.add(field);
    }
    // Now this looks valid: Only allowed fields and every field just once.
    // Let's see if we have all required fields:
    const requiredFields = new Set(underlyingType.requiredFields());
    requiredFields.add(FIELD_DELTATIME);
    for (const requiredField of requiredFields) {
      if (!seenFields.has(requiredField)) {
        logger.debug(`Field '${requiredField}' is required, but was not present.`);
        return false;
      }
    }
    return true;
  }

  /** Returns true if all the rows in the given row array are valid for this
   * type.
   * @param {Array<any>} rows
   * @param {Array<string>} columnNames
   * @returns {boolean}
   */
  validateAllRows (rows, columnNames) {
    for (const row of rows) {
      if (!this.isRowValid(row, columnNames)) {
        logger.debug('Invalid row: ', row, columnNames.length);
        return false;
      }
    }
    return true;
  }

  /** Returns true if the given row (part of the input from the client) looks
   * right. See the code for what rules define right.
   *
   * Normal order of operations would be:
   *
   *  1) Check `columnNames` (`{@link validateColumns}`).
   *  2) For each row:
   *    2.1) `isRowValid`?
   *    2.2) For each cell:
   *      2.2.1) `coerce` into target type
   *      2.2.2) `isCellValid`?
   *
   * @param {any} row  Rows parsed from client input, could be any type.
   * @param {Array<string>} columnNames  A list of column names the client
    provided. Check these first using `validateColumns`.
   * @returns {boolean}
   */
  isRowValid (row, columnNames) {
    // A valid row is an array of cells.
    if (!Array.isArray(row)) { return false; }
    // It has the correct length. (Assumes that columnNames is right)
    if (row.length !== columnNames.length) { return false; }
    // Everything looks good.
    return true;
  }

  // As part of being an EventType, return the name of this type.
  //
  /**
   * @returns {string}
   */
  typeName () {
    return 'series:' + this.eventType.typeName();
  }

  /** Returns the type of a single cell with column name `name`.
   * @param {string} name
   * @returns {any}
   */
  forField (name) {
    if (name === FIELD_DELTATIME) {
      return new SeriesDateType(this.applyDeltaTimeToSerie);
    } else {
      return this.eventType.forField(name);
    }
  }

  // What fields may be present? See `requiredFields` for a list of mandatory
  // fields.
  //
  /**
   * @returns {string[]}
   */
  optionalFields () {
    return this.eventType.optionalFields();
  }

  // check if a field is required
  /**
   * @param {string} name
   * @returns {Boolean}
   */
  isOptionalField (name) {
    return this.optionalFields().includes(name);
  }

  // What fields MUST be present?
  //
  /**
   * @returns {string[]}
   */
  requiredFields () {
    return [FIELD_DELTATIME].concat(this.eventType.requiredFields());
  }

  /**
   * @returns {string[]}
   */
  fields () {
    return [FIELD_DELTATIME].concat(this.eventType.fields());
  }

  /**
   * @returns {true}
   */
  isSeries () {
    return true;
  }

  /**
   * @param {Validator} validator
   * @param {Content} content
   * @returns {Promise<any>}
   */
  callValidator (validator,

    content) {
    return Promise.reject(new Error('No validation for series row types.'));
  }
}
module.exports = SeriesRowType;
