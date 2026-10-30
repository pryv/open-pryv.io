/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */

/**
 * A toy OAuth extension for the cores a multi-core suite boots in child
 * processes (`customExtensions:oauthExtension`, see core-process.js):
 * `read/<s>` reads one stream; `ctx/user` puts the subject in the token
 * response; `ctx/pseudo` asks for a pseudonym.
 */
module.exports = function toyOAuthExtension () {
  return {
    apiVersion: 1,
    name: 'toy-multicore',
    scopeGrammar: {
      parse (scopeString) {
        const tokens = [...new Set(scopeString.split(/\s+/).filter((t) => t !== ''))];
        const permissions = [];
        for (const t of tokens) {
          if (t === 'ctx/user' || t === 'ctx/pseudo') continue;
          if (!t.startsWith('read/')) return { ok: false, description: 'unknown token ' + t };
          permissions.push({ streamId: t.slice('read/'.length), level: 'read' });
        }
        return { ok: true, tokens, offer: { permissions, randomAlias: tokens.includes('ctx/pseudo') } };
      },
      echo ({ permissions, requestedTokens }) {
        return requestedTokens.filter((t) => t === 'ctx/user' || t === 'ctx/pseudo' ||
          permissions.some((p) => p.level === 'read' && 'read/' + p.streamId === t));
      },
    },
    tokenResponse: (ctx) => (ctx.scopeTokens.includes('ctx/user') ? { user: ctx.subject } : {}),
  };
};
