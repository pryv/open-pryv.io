/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */

// The lexer and parser `pug` itself compiles with.
import pugLex from 'pug-lexer';
import pugParse from 'pug-parser';

/**
 * Mail templates are Pug, and Pug compiles to JavaScript: a stored template
 * that carries code runs it in the API worker. Templates are therefore
 * checked against an allow-list before they are stored and before they are
 * compiled:
 *   - tags (except those that load or run external resources), text, plain
 *     HTML lines, comments, doctype, block expansion;
 *   - attributes whose value is a string literal, a boolean or a local;
 *   - escaped interpolation `#{LOCAL}` and `= LOCAL`, and `if` / `else if` /
 *     `else` / `unless` on a local;
 * where a local is a dotted identifier path (`USERNAME`, `user.name`) that
 * names no JavaScript global. Everything else (code lines, `!{}`, `!=`,
 * `include`, `extends`, blocks, mixins, filters, loops, `case`,
 * `&attributes`, interpolated tag names) is refused.
 *
 * The `type`, `lang` and `part` of a template become directory and file
 * names: each must match `^[a-z0-9-]+$`.
 */

export const SEGMENT_PATTERN = /^[a-z0-9-]+$/;

const LOCAL_PATH = /^[A-Za-z_][A-Za-z0-9_]*(\.[A-Za-z_][A-Za-z0-9_]*)*$/;
const FORBIDDEN_SEGMENTS = new Set(['constructor', '__proto__', 'prototype']);
const FORBIDDEN_ROOTS = new Set(['this', 'arguments', 'locals', 'self', 'require', 'module', 'exports',
  'process', 'global', 'globalThis']);
const STRING_LITERAL = /^(?:"(?:[^"\\\n]|\\.)*"|'(?:[^'\\\n]|\\.)*')$/;
const ATTRIBUTE_NAME = /^[A-Za-z_:][-A-Za-z0-9_:.]*$/;
// Tags whose content a renderer or a mail client would fetch or execute.
const FORBIDDEN_TAGS = new Set(['script', 'link', 'iframe', 'frame', 'frameset', 'object', 'embed', 'base', 'meta']);

// Token types that carry no expression.
const STRUCTURAL_TOKENS = new Set([
  'tag', 'text', 'text-html', 'newline', 'indent', 'outdent', 'eos', 'class', 'id',
  'start-attributes', 'end-attributes', 'start-pipeless-text', 'end-pipeless-text',
  'start-pug-interpolation', 'end-pug-interpolation', 'dot', 'slash', ':', 'comment',
  'doctype', 'else'
]);

type PugToken = {
  type: string;
  val?: unknown;
  name?: string;
  mustEscape?: boolean;
  buffer?: boolean;
  loc?: { start?: { line?: number } };
};

export type MailTemplateInput = { type: unknown; lang: unknown; part: unknown; pug: unknown };
export type ValidationResult = { ok: boolean; problems: string[] };

/** Why `value` cannot be a template path segment, or null. */
export function segmentProblem (name: string, value: unknown): string | null {
  if (typeof value === 'string' && SEGMENT_PATTERN.test(value)) return null;
  return `${name} ${JSON.stringify(value)} is invalid: use lowercase letters, digits and '-'`;
}

/** True when `expr` names a template local (and nothing else). */
export function isLocalPath (expr: unknown): boolean {
  if (typeof expr !== 'string') return false;
  const path = expr.trim();
  if (!LOCAL_PATH.test(path)) return false;
  const segments = path.split('.');
  const root = segments[0];
  if (FORBIDDEN_ROOTS.has(root) || root.startsWith('pug')) return false;
  // Undeclared names resolve to globals inside a compiled template.
  if (root in globalThis) return false;
  return !segments.some((s) => FORBIDDEN_SEGMENTS.has(s));
}

