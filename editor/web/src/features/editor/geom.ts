// =============================================================================
// geom.ts — 選択ブロックのレイアウト幾何(GrapesJS inline style との相互変換)
// =============================================================================
// 役割: canvas で選択した `Component` の inline style から幾何(サイズ / 配置 /
// 余白 / page-break)を読み取り、3-pane editor の part property として提示・書き戻す。
// 余白は印刷で安定するよう mm 単位、幅は % で保持する。

export type Align = 'left' | 'center' | 'right' | 'stretch';

export interface LayoutGeom {
  widthPct: number;
  align: Align;
  indent: number; // mm
  marginTop: number; // mm
  marginBottom: number; // mm
  pageBreakBefore: boolean;
  pageBreakAfter: boolean;
  keepTogether: boolean;
}

export type StyleMap = Record<string, string | undefined>;

export const PX_PER_MM = 96 / 25.4;

/** A4 用紙の高さ(mm)。`pageContentPx` の基準。 */
const A4_HEIGHT_MM = 297;

/**
 * 1 物理ページの印刷可能コンテンツ高さ(px, 未ズーム)。`@page { margin: ... }` を解釈し、
 * `A4 高さ - 上余白 - 下余白` を返す。fund 別 CSS でも CSS 文字列から拾えるため、ページ境界
 * オーバーレイ(`useGrapes.ts` の `refreshPageGuides`)の超過ページ補助線間隔に使う。
 * `@page` margin が無い CSS では editor canvas の padding(18mm) を既定として補う。
 * margin の値は mm 前提(本データに px/cm 指定は無い)。
 */
export function pageContentPx(css: string): number {
  const m = /@page[^{]*\{[^}]*?margin:\s*([^;}]+)/i.exec(css);
  let top = 18;
  let bottom = 18; // 既定は `a4CanvasCss` の padding と揃える
  if (m) {
    const v = m[1]
      .trim()
      .split(/\s+/)
      .map((s) => Number.parseFloat(s));
    if (v.length === 1) {
      top = bottom = v[0];
    } else if (v.length >= 2) {
      top = v[0];
      bottom = v[2] ?? v[0]; // 1〜2 値は上下=1値目 / 3値目欠落時は top と同値
    }
  }
  return (A4_HEIGHT_MM - top - bottom) * PX_PER_MM;
}

// レイアウト幾何の編集可能レンジ。`Inspector.vue` の入力欄と `EditorView.vue` の
// ドラッグハンドルが共有し、両者が同じ範囲へ clamp する。幅は本文段の % 値、余白は mm。
export const WIDTH_PCT_MIN = 20;
export const WIDTH_PCT_MAX = 100;
export const MARGIN_MM_MIN = 0;
export const MARGIN_MM_MAX = 60;

/** 幅(%)を編集可能レンジ `[WIDTH_PCT_MIN, WIDTH_PCT_MAX]` に clamp する。 */
export function clampWidthPct(n: number): number {
  return Math.max(WIDTH_PCT_MIN, Math.min(WIDTH_PCT_MAX, n));
}

/** 余白(mm)を編集可能レンジ `[MARGIN_MM_MIN, MARGIN_MM_MAX]` に clamp する。 */
export function clampMarginMm(n: number): number {
  return Math.max(MARGIN_MM_MIN, Math.min(MARGIN_MM_MAX, n));
}

/** CSS の length を mm へ変換する(mm/px に対応、それ以外は → 0)。 */
function lenToMm(v: string | undefined): number {
  if (!v) return 0;
  const s = v.trim();
  const n = Number.parseFloat(s);
  if (Number.isNaN(n)) return 0;
  if (s.endsWith('mm')) return Math.round(n);
  if (s.endsWith('px')) return Math.round(n / PX_PER_MM);
  return Math.round(n);
}

function pctToNum(v: string | undefined): number {
  if (!v) return 100;
  const n = Number.parseFloat(v);
  return Number.isNaN(n) ? 100 : Math.round(n);
}

