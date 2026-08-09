// =============================================================================
// scanQuadratic.guard.test.ts — タグ走査の小文字化コピーを「走査ごとに 1 回」に固定する
// =============================================================================
// `inlineCss.findRawTextEnd` と `security/templateScripts.rawTextEnd` は、raw text 要素の
// 終了タグを大小文字無視で探すために入力全体の小文字化コピーを使う。これを**関数の中**で
// 作ると、raw text 開始タグ 1 つにつき入力全体を 1 回コピーすることになる:
//   - `inlineCss` の `RAW_TEXT_ELEMENTS` には `title` が入るので `<title></title>` の反復が
//     最悪形(15 バイト/回)。1MB の本文で ~70,000 回の全長コピーになる。
//   - `templateScripts` は `scanOpenTags` と `rawTextOf` の双方から呼ぶので要素あたり 2 コピー。
// どちらも**同期区間**なので、1 リクエストでイベントループが恒久停止する = 編集も承認も
// ログインも止まる。到達経路は `POST /api/build`(viewer でも到達可)と
// `POST /api/review-requests`(`submitReview` の冒頭)。
//
// ⚠ 実時間を測るテストにはしない(マシン負荷で偽陽性/偽陰性になる)。主張するのは
// 「**小文字化コピーは走査 1 回につき 1 つだけ**」という構造で、ソースを機械検査する。
// 併せて、コピーを外へ出したあとも終端判定の意味が変わっていないことを振る舞いで固定する。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { collectExecutableUnits } from '../src/security/templateScripts.js';
import { scanTags } from '../src/vivliostyle/inlineCss.js';

const srcDir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'src');
const read = (rel: string): string => fs.readFileSync(path.join(srcDir, rel), 'utf8');

/**
 * コメントを落としたソース。数えたいのは**実行されるコピー**なので、同じ字面を含む
 * 解説文(「ここで `html.toLowerCase()` すると…」)は数から外す。
 */
const code = (rel: string): string =>
  read(rel)
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '');

describe('小文字化コピーは走査ごとに 1 回だけ', () => {
  it('inlineCss は `html.toLowerCase()` を 1 箇所でしか呼ばない', () => {
    const src = code('vivliostyle/inlineCss.ts');
    const calls = src.match(/\btoLowerCase\(\)/g) ?? [];
    // 走査全体ぶんの 1 回に加えて、タグ名/属性名/属性値といった**短い断片**の小文字化は
    // 残ってよい。禁じたいのは「入力全体のコピーをループの内側で作ること」なので、
    // 全長コピーの字面(`html.toLowerCase()`)そのものの出現数を固定する。
    expect(src.match(/\bhtml\.toLowerCase\(\)/g) ?? []).toHaveLength(1);
    expect(calls.length).toBeGreaterThan(1); // 断片の小文字化は健在
    // 1 箇所は `scanTags` の内側でなければならない(呼び出し側が作って渡す形)。
    const scanBody = src.slice(src.indexOf('export function scanTags'));
    expect(scanBody).toContain('const lower = html.toLowerCase();');
    // 終端探索の関数自身はコピーを作らない。
    const findBody = src.slice(
      src.indexOf('function findRawTextEnd'),
      src.indexOf('function parseAttrs'),
    );
    expect(findBody).not.toContain('toLowerCase()');
  });

  it('templateScripts は `text.toLowerCase()` を 1 箇所でしか呼ばない', () => {
    const src = code('security/templateScripts.ts');
    expect(src.match(/\btext\.toLowerCase\(\)/g) ?? []).toHaveLength(1);
    const collectBody = src.slice(src.indexOf('function collectInto'));
    expect(collectBody).toContain('const lower = text.toLowerCase();');
    const rawEndBody = src.slice(
      src.indexOf('function rawTextEnd'),
      src.indexOf('function* scanOpenTags'),
    );
    expect(rawEndBody).not.toContain('toLowerCase()');
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
