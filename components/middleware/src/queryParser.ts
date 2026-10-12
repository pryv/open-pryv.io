/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */
import qs from 'qs';

/**
 * Express "extended" query parsing (bracket syntax: `a[]=1&a[]=2`, `a[b]=1`)
 * without `allowPrototypes`: Express 4 passes `allowPrototypes: true`, which
 * lets a query key shadow an `Object.prototype` property (`?hasOwnProperty=x`).
 * Install with `app.set('query parser', queryParser)`.
 */
export default function queryParser (str: string): Record<string, unknown> {
  return qs.parse(str, { allowPrototypes: false });
}