export const DEFAULT_GEOM: LayoutGeom = {
  widthPct: 100,
  align: 'stretch',
  indent: 0,
  marginTop: 0,
  marginBottom: 0,
  pageBreakBefore: false,
  pageBreakAfter: false,
  keepTogether: false,
};

export function geomFromStyle(style: StyleMap): LayoutGeom {
  const widthPct = style.width ? pctToNum(style.width) : 100;
  const mlAuto = style['margin-left'] === 'auto';
  const mrAuto = style['margin-right'] === 'auto';
  let align: Align;
  if (widthPct >= 100) align = 'stretch';
  else if (mlAuto && mrAuto) align = 'center';
  else if (mlAuto) align = 'right';
  else align = 'left';
  const indent = align === 'left' && !mlAuto ? lenToMm(style['margin-left']) : 0;
  const pbBefore = style['page-break-before'] ?? style['break-before'];
  const pbAfter = style['page-break-after'] ?? style['break-after'];
  const breakInside = style['break-inside'] ?? style['page-break-inside'];
  return {
    widthPct,
    align,
    indent,
    marginTop: lenToMm(style['margin-top']),
    marginBottom: lenToMm(style['margin-bottom']),
    pageBreakBefore: pbBefore === 'always' || pbBefore === 'page',
    pageBreakAfter: pbAfter === 'always' || pbAfter === 'page',
    keepTogether: breakInside === 'avoid',
  };
}

/**
 * 幾何を実現する inline-style パッチを生成する。クリアすべき property は `''` に
 * 設定し、呼び出し側が `Component` から該当プロパティを除去できるようにする。
 */
export function geomToStyle(g: LayoutGeom): Record<string, string> {
  const stretch = g.widthPct >= 100;
  return {
    width: stretch ? '' : `${g.widthPct}%`,
    'margin-top': g.marginTop ? `${g.marginTop}mm` : '',
    'margin-bottom': g.marginBottom ? `${g.marginBottom}mm` : '',
    // ブロック配置は auto margin で表現する(width < 100% のときだけ意味を持つ)
    'margin-left': stretch
      ? g.indent
        ? `${g.indent}mm`
        : ''
      : g.align === 'center' || g.align === 'right'
        ? 'auto'
        : g.indent
          ? `${g.indent}mm`
          : '',
    'margin-right': stretch ? '' : g.align === 'center' || g.align === 'left' ? 'auto' : '',
    'page-break-before': g.pageBreakBefore ? 'always' : '',
    'page-break-after': g.pageBreakAfter ? 'always' : '',
    'break-inside': g.keepTogether ? 'avoid' : '',
    'page-break-inside': g.keepTogether ? 'avoid' : '',
  };
}

export const ALIGN_JP: Record<Align, string> = {
  left: '左',
  center: '中央',
  right: '右',
  stretch: '全幅',
};

/** 最初に変化した幾何フィールドを説明する日本語ラベル(変化が無ければ null)。 */
export function geomChangeLabel(before: LayoutGeom, after: LayoutGeom): string | null {
  if (before.widthPct !== after.widthPct)
    return `幅を ${before.widthPct}% → ${after.widthPct}% に変更`;
  if (before.align !== after.align)
    return `横の配置を ${ALIGN_JP[before.align]} → ${ALIGN_JP[after.align]} に変更`;
  if (before.indent !== after.indent)
    return `左インデントを ${before.indent}mm → ${after.indent}mm に変更`;
  if (before.marginTop !== after.marginTop)
    return `上の余白を ${before.marginTop}mm → ${after.marginTop}mm に変更`;
  if (before.marginBottom !== after.marginBottom)
    return `下の余白を ${before.marginBottom}mm → ${after.marginBottom}mm に変更`;
  if (before.pageBreakBefore !== after.pageBreakBefore)
    return `「前で改ページ」を${after.pageBreakBefore ? '有効化' : '解除'}`;
  if (before.pageBreakAfter !== after.pageBreakAfter)
    return `「後で改ページ」を${after.pageBreakAfter ? '有効化' : '解除'}`;
  if (before.keepTogether !== after.keepTogether)
    return `「ページ内で分割しない」を${after.keepTogether ? '有効化' : '解除'}`;
  return null;
}
