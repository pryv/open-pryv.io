# Storage interface versions

Each storage type has one integer interface version, in [`versions.ts`](versions.ts). An engine declares the
version it implements per storage type in its `manifest.json` (`interfaceVersions`); a type without a declared
version counts as 1. The server refuses to start when a discovered engine's version differs from its own, lower or
higher, with a message naming the engine, the storage type and both versions.

## When to bump

**Bump the version (+1) when an engine that was correct before the change can be wrong after it:** a new required
export or method, a removed or renamed one, a changed argument list or return shape, a changed meaning (ordering,
atomicity, error contract) of an existing method, a new required internal or a changed call order at init.

**Do not bump** for an optional method the host feature-detects (`typeof x === 'function'`, as for
`reconcileContentIndexes`), a new optional argument with the previous behaviour as default, documentation, or types
that only tighten what the in-tree engines already return.

A bump is one commit that changes `versions.ts`, the manifest of every in-tree engine implementing that type, the
table below and the changelog. Versions are per storage type: a change to `platformStorage` does not touch
`baseStorage` engines. An engine maintained elsewhere ships a release declaring the new version.

## History

| Storage type | Version | Since | What changed |
|---|---|---|---|
| `baseStorage` | 1 | the release introducing interface versions | initial |
| `baseStorage` | 2 | the release storing access tokens at rest | accesses and sessions store a keyed hash plus an encrypted copy through the injected `tokenProtection` (init option), conditions on `token` and session ids go through the hash; the engine exports `getTokensAtRest()` (probe, protect, status, unprotect, rekey) |
| `dataStore` | 1 | the release introducing interface versions | initial |
| `platformStorage` | 1 | the release introducing interface versions | initial |
| `platformStorage` | 2 | the release introducing platform setup and administrators | two new required `PlatformDB` methods: `setPlatformKvIfAbsent` (atomic insert-if-absent) and `replacePlatformKvIfValue` (atomic compare-and-set, or delete); conformance `[PLKV13]`, `[PLKV14]` |
| `seriesStorage` | 1 | the release introducing interface versions | initial |
| `fileStorage` | 1 | the release introducing interface versions | initial |
| `auditStorage` | 1 | the release introducing interface versions | initial |
