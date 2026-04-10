/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */
const setCommonMeta = require('api-server/src/methods/helpers/setCommonMeta').setCommonMeta;
/** Represents a response in series format.
 *
 * This class is used to represent a series response. It serializes to JSON.
 */
class SeriesResponse {
  matrix;
  /** Constructs a series response from an existing data matrix.
   */
  constructor (mat) {
    this.matrix = mat;
  }

  /** Answers the client with a series response (JSON).
   * @param {express$Response} res
   * @returns {void}
   */
  answer (res) {
    res.json(this).status(200);
  }

  /** Serializes this response to JSON.
   * @returns {any}
   */
  toJSON () {
    return setCommonMeta({
      format: 'flatJSON',
      fields: this.matrix.columns,
      points: this.matrix.data
    });
  }
}
module.exports = SeriesResponse;
