/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */


import type {} from 'node:fs';

// No-op tracing shim. The architectural slot is preserved so a future tracer
// (e.g. an OpenTelemetry adapter) can plug in here without touching any of the
// hot-path consumers documented in AGENTS.md truth #6. New Relic APM
// (Plan 38) is the active observability path and does NOT route through this
// component — it instruments the Node process via the agent at boot.

class DummyTracing {
  startSpan () {}
  finishSpan () {}
  logForSpan () {}
  setError () {}
  tagSpan () {}
}

module.exports = { Tracing: DummyTracing, DummyTracing };
