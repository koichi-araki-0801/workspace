// =============================================================================
// scanQuadratic.guard.test.ts — タグ走査の小文字化コピーを「走査ごとに 1 回」に固定する
// =============================================================================
// `inlineCss.scanTags` と `security/templateScripts.rawTextEnd` は、raw text 要素の終了タグを
// 大小文字無視で探すために入力全体の小文字化コピー(`asciiLower`)を使い、共有の終わり探し
// (`shared/src/html/rawText.ts` の `findRawTextEnd`)へ渡す。これを**関数の中**で
// 作ると、raw text 開始タグ 1 つにつき入力全体を 1 回コピーすることになる:
//   - `inlineCss` の `INLINE_CSS_RAW_TEXT` には `title` が入るので `<title></title>` の反復が
//     最悪形(15 バイト/回)。1MB の本文で ~70,000 回の全長コピーになる。
//   - `templateScripts` は `scanOpenTags` と `rawTextOf` の双方から呼ぶので要素あたり 2 コピー。
// どちらも**同期区間**なので、1 リクエストでイベントループが恒久停止する = 編集も承認も
// ログインも止まる。到達経路は `POST /api/build`(viewer でも到達可)と
// `POST /api/review-requests`(`submitReview` の冒頭)。
//
// ⚠ 実時間を測るテストにはしない(マシン負荷で偽陽性/偽陰性になる)。主張するのは
// 「**小文字化コピーは走査 1 回につき 1 つだけ**」という構造で、ソースを機械検査する。
// 写しの作り方(`asciiLower`)も同じく固定する。
// 併せて、コピーを外へ出したあとも終端判定の意味が変わっていないことを振る舞いで固定する。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { collectExecutableUnits } from '../src/security/templateScripts.js';
import { scanTags } from '../src/vivliostyle/inlineCss.js';

const testDir = path.dirname(fileURLToPath(import.meta.url));
const srcDir = path.join(testDir, '..', 'src');
const sharedSrcDir = path.join(testDir, '..', '..', 'shared', 'src');
const read = (rel: string, dir = srcDir): string => fs.readFileSync(path.join(dir, rel), 'utf8');

/**
 * コメントを落としたソース。数えたいのは**実行されるコピー**なので、同じ字面を含む
 * 解説文(「ここで `html.toLowerCase()` すると…」)は数から外す。
 */
const code = (rel: string, dir = srcDir): string =>
  read(rel, dir)
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '');

describe('小文字化コピーは走査ごとに 1 回だけ', () => {
  // 入力全体の小文字の写しは、位置が原文とずれない `asciiLower` で作る(`toLowerCase` は `İ` を
  // 2 単位へ伸ばし、写しの上の位置を原文に使うと閉じタグの後ろの本物のタグを見落とす)。
  // 全体の `toLowerCase()` が戻ってこないことも、ここで字面ごと固定する。
  const WHOLE_LOWER = /\b(?:html|text|masked|lower)\.toLowerCase\(\)/;

  it('inlineCss は `asciiLower(html)` を `scanTags` の中で 1 回だけ呼ぶ', () => {
    const src = code('vivliostyle/inlineCss.ts');
    expect(src.match(/\basciiLower\(/g) ?? []).toHaveLength(1);
    expect(src).not.toMatch(WHOLE_LOWER);
    // タグ名・属性値といった**短い断片**の小文字化は残ってよい。
    expect((src.match(/\btoLowerCase\(\)/g) ?? []).length).toBeGreaterThan(0);
    const scanBody = src.slice(src.indexOf('export function scanTags'));
    expect(scanBody).toContain('const lower = asciiLower(html);');
    // 終端探索は共有の関数を使い、その関数自身はコピーを作らない。
    expect(scanBody).toContain('findRawTextEnd(lower,');
    expect(src).not.toMatch(/function findRawTextEnd/);
  });

  it('共有の終わり探し `findRawTextEnd` は小文字化コピーを作らない', () => {
    const src = code('html/rawText.ts', sharedSrcDir);
    const findBody = src.slice(src.indexOf('export function findRawTextEnd'));
    expect(findBody).toContain('lower.indexOf(');
    expect(findBody).not.toContain('toLowerCase()');
    expect(findBody).not.toContain('asciiLower(');
  });

  it('templateScripts は `asciiLower(text)` を `collectInto` の中で 1 回だけ呼ぶ', () => {
    const src = code('security/templateScripts.ts');
    expect(src.match(/\basciiLower\(/g) ?? []).toHaveLength(1);
    expect(src).not.toMatch(WHOLE_LOWER);
    const collectBody = src.slice(src.indexOf('function collectInto'));
    expect(collectBody).toContain('const lower = asciiLower(text);');
    const rawEndBody = src.slice(
      src.indexOf('function rawTextEnd'),
      src.indexOf('function* scanOpenTags'),
    );
    expect(rawEndBody).not.toContain('toLowerCase()');
    expect(rawEndBody).not.toContain('asciiLower(');
    expect(rawEndBody).toContain('findRawTextEnd(lower,');
  });
});

describe('コピーを外へ出しても終端判定は変わらない', () => {
  it('inlineCss: 大文字の終了タグを終端として認め、名前の前方一致では切らない', () => {
    const { tags, ok } = scanTags('<STYLE>a{}</STYLE><p>x</p>');
    expect(ok).toBe(true);
    expect(tags.find((t) => t.name === 'style' && !t.isEnd)?.rawText).toBe('a{}');
    // `</stylex>` は終了タグではない(直後の文字が空白 / `/` / `>` でないため)。
    const partial = scanTags('<style>a{}</stylex>b{}</style>');
    expect(partial.ok).toBe(true);
    expect(partial.tags.find((t) => t.name === 'style' && !t.isEnd)?.rawText).toBe(
      'a{}</stylex>b{}',
    );
  });

  it('templateScripts: `</SCRIPT>` で閉じ、`</scriptx>` では閉じない', () => {
    expect(collectExecutableUnits('<SCRIPT>init()</SCRIPT>')).toEqual(['script:|init()']);
    expect(collectExecutableUnits('<script>init()</scriptx>/;evil()</script>')).toEqual([
      'script:|init()</scriptx>/;evil()',
    ]);
  });

  it('raw text 要素を大量に含む入力でも走査結果が正しい(病的入力の回帰)', () => {
    const html = '<title></title>'.repeat(2000);
    const { tags, ok } = scanTags(html);
    expect(ok).toBe(true);
    expect(tags.filter((t) => t.name === 'title' && !t.isEnd)).toHaveLength(2000);
    expect(collectExecutableUnits('<style></style>'.repeat(2000))).toEqual([]);
  });
});
