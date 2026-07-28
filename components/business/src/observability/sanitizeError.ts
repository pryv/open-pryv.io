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
 * Turn an arbitrary thrown value into the only error shape allowed to
 * leave the process: a code, a class name and code locations.
 *
 * ⚠ The message is NEVER forwarded. It is the single highest-risk field on
 * an error object: Node builds messages by interpolating whatever failed,
 * so `ENOENT: no such file or directory, open '/var-pryv/users/<id>/...'`,
 * "user <email> not found" and validation errors echoing the submitted
 * payload are all ordinary messages. The message stays in the local logs,
 * where it belongs; the backend gets the code.
 *
 * Frames are code locations, which are safe, with one caveat handled here:
 * absolute paths embed the deployment layout (and, for filesystem errors
 * raised inside a user directory, can embed a user id), so every path is
 * rewritten relative to the repository root before it is emitted.
 */

const MAX_FRAMES = 30;
const MAX_FRAME_LENGTH = 200;

/**
 * Repository root, derived from this file's location:
 * components/business/src/observability → up 4.
 */
function repositoryRoot (): string {
  return require('path').resolve(__dirname, '..', '..', '..', '..');
}

let cachedRoot: string | null = null;

function rootPath (): string {
  if (cachedRoot == null) cachedRoot = repositoryRoot();
  return cachedRoot;
}

/**
 * Rewrite absolute paths in one stack frame to repository-relative form,
 * and drop any frame still holding an absolute path afterwards (a frame
 * from outside the repository tells us nothing worth the risk).
 */
function sanitizeFrame (frame: string, root: string): string | null {
  let out = frame.trim();
  if (out.length > MAX_FRAME_LENGTH) out = out.slice(0, MAX_FRAME_LENGTH);
  // Node internal frames carry no filesystem path at all.
  if (out.includes('(node:') || out.includes(' node:')) return out;
  if (root.length > 0) out = out.split(root + '/').join('').split(root).join('');
  // Anything left that still looks like an absolute path (a linked
  // dependency, a global install, a home directory) is discarded rather
  // than emitted: outside the repository we cannot reason about what the
  // path contains.
  if (/[( ]\//.test(out)) return null;
  return out;
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
    // Only `at ...` lines are code locations; the first line of a stack is
    // "<ClassName>: <message>" and must not be forwarded.
    if (!/^\s*at\s/.test(line)) continue;
    const sanitized = sanitizeFrame(line, root);
    if (sanitized != null) frames.push(sanitized);
    if (frames.length >= MAX_FRAMES) break;
  }
  return { errorClass, frames };
}

/**
 * Constructor name, bounded to a JS-identifier shape so that an exotic
 * thrown value cannot smuggle text through this field.
 */
function classNameOf (err: unknown): string {
  let name = 'Unknown';
  // Works for objects and primitives alike: a thrown 42 reports 'Number',
  // a thrown string 'String', an Error subclass its own name.
  if (err != null) {
    const ctor = (err as { constructor?: { name?: string } }).constructor;
    if (ctor != null && typeof ctor.name === 'string' && ctor.name.length > 0) name = ctor.name;
  }
  return /^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(name) ? name : 'Unknown';
}

export { sanitizeError, classNameOf, MAX_FRAMES };
export type { SanitizedError };
