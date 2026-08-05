// =============================================================================
// noPostSanitizeSurgery.guard.test.ts — 「サニタイズの後段で HTML を切り貼りしない」ガード
// =============================================================================
// 前回の修正は DOMPurify を通すところまでは正しく、破れたのはその**直後の 3 行**だった。
// サニタイズ済み文字列へ `<link…>` 除去と `</head>` 挿入を正規表現で当てていたため、
// 属性値に置いた字面がマッチして要素のタグ終端まで食い、直後のテキストが `on*` 属性として
// 復活した。個別の入力に対するテストは「その入力」しか守れないので、**形そのもの**を
// ソース走査で禁じる。次に誰かが 1 行足したらここが落ちる。
//
// 不変則(`sanitizeHtml.ts` 冒頭に正典):
//   (I)  サニタイズが最後に喋る — 出力バイトを決めるのはサニタイザとその直列化。
//   (II) 「探す・切る」は DOM の上でだけ。文字列でよいのは*包む*(定数の連結)だけ。
//   (III) 直列化器は raw text をエスケープしない — `<style>` へ入れる値は事前に中和する。
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const WEB_SRC = path.resolve(HERE, '../src');
const SERVER_SRC = path.resolve(HERE, '../../server/src');

/** 文書の組み立て・加工を担うファイル。ここへ文字列手術が生えたら即座に穴になる。 */
const GUARDED = [
  path.join(WEB_SRC, 'lib/nunjucksRender.ts'),
  path.join(WEB_SRC, 'lib/cropMarks.ts'),
  path.join(WEB_SRC, 'lib/pdfDocument.ts'),
  path.join(WEB_SRC, 'lib/sanitizeHtml.ts'),
  path.join(WEB_SRC, 'lib/previewSelfContain.ts'),
  path.join(WEB_SRC, 'features/compare/htmlBlockDiff.ts'),
  path.join(SERVER_SRC, 'vivliostyle/inlineCss.ts'),
  path.join(SERVER_SRC, 'vivliostyle/inlineDocScripts.ts'),
];

/**
 * HTML を正規表現で切り貼りする形。`[^>]*` は引用符を越えるので、属性値の中から始まった
 * span が要素のタグ終端を食う。コメント中の説明文には現れない「コード上の形」だけを見る。
 */
const SURGERY_PATTERNS: Array<[string, RegExp]> = [
  ['replace(/<…', /\.replace\(\s*\/</],
  ['search(/<…', /\.search\(\s*\/</],
  ['match(/<…', /\.match\(\s*\/</],
  ['split(/<…', /\.split\(\s*\/</],
  ["indexOf('<…", /\.indexOf\(\s*['"]</],
  ['new RegExp("<…', /new RegExp\(\s*[`'"]</],
];

describe('サニタイズ後段の文字列手術ガード', () => {
  it('走査対象のファイルを実際に読めている(セルフテスト)', () => {
    // 読めていないと以下が素通りして「常に緑」になる。
    for (const file of GUARDED) expect(readFileSync(file, 'utf8').length).toBeGreaterThan(200);
  });

  it.each(GUARDED)('%s に HTML の切り貼りが無い', (file) => {
    const source = readFileSync(file, 'utf8');
    const hits = SURGERY_PATTERNS.filter(([, re]) => re.test(source)).map(([label]) => label);
    expect(hits, `${path.basename(file)} に文字列手術: ${hits.join(', ')}`).toEqual([]);
  });

  it('プレビュー文書の組み立てが DOM 経路のままである', () => {
    // 「サニタイズ済み文字列を受け取って加工する」形へ戻ると、この 3 つが消える。
    const source = readFileSync(path.join(WEB_SRC, 'lib/nunjucksRender.ts'), 'utf8');
    expect(source).toContain('sanitizePreviewRoot');
    expect(source).toContain('appendPreviewStyle');
    expect(source).toContain('serializePreviewRoot');
  });

  it('CSS の </style> 中和が DOM 経路でも残っている', () => {
    // 「DOM で組んだからもう要らない」と外す PR が来たらここが落ちる。直列化器は
    // `<style>` の raw text をエスケープしないので、外すと脱出が即座に復活する。
    const source = readFileSync(path.join(WEB_SRC, 'lib/sanitizeHtml.ts'), 'utf8');
    expect(source).toContain('sanitizeStyleContent');
  });

  it('サーバの inline 展開がタグ走査を経てから切っている', () => {
    // `scanTags` を通さずに slice する形へ戻ると、span 食いが復活する。
    const source = readFileSync(path.join(SERVER_SRC, 'vivliostyle/inlineCss.ts'), 'utf8');
    expect(source).toContain('scanTags');
  });
});
