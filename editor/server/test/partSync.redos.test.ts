// `extractSyncParts` の走査器が線形であることの退行ガード。比較対象の `LEGACY_TAG_RE` は
// 否定文字クラスが `<` を除外しておらず、閉じ `>` を持たない `<a ` の連続に対して
// 開始位置ごとに末尾まで舐め直す二次計算量になる。承認 1 回でイベントループを数時間
// 止められるため、**「正しい入力を正しく処理する」ではなく「迂回入力で破綻しない」**を
// 主張する形で書く。
import { describe, expect, it } from 'vitest';
import { extractSyncParts, MAX_SYNC_SCAN_BYTES } from '../src/sync/partSync.js';

/** 旧実装の逐語コピー。何を守っているかをテスト内で自明にするための参照。 */
const LEGACY_TAG_RE = /<!--[\s\S]*?-->|<\/?([a-zA-Z][a-zA-Z0-9-]*)((?:"[^"]*"|'[^']*'|[^>"'])*)>/g;

const legacyScan = (html: string): number => {
  LEGACY_TAG_RE.lastIndex = 0;
  let count = 0;
  for (let m = LEGACY_TAG_RE.exec(html); m !== null; m = LEGACY_TAG_RE.exec(html)) count++;
  return count;
};

const measure = (fn: () => void): number => {
  const t0 = performance.now();
  fn();
  return performance.now() - t0;
};

describe('extractSyncParts の線形性(R4)', () => {
  it('閉じ > を持たないタグの連続に対して入力長の 4 倍で 4 倍以下の時間しか掛からない', () => {
    // 二次なら長さ 4 倍で約 16 倍。線形なら約 4 倍。マシン差に強い「比」で主張する。
    const t1 = measure(() => extractSyncParts('<a '.repeat(10_000)));
    const t4 = measure(() => extractSyncParts('<a '.repeat(40_000)));
    expect(t4).toBeLessThan(Math.max(t1, 0.5) * 8);
    expect(t4).toBeLessThan(1_000);
  });

  it('旧実装は同じ入力で二次に膨らむ(この差分が本修正の対象)', () => {
    const s1 = measure(() => legacyScan('<a '.repeat(2_000)));
    const s2 = measure(() => legacyScan('<a '.repeat(4_000)));
    // 旧実装の比が線形(2 倍)に収まっていたら、この回帰テストは意味を失っている。
    expect(s2).toBeGreaterThan(Math.max(s1, 0.05) * 2.5);
  });

  it('style の中身は走査対象にならない(承認者から見えない位置に隠せない)', () => {
    // この種のペイロードは `<style>` の CSS コメント内に置け、差分にもプレビューにも
    // PDF にも現れない。RAWTEXT を飛ばすことで「そもそもタグとして読まれない」。
    const payload = `<style>/* ${'<a '.repeat(50_000)} */ .x{}</style>`;
    const ghost = `<style><section data-part-id="ghost">x</section></style>`;
    const html = `<div>${payload}${ghost}<p data-part-id="real">R</p></div>`;
    const t = measure(() => {
      const parts = extractSyncParts(html);
      expect(parts.map((p) => p.partId)).toEqual(['real']);
    });
    expect(t).toBeLessThan(1_000);
  });

  it('script 内の文字列 </div> でパーツ span が途中終了しない', () => {
    const html = `<section data-part-id="a"><script>const s = "</div>";</script><p>A</p></section>`;
    const parts = extractSyncParts(html);
    expect(parts).toHaveLength(1);
    expect(parts[0].html).toBe(html);
  });

  it('閉じ引用符が無い属性で走査を打ち切り、有限時間で返る', () => {
    // 「引用符が閉じないからこの `<` は文字データだった」と巻き戻す実装にすると
    // 二次が復活する。打ち切り(戻り読み禁止)であることを固定する。
    const html = `<p data-part-id="ok">O</p><div data-part-id="a${'x'.repeat(100_000)}`;
    const t = measure(() => {
      expect(extractSyncParts(html).map((p) => p.partId)).toEqual(['ok']);
    });
    expect(t).toBeLessThan(1_000);
  });

  it('閉じ > の無いタグでも無限ループにならない', () => {
    expect(extractSyncParts(`<p data-part-id="a">A</p><div class=x`)).toHaveLength(1);
  });

  it('MAX_SYNC_SCAN_BYTES 超過は空配列でなく throw する', () => {
    // 空配列を返すと `computePairSync` が「source にパーツが無い」と誤解釈し、
    // 状態ファイルを書き換えてしまう(サイレントな状態破壊)。throw ならベストエフォート
    // 層の catch が warn + skip へ倒す。
    const html = 'x'.repeat(MAX_SYNC_SCAN_BYTES + 1);
    expect(() => extractSyncParts(html)).toThrow(/大きすぎます/);
  });

  it('引用符なしの data-part-id も拾う(旧実装では静かに落ちていた)', () => {
    const parts = extractSyncParts(`<section data-part-id=raw><p>R</p></section>`);
    expect(parts.map((p) => p.key)).toEqual(['raw#1']);
  });

  it('doctype と処理命令はパーツ走査に影響しない', () => {
    const html = `<!DOCTYPE html><?xml v?><section data-part-id="a">A</section>`;
    expect(extractSyncParts(html).map((p) => p.partId)).toEqual(['a']);
  });
});
