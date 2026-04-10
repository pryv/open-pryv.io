/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */
/**
 * HTTP client wrapper for benchmarks.
 * Uses Node's built-in fetch (undici) with connection pooling.
 */

export class Client {
  constructor (baseUrl, token) {
    this.baseUrl = baseUrl.replace(/\/$/, '');
    this.token = token;
    this.headers = {
      authorization: token,
      'content-type': 'application/json',
      origin: new URL(baseUrl).origin
    };
  }

  async get (path) {
    const start = performance.now();
    const res = await fetch(this.baseUrl + path, {
      method: 'GET',
      headers: this.headers
    });
    const elapsed = performance.now() - start;
    const body = await res.json();
    return { status: res.status, body, elapsed, ok: res.ok };
  }

  async post (path, data) {
    const start = performance.now();
    const res = await fetch(this.baseUrl + path, {
      method: 'POST',
      headers: this.headers,
      body: JSON.stringify(data)
    });
    const elapsed = performance.now() - start;
    const body = await res.json();
    return { status: res.status, body, elapsed, ok: res.ok };
  }

  async put (path, data) {
    const start = performance.now();
    const res = await fetch(this.baseUrl + path, {
      method: 'PUT',
      headers: this.headers,
      body: JSON.stringify(data)
    });
    const elapsed = performance.now() - start;
    const body = await res.json();
    return { status: res.status, body, elapsed, ok: res.ok };
  }

  async delete (path) {
    const start = performance.now();
    const res = await fetch(this.baseUrl + path, {
      method: 'DELETE',
      headers: this.headers
    });
    const elapsed = performance.now() - start;
    const body = await res.json();
    return { status: res.status, body, elapsed, ok: res.ok };
  }
}

/**
 * Run a function at the given concurrency for the given duration.
 * `fn` receives the worker index and should return a result object.
 * Returns an array of all results.
 */
export async function runConcurrent (fn, { concurrency, durationMs }) {
  const results = [];
  const deadline = Date.now() + durationMs;
  let running = 0;
  let workerIndex = 0;

  return new Promise((resolve) => {
    function launch () {
      while (running < concurrency && Date.now() < deadline) {
        running++;
        const idx = workerIndex++;
        fn(idx).then((result) => {
          results.push(result);
          running--;
          if (Date.now() < deadline) {
            launch();
          } else if (running === 0) {
            resolve(results);
          }
        }).catch((err) => {
          results.push({ error: err.message, elapsed: 0 });
          running--;
          if (Date.now() < deadline) {
            launch();
          } else if (running === 0) {
            resolve(results);
          }
        });
      }
      if (running === 0) {
        resolve(results);
      }
    }
    launch();
  });
}