function isConditionOnLocal (expr: unknown): boolean {
  if (typeof expr !== 'string') return false;
  const e = expr.trim();
  const negated = /^!\((.*)\)$/.exec(e) ?? /^!(.*)$/.exec(e);
  return isLocalPath(negated != null ? negated[1] : e);
}

/** Problems found in a Pug source; empty when it is allowed. */
export function pugSourceProblems (pug: unknown): string[] {
  if (typeof pug !== 'string') return ['template source must be a string'];
  let tokens: PugToken[];
  try {
    tokens = pugLex(pug, { filename: 'template.pug' });
    // The parser consumes the array it is given.
    pugParse(tokens.slice(), { filename: 'template.pug', src: pug });
  } catch (err) {
    return ['template does not parse: ' + firstLine(err)];
  }
  const problems: string[] = [];
  for (const tok of tokens) {
    const problem = tokenProblem(tok);
    if (problem != null) problems.push(`line ${tok.loc?.start?.line ?? '?'}: ${problem}`);
  }
  return problems;
}

function tokenProblem (tok: PugToken): string | null {
  switch (tok.type) {
    case 'tag':
      if (typeof tok.val === 'string' && FORBIDDEN_TAGS.has(tok.val.toLowerCase())) return `tag '${tok.val}' is not allowed`;
      return null;
    case 'interpolated-code':
      if (tok.mustEscape !== true) return 'unescaped interpolation !{} is not allowed';
      return isLocalPath(tok.val) ? null : `interpolation of ${JSON.stringify(tok.val)} is not allowed (only a local, e.g. #{USERNAME})`;
    case 'code':
      if (tok.buffer !== true) return 'code lines are not allowed';
      if (tok.mustEscape !== true) return 'unescaped output != is not allowed';
      return isLocalPath(tok.val) ? null : `output of ${JSON.stringify(tok.val)} is not allowed (only a local)`;
    case 'attribute':
      if (typeof tok.name !== 'string' || !ATTRIBUTE_NAME.test(tok.name)) return `attribute name ${JSON.stringify(tok.name)} is not allowed`;
      if (tok.mustEscape !== true) return `unescaped attribute ${tok.name}!= is not allowed`;
      if (tok.val === true || tok.val === false) return null;
      if (typeof tok.val === 'string' && (STRING_LITERAL.test(tok.val.trim()) || isLocalPath(tok.val))) return null;
      return `attribute ${tok.name}=${JSON.stringify(tok.val)} is not allowed (use a string literal or a local)`;
    case 'if':
    case 'else-if':
      return isConditionOnLocal(tok.val) ? null : `condition ${JSON.stringify(tok.val)} is not allowed (only a local)`;
    default:
      if (STRUCTURAL_TOKENS.has(tok.type)) return null;
      return `'${tok.type}' is not allowed`;
  }
}

/** Check a template row (path segments and Pug source). */
export function validateMailTemplate (row: MailTemplateInput): ValidationResult {
  const problems: string[] = [];
  for (const [name, value] of [['type', row.type], ['lang', row.lang], ['part', row.part]] as const) {
    const problem = segmentProblem(name, value);
    if (problem != null) problems.push(problem);
  }
  problems.push(...pugSourceProblems(row.pug));
  return { ok: problems.length === 0, problems };
}

/** Throw an Error listing the problems when the template is not allowed. */
export function assertValidMailTemplate (row: MailTemplateInput): void {
  const { ok, problems } = validateMailTemplate(row);
  if (!ok) throw new Error(`mail template ${describe(row)} is not allowed: ${problems.join('; ')}`);
}

/** `type/lang/part` for messages (values JSON-quoted when not segments). */
export function describe (row: { type: unknown; lang: unknown; part: unknown }): string {
  return [row.type, row.lang, row.part]
    .map((v) => (typeof v === 'string' && SEGMENT_PATTERN.test(v) ? v : JSON.stringify(v)))
    .join('/');
}

function firstLine (err: unknown): string {
  const message = err instanceof Error ? err.message : String(err);
  return message.split('\n').find((l) => l.trim() !== '') ?? message;
}
