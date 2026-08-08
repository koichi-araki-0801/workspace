// =============================================================================
// iframeSandbox.guard.test.ts — srcdoc iframe の sandbox 必須ガード
// =============================================================================
// 差分・比較・プレビューの iframe には、他ユーザ(申請者)が書いた HTML/CSS が入る。sandbox が
// 無いと承認者のブラウザ上・アプリと同一オリジンでスクリプトが走り、職務分掌(自己承認拒否)を
// 実質回避できる。個々の画面のマウントではなくソース走査で守るのは、iframe を増やした時に
// 「新しい 1 箇所だけ付け忘れる」形の退行を確実に落とすため。
//
// **守り方は「除去」ではなく「隔離」である。** テンプレの JavaScript は正当なコンテンツで、
// 承認者は JS が効いた実行結果を見て承認する。よって JS は動かす(`allow-scripts`)が、
// `allow-same-origin` は付けない — 両方を同時に付けると子は親オリジンの DOM へ到達でき、
// sandbox は事実上無効になる。`allow-same-origin` 単独(= JS を殺す)も採らない: 承認者が
// 「JS が効いていない見た目」を承認してしまい、承認ゲートの意味が失われる。
// 高さ追随は `useIframeAutoFit` の postMessage 経由で、親は子の DOM を読まない。
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

  it('allow-scripts と allow-same-origin を同時に許す iframe が無い', () => {
    // これが本丸。同時指定は sandbox の無効化と等価で、`allow-scripts` へ寄せた今は
    // 「高さを読むために same-origin も足す」形で戻ってくる圧力が最も高い。
    const both = FRAMES.filter(
      (f) => /allow-scripts/.test(f.tag) && /allow-same-origin/.test(f.tag),
    ).map((f) => f.file);
    expect(both, `sandbox が無効化された iframe: ${both.join(', ')}`).toEqual([]);
  });

  it('テンプレ本文を映す iframe は allow-scripts で開く(JS を殺さない)', () => {
    // `allow-same-origin` 単独へ戻すと、承認者は「JS が効いていない見た目」を承認する。
    // 対象は srcdoc を持つ(= テンプレ本文を映す)フレームに限る。
    const srcdocFrames = FRAMES.filter((f) => /srcdoc/.test(f.tag));
    expect(srcdocFrames.length).toBeGreaterThanOrEqual(4);
    const inert = srcdocFrames.filter((f) => !/allow-scripts/.test(f.tag)).map((f) => f.file);
    expect(inert, `JS が動かない iframe: ${inert.join(', ')}`).toEqual([]);
  });

  it('親が子の contentDocument を読まない(高さは postMessage 経由)', () => {
    // `allow-same-origin` なしでは `contentDocument` は null。読む実装が残っていると
    // 「高さが合わないから same-origin を足す」退行の入口になる。
    // メンバアクセス(`.contentDocument`)だけを見る。コメント中のバッククォート表記
    // (規約上、識別子は必ずバッククォートで囲む)を誤検出しないため。
    const offenders = vueFiles(SRC_DIR)
      .filter((file) => /\.contentDocument\b/.test(readFileSync(file, 'utf8')))
      .map((file) => path.relative(SRC_DIR, file).replace(/\\/g, '/'));
    expect(offenders, `contentDocument を読む画面: ${offenders.join(', ')}`).toEqual([]);
  });
});
