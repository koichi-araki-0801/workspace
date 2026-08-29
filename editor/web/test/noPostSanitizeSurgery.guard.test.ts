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
import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const EDITOR_ROOT = path.resolve(HERE, '../..');
const WEB_SRC = path.resolve(HERE, '../src');
const SERVER_SRC = path.resolve(HERE, '../../server/src');

/**
 * 文書の組み立て・加工が住むディレクトリ。ファイル名の固定列挙をやめたのは、ここへ加工の
 * ファイルを 1 つ足したときに列挙へ書き忘れると「新しいファイルだけ検査されない」形で
 * 無言に漏れ、しかも緑のままになるため(このガード自体が「次に 1 行足したら落ちる」ことを
 * 目的にしているので、対象の取りこぼしは目的の否定になる)。
 */
const SCAN_DIRS = [
  path.join(WEB_SRC, 'lib'),
  path.join(WEB_SRC, 'features/compare'),
  path.join(SERVER_SRC, 'vivliostyle'),
];

/**
 * 除外。**「引っかかったから外す」ではなく、外してよい理由を書けるものだけ**をここへ置く。
 * キーは `editor/` からの相対パス。
 */
const EXCLUDED = new Map<string, string>([
  [
    'web/src/lib/jinjaMask.ts',
    '1 文字のエスケープ(`<` → `&lt;`)であり、タグを探して切る形ではない',
  ],
  [
    'server/src/vivliostyle/previewHost.ts',
    '定数ホストページを inline してよいかを fail closed で判定するだけで、文字列を書き換えない',
  ],
]);

/** 走査対象の `.ts` を再帰列挙し、`editor/` 相対キーとの対で返す。 */
function scanTargets(): Array<{ key: string; file: string }> {
  const out: Array<{ key: string; file: string }> = [];
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      const full = path.join(dir, name);
      if (statSync(full).isDirectory()) walk(full);
      else if (name.endsWith('.ts')) {
        const key = path.relative(EDITOR_ROOT, full).replace(/\\/g, '/');
        if (!EXCLUDED.has(key)) out.push({ key, file: full });
      }
    }
  };
  for (const dir of SCAN_DIRS) walk(dir);
  return out.sort((a, b) => a.key.localeCompare(b.key));
}

const GUARDED = scanTargets();

/** 走査が本来の中心を外していないことを固定する(除外の書きすぎ・パス変更の検知)。 */
const MUST_BE_SCANNED = [
  'web/src/lib/nunjucksRender.ts',
  'web/src/lib/cropMarks.ts',
  'web/src/lib/pdfDocument.ts',
  'web/src/lib/sanitizeHtml.ts',
  'web/src/lib/templateDoc.ts',
  'web/src/lib/previewSelfContain.ts',
  'web/src/features/compare/htmlBlockDiff.ts',
  'server/src/vivliostyle/inlineCss.ts',
  'server/src/vivliostyle/inlineDocScripts.ts',
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
    expect(GUARDED.length).toBeGreaterThanOrEqual(MUST_BE_SCANNED.length);
    for (const { file } of GUARDED) expect(readFileSync(file, 'utf8').length).toBeGreaterThan(80);
  });

  it('中心となる加工ファイルが走査から漏れていない(除外の書きすぎ検知)', () => {
    const keys = new Set(GUARDED.map((g) => g.key));
    const missing = MUST_BE_SCANNED.filter((k) => !keys.has(k));
    expect(missing, `走査から漏れたファイル: ${missing.join(', ')}`).toEqual([]);
  });

  it.each(GUARDED.map((g) => [g.key, g.file]))('%s に HTML の切り貼りが無い', (key, file) => {
    const source = readFileSync(file, 'utf8');
    const hits = SURGERY_PATTERNS.filter(([, re]) => re.test(source)).map(([label]) => label);
    expect(hits, `${key} に文字列手術: ${hits.join(', ')}`).toEqual([]);
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
