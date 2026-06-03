/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */
import type {} from 'node:fs';

// A small class that helps clean up the tracing code in the controller code
// above.
//

type TracerSpan = { finish: () => void; [k: string]: unknown };
type ContextLike = { childSpan: (name: string, opts?: Record<string, unknown>) => TracerSpan };

class TracedOperations {
  ongoingOps: Map<string, TracerSpan>;

  context: ContextLike;
  constructor (context: ContextLike) {
    this.ongoingOps = new Map();
    this.context = context;
  }

  start (name: string, opts?: Record<string, unknown>): void {
    const ongoing = this.ongoingOps;
    const ctx = this.context;
    const span = ctx.childSpan(name, opts);
    ongoing.set(name, span);
  }

  finish (name: string): void {
    const ongoing = this.ongoingOps;
    const span = ongoing.get(name);
    if (span == null) { throw new Error(`Tried to finish span '${name}', but no such ongoing span.`); }
    span.finish();
  }
}
export default TracedOperations;
export { TracedOperations };
