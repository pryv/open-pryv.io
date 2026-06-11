/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */

// TypeScript `any` gate — run via `just lint-ts-any` (part of `just lint`).
//
// Kept separate from eslint.config.js on purpose: adding a `files: ['**/*.ts']`
// block there would make every pattern-less neostandard style config apply to
// .ts files too (style of .ts is tsc + convention, not eslint, for now).
// This config applies exactly one rule: explicit `any` is banned in TS
// sources. The few legitimate escape hatches carry a justified
// eslint-disable comment in place.
const tseslint = require('typescript-eslint');
const { plugins: neostandardPlugins } = require('neostandard');

// Canonical-noun guard — these type names have a single canonical home
// (AGENTS.md § "Canonical type homes — import, don't redeclare"); declaring
// them locally is FORBIDDEN: one type name has exactly one meaning in this
// codebase. Import the canonical type, or give a local structural view its
// own name (`XxxLike`), an engine row `XxxRow`, a domain-distinct concept a
// real name of its own. When several shapes compete for a bare noun, the
// API-facing (wire) shape owns it.
//
// Same-meaning refinements stay allowed where documented (per-file
// `type MethodContext = BaseMethodContext & {…}` scratch fields; middleware
// PryvRequest locals) — those names are not in the table.
//
// Adding a row to the AGENTS.md canonical-homes table? Add the noun here.
const CANONICAL_NOUNS = [
  { home: 'components/business/src/types/public.ts', nouns: ['Event', 'Stream', 'Access', 'Permission', 'PermissionLevel', 'StreamPermission', 'FeaturePermission', 'AccessType', 'Webhook', 'UserId', 'HttpHeaders', 'ApiResult', 'StreamQuery'] },
  { home: 'storages/interfaces/_shared/domain.ts', nouns: ['StoredEvent', 'StoredStream', 'StoredAccess', 'StoredPermission', 'SessionData'] },
  { home: 'storages/interfaces/_shared/types.ts', nouns: ['Callback', 'UserOrId', 'StoredItem', 'Query', 'UpdateData', 'FindOptions', 'EventsQueryState'] },
  { home: '@pryv/boiler (storages/interfaces/** use the mirror in _shared/types.ts)', nouns: ['Logger', 'LogFn', 'ConfigLike'] },
  { home: 'components/mall/src/types.ts', nouns: ['Mall', 'MallEvents', 'MallStreams', 'MallTransactionLike', 'DataStore', 'StoreSupports'] },
  { home: 'storages/engines/sqlite/src/types.ts', nouns: ['SqliteDb', 'SqliteStmt', 'SqlParam'] },
  { home: 'components/cmc/src/_types.ts', nouns: ['CmcAccessLike', 'CmcClientData', 'OutboundDeps', 'FetchLike'] },
  { home: 'storages/interfaces/baseStorage/UserStorage.ts', nouns: ['UserStorage'] },
  { home: 'storages/interfaces/baseStorage/Sessions.ts', nouns: ['Sessions'] },
  { home: 'storages/interfaces/baseStorage/UserAccountStorage.ts', nouns: ['UserAccountStorage'] },
  { home: 'storages/interfaces/auditStorage/UserAuditDatabase.ts', nouns: ['UserAuditDatabase', 'AuditEvent'] },
  { home: 'storages/interfaces/backup/BackupWriter.ts', nouns: ['BackupManifest'] },
  { home: 'storages/interfaces/backup/BackupReader.ts', nouns: ['BackupReader'] }
];
const canonicalNounRestrictions = CANONICAL_NOUNS.map(({ home, nouns }) => ({
  selector: `:matches(TSTypeAliasDeclaration, TSInterfaceDeclaration)[id.name=/^(${nouns.join('|')})$/]`,
  message: `Canonical type — import it from ${home} instead of redeclaring (AGENTS.md § Canonical type homes).`
}));

module.exports = [
  {
    files: ['components/**/*.ts', 'storages/**/*.ts'],
    ignores: ['components/test-helpers/**', 'components/**/test-helpers/**', '**/node_modules/**'],
    languageOptions: {
      parser: tseslint.parser
    },
    linterOptions: {
      // Sources carry disable comments for the full neostandard rule set,
      // which this single-rule pass does not run.
      reportUnusedDisableDirectives: 'off'
    },
    plugins: {
      '@typescript-eslint': tseslint.plugin,
      // Loaded so existing `eslint-disable n/...` comments resolve.
      n: neostandardPlugins.n
    },
    rules: {
      '@typescript-eslint/no-explicit-any': 'error'
    }
  },
  {
    files: ['components/**/*.ts', 'storages/**/*.ts'],
    ignores: [
      'components/test-helpers/**', 'components/**/test-helpers/**', '**/node_modules/**',
      // Canonical type homes — declaring these nouns there is the point.
      'components/business/src/types/public.ts',
      'storages/interfaces/_shared/domain.ts',
      'storages/interfaces/_shared/types.ts',
      'components/mall/src/types.ts',
      'components/boiler/**', // vendored @pryv/boiler — Logger's home
      'storages/engines/sqlite/src/types.ts',
      'components/cmc/src/_types.ts',
      'storages/interfaces/baseStorage/UserStorage.ts',
      'storages/interfaces/baseStorage/Sessions.ts',
      'storages/interfaces/baseStorage/UserAccountStorage.ts',
      'storages/interfaces/auditStorage/UserAuditDatabase.ts',
      'storages/interfaces/backup/BackupWriter.ts',
      'storages/interfaces/backup/BackupReader.ts',
      'storages/shared/contentQueryConditions.ts' // StoreSupports origin, re-exported by mall/src/types.ts
    ],
    languageOptions: {
      parser: tseslint.parser
    },
    linterOptions: {
      reportUnusedDisableDirectives: 'off'
    },
    rules: {
      'no-restricted-syntax': ['error', ...canonicalNounRestrictions]
    }
  }
];
