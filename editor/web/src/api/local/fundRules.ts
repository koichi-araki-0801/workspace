// =============================================================================
// fundRules.ts — local fixtures 向けのファンド業務ルール
// =============================================================================
// 役割: 本番(REST/SQL Server)では台帳・sproc が同等の判定を担うが、local 動作では
// fixtures 駆動で同等の判定を表現する。

/**
 * シリーズファンド = 「コア投資戦略ファンド(コアラップ)」系の `fundCode` 集合。
 * 510037(切替型) / 510155(切替型ワイド) / 510003(安定型)。
 * これ以外(110024 等)は非シリーズ。
 */
export const SERIES_FUND_CODES: ReadonlySet<string> = new Set(['510037', '510155', '510003']);

/**
 * 償還ファンド・モック: 作成済みテンプレ HTML の特定パーツを償還用パーツへ置換する。
 *
 * 置換ルールは 510124 の償還前→償還後(償還報告書)を参考にしたダミーで、
 * 見出しの「運用報告書」→「償還報告書」化、当期末サマリーの償還サマリー化、
 * 「償還金のお知らせ」セクションの追加を行う。
 *
 * TODO: 実際の償還用パーツ置換ルール・パーツ定義は別途確定する。現状はモック。
 */
export function applyRedemptionMock(html: string): string {
  let out = html;

  // ── 1. 見出し/タイトルの「運用報告書」→「償還報告書」(既に償還報告書なら不変) ──
  out = out.replace(/運用報告書/g, '償還報告書');

  // ── 2. 償還サマリー帯を本文先頭(<body> 直後)へ挿入 ──
  // レイアウトに依存しないよう特定セクションの置換ではなく <body> 起点で挿入する。
  // 値は sample から差し込み。
  const redemptionBanner =
    '\n<div class="band" data-redemption="summary">償還のお知らせ ― 償還日 {{ report.redemptionDate }}／償還価額 {{ fund.redemptionNav }} 円</div>';
  out = /<body[^>]*>/.test(out)
    ? out.replace(/<body[^>]*>/, (m) => m + redemptionBanner)
    : redemptionBanner + out;

  // ── 3. 「償還金のお知らせ」ブロックを末尾(footer 直前)に追加 ──
  const redemptionNotice = [
    '<div class="sub" data-redemption="notice"><span class="no">償</span><h3>償還金のお知らせ</h3></div>',
    '<p>1万口当たり償還金: {{ fund.redemptionNav }} 円</p>',
  ].join('\n');
  out = out.includes('<footer')
    ? out.replace('<footer', `${redemptionNotice}\n    <footer`)
    : `${out}\n${redemptionNotice}`;

  // TODO: 実際の償還用パーツ置換ルール・パーツ定義は別途確定する。現状はモック。
  return out;
}
