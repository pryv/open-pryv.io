/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */

/**
 * Whether this process serves API requests: a worker of the clustered server
 * (`bin/master.js`) of type `api` or `hfs`. The master, every command-line
 * tool and the single-process entry points answer false, so the limits
 * meant for request handling never apply to them.
 */
function isRequestServingProcess (): boolean {
  const type = process.env.PRYV_WORKER_TYPE;
  return type === 'api' || type === 'hfs';
}

export { isRequestServingProcess };
