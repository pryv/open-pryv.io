/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */

/**
 * The effective configuration document served by
 * `GET /system/admin/config/effective`: see `snapshot.ts` (what is reported,
 * digests), `classification.ts` (the allow-list) and `redact.ts` (value scan,
 * fingerprints).
 */

export { buildEffectiveConfig, computeDigests, encodePath, scopesFromStores, FORMAT } from './snapshot.ts';
export type { ConfigMeta, ConfigScope, EffectiveConfig, KeyEntry, ObservabilityResolution, SnapshotInput } from './snapshot.ts';
export { findRule, RULES, NAME_EXCEPTIONS, EXTRA_TOP_LEVEL_KEYS, pathLooksSecret, isNameException } from './classification.ts';
export { stableStringify } from './redact.ts';
