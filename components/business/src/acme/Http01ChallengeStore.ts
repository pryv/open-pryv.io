/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */

/**
 * In-memory token → keyAuthorization map backing the HTTP-01 challenge
 * server. CertRenewer's challengeCreateFn writes here; the HTTP-01
 * server's request handler reads from here when LE GETs
 * /.well-known/acme-challenge/<token>. Tokens are deleted via
 * challengeRemoveFn after each authorization completes.
 *
 * Lives in the master process (same process that runs the
 * AcmeOrchestrator). Workers do not interact with this store.
 */
export class Http01ChallengeStore {
  #map: Map<string, string> = new Map();

  set (token: string, keyAuthorization: string): void {
    this.#map.set(token, keyAuthorization);
  }

  get (token: string): string | undefined {
    return this.#map.get(token);
  }

  delete (token: string): void {
    this.#map.delete(token);
  }

  clear (): void {
    this.#map.clear();
  }

  get size (): number {
    return this.#map.size;
  }
}
