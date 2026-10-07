/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */

// Types for the parts of `pug-lexer` (5.x) and `pug-parser` (6.x), the lexer and
// parser `pug` compiles with (no published types), used by templateValidator.ts.
declare module 'pug-lexer' {
  type PugToken = {
    type: string;
    val?: unknown;
    name?: string;
    mustEscape?: boolean;
    buffer?: boolean;
    loc?: { start?: { line?: number; column?: number } };
  };
  /** Tokens of `src`; throws on a lexing error. */
  function lex (src: string, options?: { filename?: string }): PugToken[];
  export default lex;
}

declare module 'pug-parser' {
  /** AST of the tokens (consumes the array); throws on a parse error. */
  function parse (tokens: unknown[], options?: { filename?: string; src?: string }): unknown;
  export default parse;
}
