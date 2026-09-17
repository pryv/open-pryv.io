/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const fs = require('fs');
const path = require('path');
const { fileURLToPath } = require('node:url');
// components/business/src → repo root (anchor for repo-root-relative file:// URLs)
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const { fromCallback, jsonValidator } = require('utils');
const { getLogger } = require('@pryv/boiler');
let defaultTypes = require('./types/event-types.default.json');
const errors = require('./types/errors.ts');
const SeriesRowType = require('./types/series_row_type.ts').default;
const BasicType = require('./types/basic_type.ts').default;
const ComplexType = require('./types/complex_type.ts').default;
const SERIES_PREFIX = 'series:';

type EventLike = { type: string; content?: unknown; [k: string]: unknown };
type JsonSchema = Record<string, unknown>;
type EventTypeInstance = {
  callValidator (v: TypeValidator, content: unknown): unknown;
};
type Validator = {
  validate (content: unknown, schema: JsonSchema, cb: (err: Error | null) => void): void;
  validateSchema (s: unknown): boolean;
  schemaShapeError (s: unknown): string | null;
  lastReport?: unknown;
};

type Catalogue = { types: Record<string, JsonSchema>; [section: string]: unknown };

// `types` is not a JSON Schema keyword, so neither the whole-catalogue
// `validateSchema` check nor a compile looks inside it: a type whose own schema
// is malformed loads silently, and its validator then fails to build, so every
// event of that type is refused. Two cheap signals make that visible without
// changing behaviour:
// - on load, each type schema is checked against the meta-schema (a few ms for
//   the whole list) and each malformed one is named in the log;
// - on use, a schema that still fails to compile (what the meta-schema cannot
//   see: an unresolvable `$ref`, an invalid regex) is named once.
// Wildcard entries such as `numset/*` are skipped: no event type ever matches them.
let bundledTypesChecked = false;
function warnAboutInvalidTypeSchemas (types: Record<string, JsonSchema> | null | undefined, source: string): void {
  if (types == null || typeof types !== 'object') return;
  const validator = jsonValidator() as Validator;
  const logger = getLogger('event-types');
  for (const [name, schema] of Object.entries(types)) {
    if (name.includes('*')) continue;
    const problem = validator.schemaShapeError(schema);
    if (problem != null) {
      logger.warn(`Event type "${name}" from ${source} has an invalid schema, so every event of this type will be refused: ${problem}`);
    }
  }
}
const typesReportedUncompilable = new Set<string>();
function warnOnceUncompilable (name: string, err: Error): void {
  if (typesReportedUncompilable.has(name)) return;
  typesReportedUncompilable.add(name);
  getLogger('event-types').warn(`Event type "${name}" has a schema that cannot be compiled, so every event of this type is refused: ${err.message}`);
}

// Applies a downloaded catalogue onto the current one, entry by entry: each
// entry of a section (a type, an extras, classes or sets entry) replaces the
// current one whole, and entries the download does not carry are kept. A deep
// merge would keep keys removed upstream inside a type, so a schema repaired
// upstream could stay broken on a running core. Keeping unpublished entries
// preserves the legacy types running cores accept.
function applyCatalogue (target: Catalogue, source: Record<string, unknown>): Catalogue {
  const isPlainObject = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v);
  for (const [section, value] of Object.entries(source)) {
    const current = target[section];
    if (isPlainObject(value) && isPlainObject(current)) {
      for (const [key, entry] of Object.entries(value)) current[key] = entry;
    } else {
      target[section] = value;
    }
  }
  return target;
}

// Returns true if the name given refers to a series type. Currently this means
// that the name starts with SERIES_PREFIX.
//
function isSeriesType (name: string): boolean {
  return name.startsWith(SERIES_PREFIX);
}
// A validator that can check values against a types JSON Schema.
//

class TypeValidator {
  // Validates the given event type against its schema.
  //
  validate (type: EventTypeInstance, content: unknown) {
    return type.callValidator(this, content);
  }

  async validateWithSchema (content: unknown, schema: JsonSchema) {
    const validator = jsonValidator() as Validator;
    await new Promise<void>((resolve, reject) => {
      validator.validate(content, schema, (err: Error | null) => err ? reject(err) : resolve());
    });
    return content;
  }
}
// A repository of types that Pryv knows about. Currently, this is seeded from
// 'types/event-types.default.json' in this component. Also, once the server
// is running, a list is downloaded from the internet (pryv.com) that will
// extend the built in types.
//
// There are several different kind of types:
//
//  * 'leaf' types, which form the types you would use in vanilla events, such
//    as 'mass/kg' or 'picture/attached'.
//  * 'series' types, which describe a sequence of individual data points, each
//    data point being of the same leaf type.
//
// Leaf types are further divided into 'complex' types and 'basic' types.
// Complex types are objects with attributes, each attribute being itself either
// of a complex or a basic type. E.g. 'message/email'.
//
// Basic types are 'number', 'string' and others. These are the types of a
// single element of data.
//
// Synopsis:
//
//    const repo = new TypeRepository();
//    await repo.tryUpdate(someUrl);
//
//    const type = repo.lookup('mass/kg');
//    const seriesType = repo.lookup('series:mass/kg');
//

