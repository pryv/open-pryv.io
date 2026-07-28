/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
const require = createRequire(import.meta.url);
const __filename = fileURLToPath(import.meta.url);
const __dirname = require('path').dirname(__filename);

/**
 * Reduce an arbitrary thrown value to code locations inside THIS
 * repository, and nothing else.
 *
 * ⚠ The message is never forwarded. It is the highest-risk field on an
 * error object: Node builds messages by interpolating whatever failed, so
 * `ENOENT ... open '/var-pryv/users/<id>/...'`, "user <email> not found"
 * and validation errors quoting the submitted payload are all ordinary
 * messages. Callers emit a hard-coded message chosen by error code
 * instead; the real message stays in the local logs.
 *
 * ⚠ Frames are rebuilt, not filtered. Every frame is decomposed into a
 * function name and a location, each checked against an allow-list, and
 * reassembled. A frame that cannot be expressed as
 * `at <safe-name> (<repo-relative-path>:<line>:<col>)` or a `node:`
 * internal is replaced by `at <external>` rather than emitted in some
 * partially-scrubbed form. This is deliberate: the previous deny-list
 * version let `file://`-form absolute paths through, because the check
 * looked for a slash immediately after `(`, and V8 emits `file://` URLs
 * throughout this ESM codebase. Deny-listing path shapes is exactly the
 * mistake this whole layer exists to stop making.
 */

const MAX_FRAMES = 30;
/**
 * Function names as V8 actually writes them: a dotted identifier chain,
 * optionally prefixed `new ` / `async `, optionally `<anonymous>` at any
 * position (`Object.<anonymous>`, `new Foo`, `async Bar.baz`).
 *
 * Deliberately NOT a loose character class. A class permitting free spaces
 * accepts `alice smith payload data`, which a dynamically-keyed function
 * can put here from runtime data — so the bound has to be a shape, not a
 * charset, for the published "checked against an allow-list" to be true.
 */
const SAFE_FUNCTION_NAME = /^(?:(?:new|async) )?(?:<anonymous>|[A-Za-z_$][A-Za-z0-9_$]*)(?:\.(?:<anonymous>|[A-Za-z0-9_$]+))*$/;
const MAX_FUNCTION_NAME_LENGTH = 80;
/**
 * A repository-relative source location. The first character is pinned to
 * a non-slash on purpose: a class that merely contains '/' also matches a
 * leading one, i.e. an absolute path.
 */
const SAFE_LOCATION = /^[A-Za-z0-9_.\-][A-Za-z0-9_.\-/]{0,199}:\d{1,7}:\d{1,7}$/;
/** A Node internal frame location. */
const SAFE_NODE_LOCATION = /^node:[A-Za-z0-9_/.]{1,100}:\d{1,7}:\d{1,7}$/;

const EXTERNAL_FRAME = 'at <external>';

/** Repository root: components/business/src/observability → up 4. */
function repositoryRoot (): string {
  return require('path').resolve(__dirname, '..', '..', '..', '..');
}

let cachedRoot: string | null = null;

function rootPath (): string {
  if (cachedRoot == null) cachedRoot = repositoryRoot();
  return cachedRoot;
}

/**
 * Strip the `file://` scheme V8 uses for ESM frames, then make the path
 * repository-relative. Returns null when the result still points outside
 * the repository.
 */
function toRepositoryRelative (location: string, root: string): string | null {
  let path = location;
  if (path.startsWith('file://')) path = fileUrlToPath(path);
  if (path.startsWith(root + '/')) path = path.slice(root.length + 1);
  // Anything still absolute, or still carrying a scheme, is outside the
  // repository: a linked dependency, a global install, an operator's own
  // plugin directory. Those paths can embed account names and directory
  // names we do not control, so no part of them is emitted.
  if (path.startsWith('/') || path.includes('://')) return null;
  return path;
}

/**
 * `fileURLToPath` throws on the malformed URLs that appear in synthesised
 * or bundled stacks, and a throw here would lose the whole report.
 */
