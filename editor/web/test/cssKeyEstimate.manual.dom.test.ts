import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve, sep } from 'node:path';
import { canonicalCssRuleKeys, foldedCssRuleTexts, splitCssRules } from '@editor/shared';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { useGrapes } from '@/features/editor/useGrapes';

vi.mock('@/components/ui/toast', () => ({ toast: vi.fn(), toastError: vi.fn() }));

// =============================================================================
// cssKeyEstimate.manual.dom.test.ts — 既存の CSS で照合不可になりうる規則の数(手動・読み取り専用)
// =============================================================================
// 新しい正規化のあとで、既存データの CSS が編集されたとき照合不可の競合になりうる規則が
// いくつあるかを見積もる。`CSS_KEY_ESTIMATE_DIR` が無ければ丸ごと飛ぶので、通常のテスト実行と
// CI では走らない。`config.ts` も `DATA_ROOT` の中身も読まない(`DATA_ROOT` は取り違え検査の
// ためにパスだけ見る)。`<dataRoot>/css` の「コピー」を渡す。書くのは `CSS_KEY_ESTIMATE_OUT`
// (リポジトリとデータの外の、まだ無いパス)の JSON だけ。
// 守る本物の置き場は `DATA_ROOT` とサーバの既定(`../../editor-data`)。`appconfig.json` の
// `paths.dataRoot` で移した場所は検出できない(限界)。出力先は data ルート・入力の配下と既存ファイルを
// 拒む。「重複の疑い」はファイルごとに数え、ペアの表では合計する。
// jsdom の CSSOM はブラウザのような書き直し(`>` の空白・引用符など)をしないので、数は下限。
//   CSS_KEY_ESTIMATE_DIR=<コピー先> pnpm exec vitest run --project web-dom \
//     editor/web/test/cssKeyEstimate.manual.dom.test.ts

const DIR = process.env.CSS_KEY_ESTIMATE_DIR;
const OUT = process.env.CSS_KEY_ESTIMATE_OUT;

/** 比較用に実体のパスへ直し、Windows では大文字小文字を区別しない形にする。 */
function norm(p: string): string {
  const real = realpathSync.native(resolve(p));
  return process.platform === 'win32' ? real.toLowerCase() : real;
}

/** 存在する最も近い祖先で実体化してから残りをつなぐ(まだ無い出力先のパス用)。 */
function normNearest(p: string): string {
  let cur = resolve(p);
  const rest: string[] = [];
  while (!existsSync(cur)) {
    rest.unshift(basename(cur));
    const up = dirname(cur);
    if (up === cur) break;
    cur = up;
  }
  const real = norm(cur);
  return rest.length === 0
    ? real
    : join(real, ...rest.map((r) => (process.platform === 'win32' ? r.toLowerCase() : r)));
}

function isUnder(child: string, root: string): boolean {
  return child === root || child.startsWith(root.endsWith(sep) ? root : root + sep);
}

/** サーバの既定の data ルート(`config.ts` の `../../editor-data`。repoRoot = `editor/`)。 */
const SERVER_DEFAULT_DATA_ROOT = resolve(
  import.meta.dirname,
  '..',
  '..',
  '..',
  '..',
  'editor-data',
);

/**
 * 触ってはいけない本物の data ルート: 環境変数 `DATA_ROOT` と、サーバの既定の置き場。
 * `appconfig.json` の `paths.dataRoot` で移した場所は `config.ts` を読まない方針なので検出できない
 * (その場合も、コピーを渡す運用で守る)。
 */
function guardedRoots(env: NodeJS.ProcessEnv, defaultRoot = SERVER_DEFAULT_DATA_ROOT) {
  return [env.DATA_ROOT, defaultRoot].filter((r): r is string => !!r && existsSync(r));
}

/** 入力が本物の data ルートの配下なら落とす。 */
function assertInputNotUnderDataRoot(dir: string, roots: string[]): void {
  const d = norm(dir);
  for (const root of roots) {
    if (isUnder(d, norm(root))) {
      throw new Error(
        `CSS_KEY_ESTIMATE_DIR(${dir})が data ルート(${root})の配下です。コピーを渡してください。`,
      );
    }
  }
}

/** 出力先が data ルート・入力フォルダの配下、または既存ファイルなら落とす。 */
function assertOutSafe(out: string, dir: string, roots: string[]): void {
  const target = normNearest(out);
  const outDir = dirname(target);
  for (const root of [...roots, dir]) {
    if (isUnder(outDir, norm(root))) {
      throw new Error(
        `CSS_KEY_ESTIMATE_OUT(${out})が ${root} の配下です。リポジトリとデータの外のパスを渡してください。`,
      );
    }
  }
  if (existsSync(out)) {
    throw new Error(
      `CSS_KEY_ESTIMATE_OUT(${out})は既にあります。上書きしません。別のパスを渡してください。`,
    );
  }
}

interface FileRow {
  file: string;
  rules: number;
  /** getCss 側にしか無いキー(編集されると照合不可になる規則)。 */
  unmatched: number;
  unmatchedKeys: string[];
  /** 並びを展開すると複数キーになる規則(片方だけ編集されるとペア側で分割される)。 */
  expandedLists: number;
  /** 新しい正規化で同じキーになるが本文が違う規則の組の数(黙った追記の疑い)。ファイルごとに数え、ペアでは合計する。 */
  dupSuspects: number;
}

