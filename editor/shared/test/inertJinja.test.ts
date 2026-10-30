import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { isInertJinjaToken } from '../src/jinja/inertJinja';
import { type JinjaToken, lexJinja } from '../src/jinja/jinjaLex';

const FIXTURES = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../fixtures');

/** 1 トークンだけの原文を字句解析して判定する。 */
function inert(source: string): boolean {
  const r = lexJinja(source);
  if (!r.ok || r.tokens.length < 1) throw new Error(`読めない: ${source}`);
  return isInertJinjaToken(r.tokens[0] as JinjaToken);
}

describe('isInertJinjaToken — テキストの位置で不活性とみなす形', () => {
  it.each([
    '{{ fund.name }}',
    '{{ note|safe }}',
    '{{ x|default("—") }}',
    '{{ d["k"] }}',
    '{{ loop.index }}',
    '{{ range(3) }}',
    '{{- fund.name -}}',
    '{% if a > b %}',
    '{% elif fund.code == "950037" %}',
    '{% else %}',
    '{% endif %}',
    '{% for h in holdings %}',
    '{% for a, b in pairs %}',
    '{% for h in holdings|selectattr("show") %}',
    '{% endfor %}',
    '{% set n = 1 %}',
    '{% set total = fund.total %}',
    '{# 説明のコメント #}',
    '{% raw %}x{% endraw %}',
  ])('%s', (src) => {
    expect(inert(src)).toBe(true);
  });

  it('{% endraw %} も不活性', () => {
    const r = lexJinja('{% raw %}x{% endraw %}');
    expect(r.ok && r.tokens.map((t) => isInertJinjaToken(t))).toEqual([true, true]);
  });
});

describe('isInertJinjaToken — 不活性でない形', () => {
  it.each([
    ['< を出すリテラル', '{{ "<"|safe }}'],
    [': を含むリテラル', '{{ "a:b" }}'],
    ['エスケープで < を書くリテラル', '{{ "\\x3c" }}'],
    ['書式で文字を作る', '{{ "%c" % 60 }}'],
    ['_ で始まるメンバ', '{{ x.__class__ }}'],
    ['_ で始まる名前', '{{ _secret }}'],
    ['_ を含む添字の文字列', '{{ x["__class__"] }}'],
    ['namespace の出力', '{{ namespace(a=1) }}'],
    ['select の出力', '{{ xs|select("x") }}'],
    ['batch の出力', '{{ xs|batch(2) }}'],
    ['slice の出力', '{{ xs|slice(2) }}'],
    ['loop をそのまま出す', '{{ loop }}'],
    ['ブロックの set', '{% set lt %}'],
    ['namespace を束ねる set', '{% set ns = namespace(total=0) %}'],
    ['< を束ねる set', '{% set lt = "<" %}'],
    ['include', '{% include "a" %}'],
    ['macro', '{% macro m() %}'],
    ['filter', '{% filter upper %}'],
    ['for … if', '{% for x in xs if x %}'],
    ['for … recursive', '{% for x in xs recursive %}'],
    ['反復の対象のリテラルに <', '{% for lt in ["<"] %}'],
    ['読めない for', '{% for in xs %}'],
    ['verbatim', '{% verbatim %}x{% endverbatim %}'],
    ['未知の文', '{% do xs.append(1) %}'],
    ['キーワードの後ろに余計な字のある else', '{% else x %}'],
    ['条件の無い if', '{% if %}'],
  ])('%s: %s', (_label, src) => {
    expect(inert(src)).toBe(false);
  });
});

describe('fixture のテキストの位置の Jinja はすべて不活性', () => {
  // 作成タブで fixture のパーツを挿入しただけで不変ゲートが拒否する形になっていないことを固定する。
  const templates = readdirSync(path.join(FIXTURES, 'templates')).filter((f) =>
    f.endsWith('.html'),
  );
  const parts = JSON.parse(readFileSync(path.join(FIXTURES, 'parts.json'), 'utf8')) as {
    id: string;
    content: string;
  }[];
  const sources: [string, string][] = [
    ...templates.map(
      (f) => [f, readFileSync(path.join(FIXTURES, 'templates', f), 'utf8')] as [string, string],
    ),
    ...parts.map((p) => [p.id, p.content] as [string, string]),
  ];

  it.each(sources)('%s', (_name, html) => {
    const r = lexJinja(html);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    // 文脈で絞らず全トークンを見る(属性値の中の `data-rank="{{ loop.index }}"` も不活性の形)。
    // 文脈ごとの単位の数は `server/test/templateScripts.test.ts` が fixture で固定している。
    expect(r.tokens.filter((t) => !isInertJinjaToken(t)).map((t) => t.source)).toEqual([]);
  });
});
