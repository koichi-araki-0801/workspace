import { mkdirSync, readdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve, sep } from 'node:path';
import { canonicalCssRuleKeys, foldedCssRuleTexts, splitCssRules } from '@editor/shared';
import { describe, expect, it, vi } from 'vitest';
import { useGrapes } from '@/features/editor/useGrapes';

vi.mock('@/components/ui/toast', () => ({ toast: vi.fn(), toastError: vi.fn() }));

// =============================================================================
// cssKeyEstimate.manual.dom.test.ts — 既存の CSS で照合不可になりうる規則の数(手動・読み取り専用)
// =============================================================================
// 新しい正規化のあとで、既存データの CSS が編集されたとき照合不可の競合になりうる規則が
// いくつあるかを見積もる。`CSS_KEY_ESTIMATE_DIR` が無ければ丸ごと飛ぶので、通常のテスト実行と
// CI では走らない。`config.ts` も `DATA_ROOT` の中身も読まない(`DATA_ROOT` は取り違え検査の
// ためにパスだけ見る)。`<dataRoot>/css` の「コピー」を渡す。書くのは `CSS_KEY_ESTIMATE_OUT`
// (リポジトリとデータの外のパス)の JSON だけ。
// jsdom の CSSOM はブラウザのような書き直し(`>` の空白・引用符など)をしないので、数は下限。
//   CSS_KEY_ESTIMATE_DIR=<コピー先> pnpm exec vitest run --project web-dom \
//     editor/web/test/cssKeyEstimate.manual.dom.test.ts

const DIR = process.env.CSS_KEY_ESTIMATE_DIR;
const OUT = process.env.CSS_KEY_ESTIMATE_OUT;

/** 比較用に実体のパスへ直し、Windows では大文字小文字を区別しない形にする。 */
function norm(p: string): string {
  const real = realpathSync(resolve(p));
  return process.platform === 'win32' ? real.toLowerCase() : real;
}

/** 入力が `DATA_ROOT` の配下(本物を直接指している)なら落とす。 */
function assertNotUnderDataRoot(dir: string): void {
  const root = process.env.DATA_ROOT;
  if (!root) return;
  let r: string;
  try {
    r = norm(root);
  } catch {
    return; // 存在しない DATA_ROOT の配下にはなりえない。
  }
  const d = norm(dir);
  if (d === r || d.startsWith(r.endsWith(sep) ? r : r + sep)) {
    throw new Error(
      `CSS_KEY_ESTIMATE_DIR(${dir})が DATA_ROOT(${root})の配下です。コピーを渡してください。`,
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
  /** 新しい正規化で同じキーになるが本文が違う規則の組の数(黙った追記の疑い)。 */
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

describe.skipIf(!DIR)('既存 CSS の照合キー見積もり(読み取り専用)', () => {
  it('入力が DATA_ROOT の配下でない', () => {
    assertNotUnderDataRoot(DIR as string);
  });

  it('ファイルごとの集計を出す', () => {
    const dir = DIR as string;
    assertNotUnderDataRoot(dir);
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
