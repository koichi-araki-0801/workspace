// =============================================================================
// jinjaAttrs.ts — Jinja round-trip 用 data 属性名の正典
// =============================================================================
// `fillJinja.ts` / `jinjaMask.ts` が「書き手」、`jinjaMask.ts` の `toTemplate` が
// 「読み手(復元側)」となる分散プロトコルの属性名をここに一元化する。書き手と読み手が
// 別ファイルにあるため、リテラル散在だと片側だけの typo が round-trip 破壊として
// しか現れない — 本モジュールを両者が import することで契約をコード上に可視化する。
//
// shared の `EDITING_MARKER_ATTRS`(`editingMarkers.ts`)は、ここで書く属性名を検出する側の
// 一覧で、本ファイルの属性名と対になる。属性を足したら両方へ足す(テストが突き合わせる)。

/** inline chip の厳密ソース(base64)。書: `tokenChip` → 復: `toTemplate` step 3a */
export const DATA_JINJA = 'data-jinja';
/** opaque mask した verbatim ソース(base64)。書: `opaqueChip` 等 → 復: `toTemplate` step 3b */
export const DATA_OPAQUE = 'data-opaque';
/** opaque chip の種別(script/math)。書: `opaqueChip`。復元には使わず live-render 層の dispatch 用 */
export const DATA_OPAQUE_KIND = 'data-opaque-kind';
/** for のテンプレートの行(1 回目の繰り返し)の最上位要素。表示専用で、`toTemplate` が外す。 */
export const DATA_JINJA_LOOP_ROW = 'data-jinja-loop-row';
/** チップ(`fillJinja` が Jinja のトークンや原文を表す `span`)のクラス。 */
export const JINJA_CHIP_CLASS = 'jinja-chip';
/**
 * 固めた範囲を包む `div`(本文全体・表)のクラス。canvas では `display: contents` で、レイアウト上は
 * 中身が包みの親の直下に並ぶ。書: `fillJinja` の `emitFrozen` / `emitWholeBody`。
 */
export const FROZEN_BODY_CLASS = 'jinja-frozen-body';
/** 範囲の印(HTML コメント)の接頭辞。原文のコメントと区別するための名前空間。 */
const RT_COMMENT_PREFIX = 'jinja-rt:';

export type RtMarker =
  | { kind: 'o'; id: number; payload: string }
  | { kind: 'c'; id: number; payload: string }
  | { kind: 'x'; id: number }
  | { kind: 't'; payload: string };

export function b64encodeUtf8(s: string): string {
  const bytes = new TextEncoder().encode(s);
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin);
}

// 不正な UTF-8 は置換文字へ化けると原文が変わるので、`fatal` で例外にして呼び元へ知らせる。
export function b64decodeUtf8(b: string): string {
  const bin = atob(b);
  const bytes = Uint8Array.from(bin, (c) => c.charCodeAt(0));
  return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
}

const B64 = '[A-Za-z0-9+/]*={0,2}';
const RT_RE = new RegExp(`^jinja-rt:(?:([oc]):(\\d+):(${B64})|x:(\\d+)|t:(${B64}))$`);

export function rtComment(m: RtMarker): string {
  if (m.kind === 'x') return `<!--${RT_COMMENT_PREFIX}x:${m.id}-->`;
  if (m.kind === 't') return `<!--${RT_COMMENT_PREFIX}t:${b64encodeUtf8(m.payload)}-->`;
  return `<!--${RT_COMMENT_PREFIX}${m.kind}:${m.id}:${b64encodeUtf8(m.payload)}-->`;
}

/** コメントの本文を読む。`jinja-rt:` で始まらなければ null、始まるのに崩れていれば 'invalid'。 */
export function parseRtCommentData(data: string): RtMarker | 'invalid' | null {
  if (!data.trimStart().startsWith(RT_COMMENT_PREFIX)) return null;
  const m = RT_RE.exec(data);
  if (!m) return 'invalid';
  try {
    if (m[1]) return { kind: m[1] as 'o' | 'c', id: Number(m[2]), payload: b64decodeUtf8(m[3]) };
    if (m[4]) return { kind: 'x', id: Number(m[4]) };
    if (!m[5]) return 'invalid';
    return { kind: 't', payload: b64decodeUtf8(m[5]) };
  } catch {
    return 'invalid';
  }
}
