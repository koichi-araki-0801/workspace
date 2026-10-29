// =============================================================================
// hostProtocol.ts — プレビュー iframe(ビューアホストページ)と親の postMessage 契約
// =============================================================================
// プレビューは `@vivliostyle/core` を**アプリと同一オリジンの本体 document** ではなく、
// サーバが配信するビューアホストページ(`sandbox="allow-scripts"` = same-origin なし)の
// 中で動かす。テンプレの JS は正当なコンテンツなので実行させるが、実行先を opaque な
// オリジンへ隔離してアプリの DOM・cookie・API へ触れないようにするのが目的である。
//
// この構成では親と子は**互いに DOM を読めない**ので、命令も状態も全部この postMessage 契約を
// 通る。契約が web と server の 2 箇所に手書きで散ると、片方だけ直したときに「プレビューが
// 無言で白紙」になる形の退行が出るため、文字列定数は shared のここ 1 箇所に置く。
//
// ── オリジン検証の作法(重要) ──
// 親 → 子の `postMessage` は `targetOrigin` に `'*'` を使うしかない。子は opaque オリジンで、
// 具体的なオリジン文字列を指定する手段が無い(指定すると配送されない)。逆に子 → 親の
// メッセージは `event.origin === 'null'` で届き、これは**他の任意の sandbox フレームとも
// 一致する**ため識別に使えない。よって発信元の検証は必ず
// `event.source === iframe.contentWindow` の**同一性**で行う(`useIframeAutoFit.ts` と同じ)。
// 運ぶのは文書 HTML(既にアプリ側が持っているもの)とページ番号・倍率の数値だけで、
// 子から親へ渡る情報に秘密は無い。
//
// ── 文書の番号(`seq`) ──
// 親は文書を送るたびに番号を振り(`PREVIEW_MSG_DOC` の `seq`)、子はいま組んでいる文書の番号を
// `PREVIEW_MSG_STATE`・`PREVIEW_MSG_PART_PAGES`・`PREVIEW_MSG_PART_CLICK`・`PREVIEW_MSG_ERROR` に
// 載せて返す(文書を受ける前の起動の失敗は 0)。親は自分が最後に送った番号と違うものを捨てる。
// 文書を送り直した直後は、前の文書について子が送った通知がまだ届きうる(前の文書の
// `ready: true` で新しい文書へ目印を送る・前の文書のページ表で移る・前の文書の失敗で簡易表示へ
// 倒れる、の取り違えを防ぐ)。番号の形は `parsePreviewDocSeq` で検査する。

/**
 * ビューアホストページ一式の配信接頭辞(`/api` プレフィックスを含まない — 付与は
 * `api-paths.ts` 冒頭と同じ規約で server の register が担う)。
 *
 * **`apiPaths` には載せない。** あれは「全 REST エンドポイントの正典」で、OpenAPI に載る
 * 外部契約の集合である。ここは web UI が内部で読む配信面(HTML ページ・ビューアバンドル・
 * 同梱資産)であって REST の契約ではない。
 */
export const PREVIEW_HOST_BASE = '/preview-host';

/**
 * 隔離 iframe の src。**末尾のファイル名まで含めるのが要件**で、`/api/preview-host` 単体を
 * src にするとテンプレの相対参照(`js/x.js`)が 1 階層上(`/api/js/x.js`)へ解決される。
 */
export const PREVIEW_HOST_URL = `/api${PREVIEW_HOST_BASE}/index.html`;

/**
 * 論理ルート相対パス(1 回復号済み)→ プレビューホストの資産 URL(同一オリジンで cookie が付く)。
 * セグメントごとに符号化し直す。そのまま繋ぐと `#` `?` で URL が切れ、`%2e%2e` はブラウザの URL
 * 解析で `..` と扱われる。対の無いサロゲートは `encodeURIComponent` が `URIError` を投げるので、
 * 呼び出し側がその参照だけ諦める。
 */
export function previewHostAssetUrl(rel: string): string {
  return `/api${PREVIEW_HOST_BASE}/${rel.split('/').map(encodeURIComponent).join('/')}`;
}

/**
 * 親 → 子: 組版する文書を渡す。本体は `{ type, html, seq, review? }` で、`html` は完成済みの
 * プレビュー文書文字列、`seq` は文書の番号(冒頭の「文書の番号」)。`review: true` は承認タブの
 * 紙面(目印を描き、`PREVIEW_MSG_MARKS` を受ける経路)で、そのときだけホストが目印を描く。
 * 編集のプレビューは付けない。
 */
export const PREVIEW_MSG_DOC = 'editor:preview-doc';

/**
 * 親 → 子: 操作命令。本体は `{ type, cmd, page?, anchor?, part? }`(`cmd` は `PreviewCommand`)。
 */
export const PREVIEW_MSG_CMD = 'editor:preview-cmd';

/** 子 → 親: ブート完了(以後 `PREVIEW_MSG_DOC` を受け付ける)。 */
export const PREVIEW_MSG_READY = 'editor:preview-ready';

/** 子 → 親: ページ送り/ズーム状態の通知。本体は `{ type, state, seq }`。 */
export const PREVIEW_MSG_STATE = 'editor:preview-state';

/** 子 → 親: 組版の失敗通知(親はフォールバック表示へ倒す)。本体は `{ type, message, seq }`。 */
export const PREVIEW_MSG_ERROR = 'editor:preview-error';

/**
 * 親 → 子: 目印の状態(番号ごとの判定・選択・表示)。文書を組み直さずに描き替える。
 * 本体は `{ type, marks: PreviewMarks }`。
 */