/** 出現番号を外した新しいキーごとに、本文(宣言ブロック)が互いに違う規則の組を数える。 */
function countDupSuspects(css: string): number {
  const bodies = new Map<string, Set<string>>();
  for (const r of splitCssRules(css)) {
    const body = r.text.slice(r.text.indexOf('{')).replace(/\s+/g, ' ').trim();
    for (const k of canonicalCssRuleKeys(r.key)) {
      const parts = JSON.parse(k) as unknown[];
      if (typeof parts[parts.length - 1] === 'number') parts.pop();
      const id = JSON.stringify(parts);
      bodies.set(id, (bodies.get(id) ?? new Set()).add(body));
    }
  }
  return [...bodies.values()].filter((s) => s.size >= 2).length;
}

function estimate(file: string, css: string): FileRow {
  const g = useGrapes();
  g.init({ canvas: document.createElement('div'), layers: document.createElement('div') });
  try {
    g.load('<div></div>', css);
    const rawKeys = new Set(foldedCssRuleTexts(css).keys());
    const unmatchedKeys = [...foldedCssRuleTexts(g.getCss()).keys()].filter((k) => !rawKeys.has(k));
    return {
      file,
      rules: rawKeys.size,
      unmatched: unmatchedKeys.length,
      unmatchedKeys,
      expandedLists: splitCssRules(css).filter((r) => canonicalCssRuleKeys(r.key).length > 1)
        .length,
      dupSuspects: countDupSuspects(css),
    };
  } finally {
    g.destroy();
  }
}

describe('取り違えの検査', () => {
  const tmp = mkdtempSync(join(tmpdir(), 'css-est-'));
  const real = join(tmp, 'real-data');
  const copy = join(tmp, 'copy');
  mkdirSync(join(real, 'css'), { recursive: true });
  mkdirSync(copy);
  afterAll(() => rmSync(tmp, { recursive: true, force: true }));

  it('環境変数 DATA_ROOT と既定の置き場の両方を守る', () => {
    expect(guardedRoots({ DATA_ROOT: real }, join(tmp, 'none'))).toEqual([real]);
    expect(guardedRoots({}, real)).toEqual([real]);
    expect(guardedRoots({}, join(tmp, 'none'))).toEqual([]);
    expect(SERVER_DEFAULT_DATA_ROOT.endsWith('editor-data')).toBe(true);
  });

  it('入力が data ルートの配下なら落ち、コピーは通る', () => {
    expect(() => assertInputNotUnderDataRoot(join(real, 'css'), [real])).toThrow('コピーを渡して');
    expect(() => assertInputNotUnderDataRoot(real, [real])).toThrow('コピーを渡して');
    expect(() => assertInputNotUnderDataRoot(copy, [real])).not.toThrow();
  });

  it('出力先が data ルート・入力の配下、または既存ファイルなら落ちる', () => {
    expect(() => assertOutSafe(join(real, 'new', 'o.json'), copy, [real])).toThrow('配下');
    expect(() => assertOutSafe(join(copy, 'o.json'), copy, [real])).toThrow('配下');
    const existing = join(tmp, 'existing.json');
    writeFileSync(existing, '{}');
    expect(() => assertOutSafe(existing, copy, [real])).toThrow('上書きしません');
    expect(() => assertOutSafe(join(tmp, 'sub', 'o.json'), copy, [real])).not.toThrow();
  });
});

describe.skipIf(!DIR)('既存 CSS の照合キー見積もり(読み取り専用)', () => {
  // 取り違えの検査は 1 度だけ、ここで大きな音で落とす。
  beforeAll(() => {
    const roots = guardedRoots(process.env);
    assertInputNotUnderDataRoot(DIR as string, roots);
    if (OUT) assertOutSafe(OUT, DIR as string, roots);
  });

  it('ファイルごとの集計を出す', () => {
    const dir = DIR as string;
    const files = readdirSync(dir)
      .filter((f) => f.toLowerCase().endsWith('.css'))
      .sort();
    expect(files.length, `${dir} に *.css が無い`).toBeGreaterThan(0);
    const rows = files.map((f) => estimate(f, readFileSync(join(dir, f), 'utf8')));

    // ペア(`<会社>_<ファンド>_交付版.css` と `…_全体版.css`)ごとに集める。
    const pairs = new Map<string, FileRow[]>();
    for (const r of rows) {
      const key = r.file.replace(/_(交付版|全体版)\.css$/i, '');
      pairs.set(key, [...(pairs.get(key) ?? []), r]);
    }
    const pairRows = [...pairs].map(([pair, rs]) => ({
      pair,
      files: rs.length,
      rules: rs.reduce((n, r) => n + r.rules, 0),
      unmatched: rs.reduce((n, r) => n + r.unmatched, 0),
      expandedLists: rs.reduce((n, r) => n + r.expandedLists, 0),
      dupSuspects: rs.reduce((n, r) => n + r.dupSuspects, 0),
    }));

    console.table(
      rows.map(({ unmatchedKeys: _k, ...r }) => ({
        ファイル: r.file,
        規則数: r.rules,
        照合不可になりうる: r.unmatched,
        展開した並び: r.expandedLists,
        重複の疑い: r.dupSuspects,
      })),
    );
    console.table(
      pairRows.map((p) => ({
        ペア: p.pair,
        ファイル数: p.files,
        規則数: p.rules,
        照合不可になりうる: p.unmatched,
        展開した並び: p.expandedLists,
        重複の疑い: p.dupSuspects,
      })),
    );
    for (const r of rows.filter((x) => x.unmatched > 0)) {
      console.log(`[内訳] ${r.file}\n  ${r.unmatchedKeys.join('\n  ')}`);
    }

    if (OUT) {
      mkdirSync(dirname(resolve(OUT)), { recursive: true });
      writeFileSync(resolve(OUT), JSON.stringify({ files: rows, pairs: pairRows }, null, 2));
    }
  });
});