class TypeRepository {
  _validator: Validator;
  constructor () {
    this._validator = jsonValidator() as Validator;
    if (!bundledTypesChecked) {
      bundledTypesChecked = true;
      warnAboutInvalidTypeSchemas(defaultTypes.types, 'the bundled default event types');
    }
  }

  /**
   * Simple version of validate - to be used
   *
   * In api-server, use only:
   * - isSeriesType()
   * - isKnown()
   * - validate()
   *
   * The old path: lookup(), then validator() are too heavy
   */
  async validate (event: EventLike) {
    const content = event.content != null ? event.content : null;
    const schema = defaultTypes.types[event.type] as JsonSchema | undefined;
    if (schema == null) { throw new Error(`Event type validation was used on the unknown type "${event.type}".`); }
    return fromCallback((cb: (err: Error | null) => void) => this._validator.validate(content, schema, cb))
      .then(() => content, (err: unknown) => {
        // Content that does not match rejects with the validator's error list;
        // an Error means the schema itself could not be compiled.
        if (err instanceof Error) warnOnceUncompilable(event.type, err);
        throw err;
      });
  }

  // Returns true if the type given by `name` is known by Pryv. To be known,
  // it needs to be part of our standard types list that we load on startup
  // (#tryUpdate).
  //
  isKnown (name: string): boolean {
    if (isSeriesType(name)) {
      const leafTypeName = name.slice(SERIES_PREFIX.length);
      return this.isKnown(leafTypeName);
    }
    return defaultTypes.types[name] != null;
  }

  // Lookup a leaf type by name. A leaf type is either simple ('mass/kg') or
  // complex ('position/wgs84'). Leaf types are listed in
  // `event-types.default.json`.
  //
  lookupLeafType (name: string) {
    if (!this.isKnown(name)) { throw new errors.TypeDoesNotExistError(`Type '${name}' does not exist in this Pryv instance.`); }
    const typeSchema = defaultTypes.types[name];
    if (typeSchema.type === 'object') {
      return new ComplexType(name, typeSchema);
    }
    return new BasicType(name, typeSchema);
  }

  // Lookup a Pryv Event Type by name. To check if a type exists, use
  // `#isKnown`. Pryv types are either leaf types ('mass/kg', 'position/wgs84')
  // or series types ('series:LEAFTYPE').
  //
  // @throw {TypeDoesNotExistError} when name doesn't refer to a built in type.
  //
  lookup (name: string) {
    if (isSeriesType(name)) {
      const leafTypeName = name.slice(SERIES_PREFIX.length);
      const leafType = this.lookupLeafType(leafTypeName);
      return new SeriesRowType(leafType);
    }
    // assert: Not a series type, must be a leaf type.
    return this.lookupLeafType(name);
  }

  // Produces a validator instance.
  //
  validator () {
    return new TypeValidator();
  }

  // Tries to update the stored type definitions with a file found on the
  // internet.
  //
  async tryUpdate (sourceURL: string, apiVersion: string) {
    function unavailableError (err: unknown) {
      throw new Error('Could not update event types from ' +
                sourceURL +
                '\nError: ' +
                (err as Error).message);
    }
    function invalidError (err: unknown) {
      throw new Error('Invalid event types schema returned from ' +
                sourceURL +
                '\nErrors: ' +
                (err as { errors?: unknown })?.errors);
    }
    const FILE_PROTOCOL = 'file://';
    function isFileUrl (url: string) {
      return url.startsWith(FILE_PROTOCOL);
    }
    function removeFileProtocol (url: string) {
      return url.substring(FILE_PROTOCOL.length);
    }
    let eventTypesDefinition: Record<string, unknown> | undefined;
    try {
      if (isFileUrl(sourceURL)) {
        // used for tests
        let filePath = removeFileProtocol(sourceURL);
        if (!path.isAbsolute(filePath) && !fs.existsSync(filePath)) {
          // Relative file URLs are repo-root-relative (like the
          // service-info URL they usually come from); component test
          // runners set cwd to the component dir, so fall back to the
          // repo root when the cwd-relative path does not exist.
          const rootPath = path.join(REPO_ROOT, filePath);
          if (fs.existsSync(rootPath)) filePath = rootPath;
        }
        eventTypesDefinition = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
      } else {
        const USER_AGENT_PREFIX = 'Pryv.io/';
        const res = await fetch(sourceURL, {
          headers: { 'User-Agent': USER_AGENT_PREFIX + apiVersion }
        });
        if (!res.ok) {
          throw new Error(`Event types fetch failed: HTTP ${res.status} ${res.statusText}`);
        }
        eventTypesDefinition = await res.json();
      }
    } catch (err) {
      unavailableError(err);
    }
    const validator = this._validator;
    if (!validator.validateSchema(eventTypesDefinition)) { return invalidError(validator.lastReport); }
    // Apply the downloaded list onto the current one, then check what will
    // actually be used.
    defaultTypes = applyCatalogue(defaultTypes, eventTypesDefinition!);
    warnAboutInvalidTypeSchemas(defaultTypes.types, `the event types loaded from ${sourceURL}`);
  }
}
export { TypeRepository, SeriesRowType, isSeriesType, errors };