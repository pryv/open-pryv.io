/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */
const DataMatrix = require('./data_matrix');
const { error, ParseFailure } = require('./errors');
// A `BatchRequest` is a collection of batch elements. Each of those in turn
// will contain a series meta data descriptor and a data matrix to input into
// that series.
//

class BatchRequest {
  list;
  // Parses an object and verifies that its structure corresponds to a series
  // batch, as described in the documentation ('seriesBatch'). If the input
  // object contains an error, it is thrown as a `ParseFailure`.
  //
  /** @static
   * @param {unknown} jsonObj
   * @param {TypeResolveFunction} resolver
   * @returns {Promise<BatchRequest>}
   */
  static parse (jsonObj, resolver) {
    const parser = new Parser(resolver);
    return parser.parse(jsonObj);
  }

  constructor () {
    this.list = [];
  }

  // Append an element to the list of elements in this BatchRequest.
  //
  /**
   * @param {BatchRequestElement} element
   * @returns {void}
   */
  append (element) {
    this.list.push(element);
  }

  // Returns the amount of batch elements stored here.
  //
  /**
   * @returns {number}
   */
  length () {
    return this.list.length;
  }

  /**
   * @returns {Iterator<BatchRequestElement, any, undefined>}
   */
  * elements () {
    // No arr.values() in node yet...
    for (const el of this.list) {
      yield el;
    }
  }
}
// A batch request for a single series event. Contains the `eventId`, the
// meta data for the series and the actual data points.
//

class BatchRequestElement {
  eventId;

  data;
  /** @static
   * @param {unknown} obj
   * @param {TypeResolveFunction} resolver
   * @returns {Promise<BatchRequestElement>}
   */
  static parse (obj, resolver) {
    const parser = new ElementParser();
    return parser.parse(obj, resolver);
  }

  constructor (eventId, data) {
    this.eventId = eventId;
    this.data = data;
  }
}
const SERIES_BATCH = 'seriesBatch';
// Parses the envelope of a seriesBatch request. Individual entries in the
// `data` array are then parsed by `ElementParser`.
//

class Parser {
  resolver;
  constructor (resolver) {
    this.resolver = resolver;
  }

  /**
   * @param {unknown} jsonObj
   * @returns {Promise<BatchRequest>}
   */
  parse (jsonObj) {
    if (jsonObj == null || typeof jsonObj !== 'object') { throw error('Request body needs to be in JSON format.'); }
    return this.parseSeriesBatch(jsonObj);
  }

  /**
   * @param {any} obj
   * @returns {Promise<BatchRequest>}
   */
  async parseSeriesBatch (obj) {
    const resolver = this.resolver;
    const out = new BatchRequest();
    if (obj.format !== SERIES_BATCH) { throw error('Envelope "format" must be "seriesBatch"'); }
    if (!Array.isArray(obj.data)) { throw error('Envelope must have a data list, containing individual batch elements'); }
    for (const elObj of obj.data) {
      out.append(await BatchRequestElement.parse(elObj, resolver));
    }
    return out;
  }
}

class ElementParser {
  /**
   * @param {unknown} obj
   * @param {TypeResolveFunction} resolver
   * @returns {Promise<BatchRequestElement>}
   */
  async parse (obj, resolver) {
    if (obj == null || typeof obj !== 'object') { throw error('Batch element must be an object with properties.'); }
    const eventId = obj.eventId;
    if (typeof eventId !== 'string') { throw error('Batch element must contain an eventId of the series event.'); }
    const type = await resolver(eventId);
    return new BatchRequestElement(eventId, DataMatrix.parse(obj.data, type));
  }
}
module.exports = { BatchRequest, BatchRequestElement, ParseFailure };

/** @typedef {(eventId: string) => Promise<SeriesRowType>} TypeResolveFunction */
