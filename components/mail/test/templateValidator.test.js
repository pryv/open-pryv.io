/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */

import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const {
  validateMailTemplate, pugSourceProblems, segmentProblem, isLocalPath
} = require('../src/templateValidator.ts');

const BUNDLED = path.resolve(path.dirname(new URL(import.meta.url).pathname), '../templates');

function bundledRows () {
  const rows = [];
  for (const type of fs.readdirSync(BUNDLED)) {
    for (const lang of fs.readdirSync(path.join(BUNDLED, type))) {
      for (const file of fs.readdirSync(path.join(BUNDLED, type, lang))) {
        if (!file.endsWith('.pug')) continue;
        rows.push({ type, lang, part: file.replace(/\.pug$/, ''), pug: fs.readFileSync(path.join(BUNDLED, type, lang, file), 'utf8') });
      }
    }
  }
  return rows;
}

describe('[MTVA] mail template validator', () => {
  it('[MTVA1] accepts every template shipped with the mail component', () => {
    const rows = bundledRows();
    assert.ok(rows.length >= 16, 'the bundled set is found: ' + rows.length);
    for (const row of rows) {
      const { ok, problems } = validateMailTemplate(row);
      assert.ok(ok, `${row.type}/${row.lang}/${row.part}: ${problems.join('; ')}`);
    }
  });

  it('[MTVA2] accepts tags, text, literal and local attributes, escaped interpolation of locals and conditionals on locals', () => {
    const src = [
      'doctype html',
      '//- a comment',
      'h1.title#main Hello #{USERNAME}, #{user.name}',
      'p= USERNAME',
      'p',
      '  a(href=VERIFY_LINK target="_blank" rel=\'noopener\' download) link',
      '  | text #[strong #{EMAIL}]',
      'if SHOW_CODE',
      '  code #{CODE}',
      'else if other.flag',
      '  p other',
      'else',
      '  p none',
      'unless HIDE',
      '  p shown',
      'ul',
      '  li: a(href=ITEM_URL) item',
      'p.',
      '  plain block text',
      '<b>inline html</b>'
    ].join('\n');
    assert.deepStrictEqual(pugSourceProblems(src), []);
  });

  const FORBIDDEN = {
    'unbuffered code line': '- var x = 1\np= x',
    'unescaped interpolation': 'p !{USERNAME}',
    'unescaped output': 'p!= USERNAME',
    'expression output': 'p= USERNAME.toUpperCase()',
    'global in interpolation': 'p #{process.env.SECRET}',
    'global root in output': 'p= Function',
    'call in interpolation': 'p #{USERNAME()}',
    'prototype walk': 'p #{USERNAME.constructor.constructor}',
    include: 'include /etc/passwd',
    extends: 'extends layout',
    block: 'block content\n  p x',
    'mixin definition': 'mixin m\n  p x',
    'mixin call': '+m',
    filter: ':markdown\n  # x',
    'each loop': 'each v in LIST\n  p= v',
    'while loop': 'while X\n  p x',
    case: 'case X\n  when 1\n    p one',
    '&attributes': 'div&attributes(ATTRS)',
    'interpolated tag name': '#{TAG} x',
    'attribute expression': "a(href=LINK + '?x=1') x",
    'unescaped attribute': 'a(href!=LINK) x',
    'template-literal attribute': 'a(href=`${process.env.X}`) x', // eslint-disable-line no-template-curly-in-string
    'condition with a call': 'if check()\n  p x',
    'condition with a global': 'if process.env.X\n  p x',
    'script tag': 'script alert(1)',
    'link tag': 'link(rel="stylesheet" href="/etc/passwd")',
    'syntax error': 'p(href="x"'
  };
  for (const [label, src] of Object.entries(FORBIDDEN)) {
    it(`[MTVA3] refuses: ${label}`, () => {
      const problems = pugSourceProblems(src);
      assert.ok(problems.length > 0, `${label} must be refused: ${JSON.stringify(src)}`);
    });
  }

  it('[MTVA4] refuses type / lang / part segments outside ^[a-z0-9-]+$', () => {
    const good = { type: 'welcome-email', lang: 'en', part: 'html', pug: 'p Hi' };
    assert.deepStrictEqual(validateMailTemplate(good), { ok: true, problems: [] });
    for (const [key, value] of [['type', '../../etc'], ['type', 'a/b'], ['lang', 'EN'], ['lang', '..'],
      ['part', 'html.pug'], ['part', ''], ['type', 'x%2Fy'], ['lang', null]]) {
      const { ok, problems } = validateMailTemplate({ ...good, [key]: value });
      assert.strictEqual(ok, false, `${key}=${JSON.stringify(value)}`);
      assert.match(problems[0], new RegExp('^' + key + ' '));
    }
    assert.strictEqual(segmentProblem('lang', 'pt-br'), null);
  });

  it('[MTVA5] a local is a dotted identifier path that names no global', () => {
    for (const ok of ['USERNAME', 'user.name', 'CODE_MAX_AGE_MINUTES', 'token']) assert.ok(isLocalPath(ok), ok);
    for (const bad of ['process', 'globalThis', 'require', 'this', 'locals', 'pug_mixins', 'Buffer', 'URL', 'a.__proto__',
      'a.prototype', 'a[0]', 'a b', '1a', '']) {
      assert.ok(!isLocalPath(bad), bad);
    }
  });
});
