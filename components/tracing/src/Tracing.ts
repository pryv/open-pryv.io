/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */


// No-op tracing shim. The architectural slot is preserved so a future
// tracer can plug in here without touching any of the hot-path consumers
// documented in AGENTS.md truth #6. Telemetry does NOT route through this
// component: metrics and error reports are built at the API choke point
// and shipped by components/business/src/observability.

class DummyTracing {
  startSpan () {}
  finishSpan () {}
  logForSpan () {}
  setError () {}
  tagSpan () {}
}

const Tracing = DummyTracing;
export { Tracing, DummyTracing };
