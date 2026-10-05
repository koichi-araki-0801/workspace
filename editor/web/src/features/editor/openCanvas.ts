// =============================================================================
// openCanvas.ts — 編集画面を開くときの canvas の読み込みと、確定版の形の測定
// =============================================================================
// 編集画面を開くときの読み込みの順と、どの時点の `getBodyHtml` / `getCss` を何に使うかを持つ。
// 単体テストで固定できるよう、GrapesJS は最小の口(`OpenCanvasTarget`)だけで受ける。
//
// 測るものは 2 つある。どちらも「確定版を GrapesJS が読み込んだ直後の形」で、GrapesJS の
// 書き出しどうしでしか文字列の比較が成り立たないため canvas から取る。
// - 正規形(`canonical`): 「未確定」の判定基準(編集経路のみ。`lib/confirmedCanonical.ts`)。
//   確定版を読み込んだときは必ず測り直し、キャッシュは測れないとき(下書きから開いて確定版の
//   読み込みを拒まれたとき)だけ使う。書き出しの形(GrapesJS の版・getCss の設定)が変わると
//   キャッシュは古い形のまま残り、同一判定が黙って成り立たなくなるため。
// - CSS の baseline: 申請に載せ、承認時のペア同期が変わった CSS 規則を見分ける基準にする
//   (`@editor/shared` の `mergeCssRuleChangesFromBaseline`)。下書きから開くときも確定版の
//   CSS から測る — 下書きの CSS を基準にすると、下書きで変えた規則が「変わっていない」になる。

import type { ConfirmedCanonical } from '@/lib/confirmedCanonical';
import { shouldMeasureCanonical } from './confirmedCanonicalGate';

/** `useGrapes` のうち、読み込みと書き出しの口。 */
export interface OpenCanvasTarget {
  load(bodyEditableHtml: string, css: string, opts?: { quiet?: boolean }): boolean;
  getBodyHtml(): string;
  getCss(): string;
}

export interface OpenCanvasInput {
  /** 作成経路(`?created=1`)。確定版の正規形を持たない。 */
  isCreateRoute: boolean;
  /** 下書きから開くか(`editableBody` / `css` が下書き)。 */
  hasDraft: boolean;
  /** 確定版の値埋め込み本文。 */
  confirmedBody: string;
  /** 確定版の CSS(テンプレの CSS ファイルの原文)。 */
  confirmedCss: string;
  /** canvas に載せる本文と CSS(下書きがあれば下書き、無ければ確定版)。 */
  editableBody: string;
  css: string;
  /** 正規形のキャッシュ(編集経路で、確定版を読み込めなかったときだけ使う)。 */
  cachedCanonical: ConfirmedCanonical | null;
}

export interface OpenCanvasResult {
  /** 本文を読み込めたか。false なら canvas は空のまま(呼び出し側は一覧へ戻す)。 */
  loaded: boolean;
  /** 確定版の CSS を読み込んだ直後の `getCss()`。測れなければ null。 */
  cssBaseline: string | null;
  canonical: ConfirmedCanonical | null;
  /** `canonical` をここで測ったか(キャッシュへ書くべきか)。 */
  measuredCanonical: boolean;
  /**
   * 確定版の quiet load に失敗し、正規形も持てなかったか(編集経路のみ)。立っていれば
   * 「未確定」の同一判定を起動しない(`confirmedCanonicalGate.ts` を見よ)。
   */
  loadFailed: boolean;
}

/**
 * canvas へ本文を読み込み、確定版の正規形と CSS の baseline を測る。下書きから開くときは
 * 本文の前に確定版を quiet load して測る(本文の読み込みで同じ通知が出るためトーストは抑止)。
 */
export function openCanvas(g: OpenCanvasTarget, input: OpenCanvasInput): OpenCanvasResult {
  let canonical: ConfirmedCanonical | null = null;
  let measuredCanonical = false;
  let loadFailed = false;
  let cssBaseline: string | null = null;

  if (input.hasDraft) {
    if (g.load(input.confirmedBody, input.confirmedCss, { quiet: true })) {
      cssBaseline = g.getCss();
      if (!input.isCreateRoute) {
        canonical = { html: g.getBodyHtml(), css: cssBaseline };
        measuredCanonical = true;
      }
    } else if (!input.isCreateRoute && input.cachedCanonical) {
      canonical = input.cachedCanonical;
    } else if (!input.isCreateRoute) {
      // false になるのは確定版側の CSS に外部参照が残っているときだけ(draft の CSS は
      // 本文の読み込みが通す入口ガードを既に通過済み)。確定版が古くて汚れているだけで
      // draft 自体は正当なので、ここで編集を止めない。ただし正規形は作らない —
      // この時点の canvas は確定版の内容ではなく直前の状態のままで、これを正規形として
      // 測って直後に draft を読み込むと「draft 自身から作った正規形」と一致してしまい、
      // 「変更なし」と誤認して正当な draft を自動で消す。
      loadFailed = true;
    }
  }

  if (!g.load(input.editableBody, input.css)) {
    return {
      loaded: false,
      cssBaseline: null,
      canonical: null,
      measuredCanonical: false,
      loadFailed: false,
    };
  }
  if (!input.hasDraft) cssBaseline = g.getCss();
  // 下書きが無ければ、本文の読み込みがそのまま確定版の読み込み。
  if (!input.hasDraft && shouldMeasureCanonical(input.isCreateRoute, false, loadFailed)) {
    canonical = { html: g.getBodyHtml(), css: g.getCss() };
    measuredCanonical = true;
  }
  return { loaded: true, cssBaseline, canonical, measuredCanonical, loadFailed };
}
