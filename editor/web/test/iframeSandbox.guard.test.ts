// =============================================================================
// iframeSandbox.guard.test.ts — srcdoc iframe の sandbox 必須ガード
// =============================================================================
// 差分・比較・プレビューの iframe には、他ユーザ(申請者)が書いた HTML/CSS が入る。sandbox が
// 無いと承認者のブラウザ上・アプリと同一オリジンでスクリプトが走り、職務分掌(自己承認拒否)を
// 実質回避できる。個々の画面のマウントではなくソース走査で守るのは、iframe を増やした時に
// 「新しい 1 箇所だけ付け忘れる」形の退行を確実に落とすため。
//
// `allow-scripts` を禁じるのが要点: `allow-same-origin` 単独ならスクリプトは実行されないが、
// 両方を同時に許すと sandbox はザルになる(中の JS が親オリジンの DOM へ到達できる)。
import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const SRC_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../src');

function vueFiles(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) out.push(...vueFiles(full));
    else if (name.endsWith('.vue')) out.push(full);
  }
  return out;
}

/** `<iframe ...>` の開始タグを属性文字列ごと拾う(自己終了・通常終了の双方)。 */
function iframeTags(source: string): string[] {
  return [...source.matchAll(/<iframe\b[^>]*>/g)].map((m) => m[0]);
}

const FRAMES = vueFiles(SRC_DIR).flatMap((file) =>
  iframeTags(readFileSync(file, 'utf8')).map((tag) => ({
    file: path.relative(SRC_DIR, file).replace(/\\/g, '/'),
    tag,
  })),
);

describe('srcdoc iframe の sandbox ガード', () => {
  it('走査対象の iframe を実際に見つけている(セルフテスト)', () => {
    // 0 件だと以下の forEach が素通りして「常に緑」になるため、下限を固定する。
    expect(FRAMES.length).toBeGreaterThanOrEqual(5);
  });

  it('すべての iframe が sandbox 属性を持つ', () => {
    const missing = FRAMES.filter((f) => !/\bsandbox\s*=/.test(f.tag)).map((f) => f.file);
    expect(missing, `sandbox の無い iframe: ${missing.join(', ')}`).toEqual([]);
  });

  it('どの iframe も allow-scripts を許可しない', () => {
    const scripted = FRAMES.filter((f) => /allow-scripts/.test(f.tag)).map((f) => f.file);
    expect(scripted, `allow-scripts を許可した iframe: ${scripted.join(', ')}`).toEqual([]);
  });
});