function fileUrlToPath (url: string): string {
  try {
    return fileURLToPath(url);
  } catch {
    return url.replace(/^file:\/\//, '');
  }
}

/** Rebuild one `at ...` line, or return the external placeholder. */
function sanitizeFrame (line: string, root: string): string {
  const trimmed = line.trim();
  // `at FUNC (LOCATION)` — the common form.
  const withFunction = /^at\s+(.+?)\s+\((.+)\)$/.exec(trimmed);
  if (withFunction != null) {
    const name = safeName(withFunction[1]);
    const location = safeLocation(withFunction[2], root);
    if (location == null) return EXTERNAL_FRAME;
    return 'at ' + name + ' (' + location + ')';
  }
  // `at LOCATION` — top-level module frames.
  const bare = /^at\s+(.+)$/.exec(trimmed);
  if (bare != null) {
    const location = safeLocation(bare[1], root);
    if (location == null) return EXTERNAL_FRAME;
    return 'at ' + location;
  }
  return EXTERNAL_FRAME;
}

/**
 * Function names come from our own source, but a dynamically-keyed
 * function takes its name from the key, so the name is bounded rather
 * than trusted.
 */
function safeName (raw: string): string {
  const name = raw.trim();
  if (name.length > MAX_FUNCTION_NAME_LENGTH) return '<anonymous>';
  return SAFE_FUNCTION_NAME.test(name) ? name : '<anonymous>';
}

function safeLocation (raw: string, root: string): string | null {
  const location = raw.trim();
  if (SAFE_NODE_LOCATION.test(location)) return location;
  const relative = toRepositoryRelative(location, root);
  if (relative == null) return null;
  // A path that is ALREADY relative is returned unchanged by
  // toRepositoryRelative, so `..` segments would otherwise walk straight
  // out of the repository while still looking repository-relative
  // (`../../home/alice/x.js`). Absolute and file:// forms are handled
  // above; this closes the third form.
  if (hasParentSegment(relative)) return null;
  return SAFE_LOCATION.test(relative) ? relative : null;
}

/** True when any path segment is `..`. */
function hasParentSegment (path: string): boolean {
  return path.split('/').includes('..');
}

interface SanitizedError {
  errorClass: string;
  frames: string[];
}

/**
 * @param err — anything a `catch` can receive.
 */
function sanitizeError (err: unknown): SanitizedError {
  const errorClass = classNameOf(err);
  const stack = (err != null && typeof err === 'object' && typeof (err as Error).stack === 'string')
    ? (err as Error).stack as string
    : '';
  const root = rootPath();
  const frames: string[] = [];
  for (const line of stack.split('\n')) {
    // Only `at ...` lines are code locations; a stack's first line is
    // "<ClassName>: <message>" and must never be forwarded.
    if (!/^\s*at\s/.test(line)) continue;
    const frame = sanitizeFrame(line, root);
    // Collapse runs of external frames: they carry no information and a
    // long run of them is just noise.
    if (frame === EXTERNAL_FRAME && frames[frames.length - 1] === EXTERNAL_FRAME) continue;
    frames.push(frame);
    if (frames.length >= MAX_FRAMES) break;
  }
  return { errorClass, frames };
}

/**
 * Constructor name, bounded to a JS-identifier shape so an exotic thrown
 * value cannot smuggle text through this field. Works for objects and
 * primitives alike.
 */
function classNameOf (err: unknown): string {
  let name = 'Unknown';
  if (err != null) {
    const ctor = (err as { constructor?: { name?: string } }).constructor;
    if (ctor != null && typeof ctor.name === 'string' && ctor.name.length > 0) name = ctor.name;
  }
  return /^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(name) ? name : 'Unknown';
}

export { sanitizeError, classNameOf, sanitizeFrame, MAX_FRAMES, EXTERNAL_FRAME, SAFE_LOCATION };
export type { SanitizedError };
