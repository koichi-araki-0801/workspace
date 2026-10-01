// =============================================================================
// requestCss.guard.test.ts — リクエスト CSS の付け替えは入口で 1 回だけ、の配線を固定する
// =============================================================================
// `rebaseCssUrls` は冪等ではない。2 か所で掛かると `css/css/fonts/…` になって
// フォントが黙って消える(実体の無い参照は inlineCss が落とすのでエラーにならない)。
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
  it('rebaseCssUrls を使うのは requestCss.ts だけ', () => {
    const users = ALL.filter(({ code }) => /\brebaseCssUrls\b/.test(code)).map(({ f }) => rel(f));
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