export const PREVIEW_MSG_MARKS = 'editor:preview-marks';

/** 子 → 親: 紙面のパーツが押された。本体は `{ type, part, seq }`(`part` は番号の文字列)。 */
export const PREVIEW_MSG_PART_CLICK = 'editor:preview-part-click';

/**
 * 子 → 親: 飾りを描いたあとの、番号 → 物理ページの index(0 始まり)。本体は
 * `{ type, pages, seq }`(`pages` は `parsePreviewPartPages` で検査する)。
 */
export const PREVIEW_MSG_PART_PAGES = 'editor:preview-part-pages';

/** 親から子へ送れる操作。`goToPage` はページ番号、`gotoAnchor` は要素 id、`gotoPart` はパーツの番号(文字列)を引数に取る。 */
export type PreviewCommand =
  | 'prevPage'
  | 'nextPage'
  | 'goToPage'
  | 'zoomIn'
  | 'zoomOut'
  | 'fit'
  | 'gotoAnchor'
  | 'gotoPart';

/** 子が通知する状態。親のツールバー表示に必要な値だけを運ぶ。 */
export interface PreviewHostState {
  currentPage: number;
  pageCount: number;
  atFirst: boolean;
  atLast: boolean;
  zoom: number;
  /** 組版が完了して操作を受け付けられるか(ローダー解除の契機)。 */
  ready: boolean;
}

/**
 * 紙面の倍率の下限(`PreviewHostState.zoom` はこれより小さくならない。フィットも手動の縮小も)。
 * ホスト(`previewHost.ts` のブートスクリプト)とそれを確かめる e2e(`approval.spec.ts` の 1400px の
 * 画面)が同じ値を読む。
 */
export const PREVIEW_ZOOM_MIN = 0.4;

export type PreviewMarkState = 'pending' | 'approved' | 'rejected';

/** 目印の描き分け。判定の状態ごとの色(紙面の枠・番号札)。 */
export const PREVIEW_MARK_COLORS: Readonly<Record<PreviewMarkState, string>> = {
  pending: '#3b82c4',
  approved: '#2f8a5f',
  rejected: '#c0392b',
};

/** 親が子へ渡す目印の状態。 */
export interface PreviewMarks {
  /** キーは番号の文字列(`isPreviewPartNo`)。 */
  states: Record<string, PreviewMarkState>;
  selected: string | null;
  visible: boolean;
}

/**
 * 子との間で運ぶ番号のキーの個数の上限。番号は差分の最上位ブロックにしか振られないので、
 * その上限(`MAX_TOP_LEVEL_BLOCKS`)と同じ値にする(同じ値であることはテストで固定する)。
 * ここで reviewDiff を import しないのは、`shared/preview` から `shared/html` への依存を作らない
 * ため。子(テンプレ JS が動く)から届く値で親の処理を膨らませない。
 */
export const PREVIEW_MAX_PART_KEYS = 5_000;

/**
 * 正規形だけ通す(`'01'` と `'1'` が同じ番号の別キーとして二重に通らないように)。番号は 1 から
 * 振る(`numberChangedParts`)ので `'0'` も通さない。
 */
const PART_NO_RE = /^[1-9]\d{0,4}$/;

/** パーツの番号の文字列(1 始まりの 1〜5 桁の数字の正規形)か。 */
export function isPreviewPartNo(v: unknown): v is string {
  return typeof v === 'string' && PART_NO_RE.test(v);
}

function isPlainRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function isMarkState(v: unknown): v is PreviewMarkState {
  return v === 'pending' || v === 'approved' || v === 'rejected';
}

/** `PREVIEW_MSG_MARKS` の本体の形を検査する。形が違えば null。 */
export function parsePreviewMarks(v: unknown): PreviewMarks | null {
  if (!isPlainRecord(v) || !isPlainRecord(v.states)) return null;
  if (typeof v.visible !== 'boolean') return null;
  if (v.selected !== null && !isPreviewPartNo(v.selected)) return null;
  const entries = Object.entries(v.states);
  if (entries.length > PREVIEW_MAX_PART_KEYS) return null;
  const states: Record<string, PreviewMarkState> = {};
  for (const [k, st] of entries) {
    if (!isPreviewPartNo(k) || !isMarkState(st)) return null;
    states[k] = st;
  }
  return { states, selected: v.selected, visible: v.visible };
}

/**
 * `PREVIEW_MSG_PART_PAGES` の本体の形(番号 → 0 以上の整数)だけを検査する。形が違えば null。
 * 自分の番号の集合に無いキーやページ数以上の値を捨てるのは、それを知っている親の役目。
 */
export function parsePreviewPartPages(v: unknown): Record<string, number> | null {
  if (!isPlainRecord(v)) return null;
  const entries = Object.entries(v);
  if (entries.length > PREVIEW_MAX_PART_KEYS) return null;
  const pages: Record<string, number> = {};
  for (const [k, n] of entries) {
    // 安全な整数に限る(2 ** 60・1e300 は整数でも index として意味を持たない)。
    if (!isPreviewPartNo(k) || typeof n !== 'number' || !Number.isSafeInteger(n) || n < 0) {
      return null;
    }
    pages[k] = n;
  }
  return pages;
}

/**
 * 文書の番号(`seq`。0 以上の安全な整数)を検査する。形が違えば null。子(`previewHost.ts` の
 * `BOOT_MARKS_PARSER` の `parseDocSeq`)も同じ規則で、同じ答えを返すことをテストで固定する。
 */
export function parsePreviewDocSeq(v: unknown): number | null {
  return typeof v === 'number' && Number.isSafeInteger(v) && v >= 0 ? v : null;
}
