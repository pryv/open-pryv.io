/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */
import { createRequire } from 'node:module';
import type { Response } from 'express';
const require = createRequire(import.meta.url);

const setCommonMeta = require('api-server/src/methods/helpers/setCommonMeta.ts').setCommonMeta;

type DataMatrixLike = { columns: unknown; data: unknown };
/** Represents a response in series format.
 *
 * This class is used to represent a series response. It serializes to JSON.
 */
class SeriesResponse {
  matrix: DataMatrixLike;
  /** Constructs a series response from an existing data matrix.
   */
  constructor (mat: DataMatrixLike) {
    this.matrix = mat;
  }

  /** Answers the client with a series response (JSON).
   */
  answer (res: Response) {
    res.json(this).status(200);
  }

  /** Serializes this response to JSON.
   */
  toJSON () {
    return setCommonMeta({
      format: 'flatJSON',
      fields: this.matrix.columns,
      points: this.matrix.data
    });
  }
}
export default SeriesResponse;
export { SeriesResponse };
