// =============================================================================
// requestCss.guard.test.ts — リクエスト CSS の付け替えは入口で 1 回だけ、の配線を固定する
// =============================================================================
// リクエスト CSS の付け替え(`rebaseCssForDoc`)は入口で 1 回だけ掛ける。関数自体は冪等だが、
// 付け替えの場所が散ると「どの CSS が `css/` 基準の原文で、どれが `doc/` 基準の付け替え済みか」が
// 経路ごとに割れ、外部参照の検査や資産の洗い出しが付け替え前の形を見る取り違えが起きる。
// 個々の入力ではなく呼び出しの形が不変則なので、ソース走査で固定する。
import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.resolve(HERE, '../src');

function sourceFiles(dir: string): string[] {
  const found: string[] = [];
  for (const name of readdirSync(dir)) {
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) found.push(...sourceFiles(full));
    else if (name.endsWith('.ts')) found.push(full);
  }
  return found;
}

const stripComments = (s: string): string =>
  s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');

const ALL = sourceFiles(SRC).map((f) => ({ f, code: stripComments(readFileSync(f, 'utf8')) }));
const rel = (f: string): string => path.relative(SRC, f).replace(/\\/g, '/');

describe('リクエスト CSS の付け替えの配線', () => {
  it('rebaseCssForDoc を使うのは requestCss.ts だけ', () => {
    const users = ALL.filter(({ code }) => /\brebaseCssForDoc\b/.test(code)).map(({ f }) => rel(f));
    expect(users).toEqual(['vivliostyle/requestCss.ts']);
  });

  it('rebaseRequestCss を呼ぶのは build.ts の 3 入口だけ', () => {
    const callers = ALL.filter(({ f }) => rel(f) !== 'vivliostyle/requestCss.ts')
      .filter(({ code }) => /\brebaseRequestCss\(/.test(code))
      .map(({ f }) => rel(f));
    expect(callers).toEqual(['vivliostyle/build.ts']);
    const build = ALL.find(({ f }) => rel(f) === 'vivliostyle/build.ts')?.code ?? '';
    expect(build.match(/\brebaseRequestCss\(/g)).toHaveLength(3);
  });

  it('付け替えは外部参照検査より前', () => {
    const build = ALL.find(({ f }) => rel(f) === 'vivliostyle/build.ts')?.code ?? '';
    for (const label of ['build.inline', 'preview.inline', 'build.merge']) {
      const check = build.indexOf(label);
      expect(check).toBeGreaterThan(-1);
      const fnStart = build.lastIndexOf('function', check);
      expect(build.slice(fnStart, check)).toMatch(/rebaseRequestCss\(/);
    }
  });
});
