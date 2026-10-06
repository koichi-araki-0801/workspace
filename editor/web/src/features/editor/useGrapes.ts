// =============================================================================
// useGrapes.ts — GrapesJS canvas のラッパ composable(3-pane editor の中核)
// =============================================================================
// 役割: GrapesJS の init / ページ送り / 並べ替え / inline style パッチ等を Vue ref として
// 束ね、`useTemplateEditor.ts` へ提供する。イベント配線は `grapesEvents.ts` の
// `wireGrapesEvents` へ、zoom/フィットは `useZoomFit.ts` へ、ページ境界 guide は
// `usePageGuides.ts` へ、選択枠 rect / メモ目印は `useCanvasMarkers.ts` へ委譲する。

import { DOC_DIR, type SampleData } from '@editor/shared';
import grapesjs, {
  type Component,
  type ComponentDefinition,
  type Editor,
  type ParsedNode,
} from 'grapesjs';
import { ref, shallowRef } from 'vue';
import 'grapesjs/dist/css/grapes.min.css';
import { toast } from '@/components/ui/toast';
import { TEMPLATE_CSS_FROM } from '@/lib/fundImages';
import { pageItems, splitPages } from '@/lib/pageBreaks';
import { summarizeExternalCssRefs } from '@/lib/sanitizeCss';
import { pruneCanvasActiveContent } from '@/lib/sanitizeHtml';
import {
  bodyStyleCssTexts,
  bodyStyleParserHtml,
  containsBodyStyle,
  registerBodyStyleComponent,
} from './bodyStyle';
import {
  attachFundImages,
  type FundImageLayer,
  type FundImageLayerOptions,
  registerFundImageView,
} from './fundImageLayer';
import { type FundImageContext, resolveFundImageSrc } from './fundImages';
import { type GrapesCallbacks, wireGrapesEvents } from './grapesEvents';
import {
  JINJA_COMPONENT_TYPE_SET,
  jinjaChipCanvasCss,
  registerJinjaComponents,
} from './jinjaComponents';
import { PAGEBREAK_TYPE, pagebreakCanvasCss, registerPagebreakComponent } from './pagebreakCanvas';
import { clampPageIndex, markPages, PV_ATTR, pageViewCss } from './pageView';
import {
  type BreakEdge,
  PAGEBREAK_HTML,
  type PartBreakState,
  partBreakState,
  planBreakToggle,
} from './partBreak';
import { redlineCanvasCss } from './redline/redlineCss';
import { useCanvasMarkers } from './useCanvasMarkers';
import { usePageGuides } from './usePageGuides';
import { useZoomFit } from './useZoomFit';

// 分離前からの import 元互換(zoom 定数の正典は `useZoomFit`)。
export { ZOOM_STEP } from './useZoomFit';

/**
 * `parse:html:root` の刈り取りトーストを黙らせる間だけ立つフラグ(`parseHtmlQuiet`)。
 * 刈り取り自体は止めない — 赤入れの基準は canvas と同じ正規化を通してこそ形が比較できる。
 * 抑止するのは利用者向けのトーストだけで、基準のパースは load 直後に本文と同じ HTML を
 * もう一度通すため、抑止しないと同じ通知が二重に出て 2 通目は宛先の無い警告になる。
 */
let quietParse = false;

/**
 * 本文の断片を明示の `<body>` で包む。文書の枠(doctype / html / head / body)で始まる入力は
 * GrapesJS が文書として扱うので触らない。
 */
function wrapFragmentInBody(html: string): string {
  return /^\s*<(?:!doctype|html|head|body)[\s>]/i.test(html) ? html : `<body>${html}</body>`;
}

/** ページの分け方が同じ要素の並びか(ページごとに要素の同一性で比べる)。 */
function samePages(a: readonly HTMLElement[][], b: readonly HTMLElement[][]): boolean {
  return (
    a.length === b.length &&
    a.every((page, i) => page.length === b[i].length && page.every((el, j) => el === b[i][j]))
  );
}

/** `useGrapes` の推論戻り値型が参照するため export が必要(TS4058 回避)。 @public */
export interface GrapesContainers {
  canvas: HTMLElement;
  layers: HTMLElement;
}

/**
 * GrapesJS canvas の body を A4 用紙の見た目にする。iframe の幅は index.css の
 * `.gjs-frame*` ルールで A4 幅へ制約し、高さは `init` の device `height:'auto'` により
 * iframe がこの body 実寸(`min-height:297mm`、複数ページなら全長)へ追従する(iframe の
 * 内部スクロールは起きない)。よってここ body 側はページの padding/shadow だけで足りる
 * (自動センタリングの margin は不要)。
 *
 * `[data-gjs-type="wrapper"]` の `min-height:0` は必須: GrapesJS は frame 描画時点で
 * `hasAutoHeight=false` と判断し wrapper へ `min-height:100vh` を注入するが、device
 * `height:'auto'` はその描画後に効く。すると「iframe を body 実寸へ同期する auto-height」と
 * 「100vh = iframe viewport 高」が噛み合い、iframe↔100vh が互いを押し上げる膨張ループになって
 * body が viewport の数十倍(数万 px)に育つ(`fitToView` がそれを測り過剰縮小する)。常に A4 実
 * コンテンツがある本エディタでは 100vh は不要なので 0 で打ち消し、wrapper を実コンテンツ高に保つ。
 */
const a4CanvasCss = `
  html { background: transparent; }
  [data-gjs-type="wrapper"] { min-height: 0 !important; }
  body {
    background: #fff;
    width: 210mm;
    min-height: 297mm;
    margin: 0;
    padding: 18mm 16mm;
    box-sizing: border-box;
    box-shadow: 0 1px 3px rgba(20,28,48,.10), 0 16px 44px -18px rgba(20,28,48,.32);
    font-family: 'Hiragino Mincho ProN','Yu Mincho','Noto Serif JP Variable','Noto Serif JP',serif;
    color: #1f2937;
  }
`;

export interface SelectedInfo {
  id: string;
  name: string;
  isJinja: boolean;
  /** 改ページの区切り(`div.pagebreak`)の部品か。Inspector は幾何と改ページの段を出さない。 */
  isPagebreak?: boolean;
  /** parts catalog から挿入された `Component` の場合の catalog part id。 */
  partId?: string;
}

export interface UseGrapesOptions {
  /** ファンド別画像が配信されるかの確認(`fundImageLayer.ts` の `inspect`)。省略時は問い合わせない。 */
  inspectFundImages?: FundImageLayerOptions['inspect'];
}

export function useGrapes(options: UseGrapesOptions = {}) {
  const editor = shallowRef<Editor>();
  const selected = ref<SelectedInfo | null>(null);
  // canvas で inline text 編集(RTE)中か。GrapesJS は iframe のキー入力を親 document へ
  // 転送するため、編集中はキーボードショートカット側(`useEditorShortcuts.ts`)が undo/redo/
  // delete を横取りしないよう、この flag を見てネイティブのテキスト編集へ委ねる。
  const editing = ref(false);
  /** canvas の read-only フラグ(!allowEdit のミラー)。選択は可だが RTE/drag をブロック。 */
  let locked = false;
  /** `setEditable` の一括 set 適用中フラグ(dirty 抑制用 — `setEditable` のコメントを見よ)。 */
  let applyingLockState = false;
  /** component/style 変更ごとに加算され、呼び出し側が幾何を再計算できるようにする。 */
  const revision = ref(0);
  const canMoveUp = ref(false);
  const canMoveDown = ref(false);
  /** 現在の選択が drag-reorder 可能か(move grip の表示を駆動する)。 */
  const canDragSelected = ref(false);

  // 差し込み値ハイライト(琥珀)を canvas に出すか。設計正典.md「編集 2 系統」に従い
  // 作成経路でのみ true。`setVarsHighlight` が状態を持ち、`load` 後の再描画でも body へ
  // 反映し直す(load で iframe body が差し替わるため)。
  let varsHighlight = false;

  // ファンド別画像の文脈(本文の種類・ファンドコード・会社コード)。
  // `setFundImageContext` が差し替え、差し替え層(`fundImageLayer.ts`)と image view の拡張が読む。
  let fundImageContext: FundImageContext = { mode: 'filled', fundCode: null, companyCode: null };
  let fundImages: FundImageLayer | null = null;
  /** 最後に読み込んだテンプレの CSS(本文の `<style>` が増減したときの複製の作り直しに使う)。 */
  let templateCss = '';
  /** `load` の入れ替え中(部品の追加・削除のたびに複製を作り直さない)。 */
  let replacing = false;
  /** Jinja を含む `<style>` を canvas 用に描画するサンプル。作成タブだけが渡す(`setStyleSample`)。 */
  let styleSample: SampleData | null = null;
  /** canvas の画像参照の警告(`{{` の残る参照・配信されない参照・会社フォルダ不一致)。 */
  const imageWarnings = ref<string[]>([]);

  // ── ページ送り(1 ページだけ表示)の状態。判定は `pageView.ts` の純粋関数に委譲する ──
  /**
   * ページごとのパーツ(根の直下の要素を `@/lib/pageBreaks` の `splitPages` で分けたもの。区切りの
   * 要素は含まない)の cache。canvas が未描画の間は空配列。
   */
  const pageBlocks = shallowRef<HTMLElement[][]>([]);
  /** 数えた区切りの要素(`splitPages` の `breakEls`)。ページ線を帯の上端に引くために使う。 */
  const pageBreakEls = shallowRef<HTMLElement[]>([]);
  /** ページ総数(= `pageBlocks.length`)。 */
  const pageCount = ref(0);
  /** 表示中ページの 0 起点 index。 */
  const currentPageIndex = ref(0);
  /** 1 ページだけ表示するか(既定 ON)。OFF で従来の全ページ連続スクロールへ戻る。 */
  const singlePageMode = ref(true);
  /**
   * 全ページ連続表示中の外側スクロール縦位置(0..1)。`PageRail` のつまみを実位置に合わせる
   * ために `cvScrollHandler` で更新する。1 ページ表示中はスクロールでページを跨がないため
   * 参照されない(レール側は `scrollFraction=null` 扱いでページ中央に置く)。
   */
  const scrollFraction = ref(0);
  /**
   * 他ページを隠すために canvas head へ注入する 2 枚目の `<style>`(load 時の A4/jinja
   * スタイルとは別)。ページ送りのたびに textContent だけ書き換える。getCss には出ない。
   */
  let pageViewStyleEl: HTMLStyleElement | null = null;
  /** editor → caller の通知。下の `onX` setter 群で差し込む。 */
  const callbacks: GrapesCallbacks = {};
  /** zoom フィット計測の基準になる canvas コンテナ(= `init` の `c.canvas`)。 */
  let containerEl: HTMLElement | undefined;
  /**
   * スクロールコンテナ `.gjs-cv-canvas`(= `scrollableCanvas:true` で overflow:auto になる
   * GrapesJS の canvas viewport)。背の高いページはここがスクロールするが、その scroll に対する
   * GrapesJS イベントは無い(`frame:scroll` は iframe document 専用で body overflow:hidden により
   * 発火しない)ため、下の `cvScrollHandler` を直接張って overlay を追従させる。
   */
  let cvScrollEl: HTMLElement | null = null;
  /** `cvScrollEl` に張る scroll listener(`destroy` で剥がすため参照を保持)。 */
  let cvScrollHandler: (() => void) | null = null;

  // ── 分離 composable(選択枠/メモ目印 → guide → zoom の順に依存を注ぐ)。ローカルへ
  //    同名で分配し、既存の呼び出し側(grapesEvents 配線・ページ送り・return)を無改修に保つ ──
  const markers = useCanvasMarkers({
    editor,
    currentPageIndex,
    singlePageMode,
    getContainer: () => containerEl,
  });
  const { selectedRect, noteMarkers, bubbleAnchor, refreshRect, setNoteKeys } = markers;
  /** 直近に呼び出し側が渡した吹き出しの実寸(zoom/layout recompute/選択変更の内部再計測で使う)。 */
  let lastBubbleSize: { width: number; height: number } | null = null;
  /** 保持中の実寸のまま吹き出し配置を測り直す(zoom/layout recompute/選択変更から呼ぶ)。 */
  function refreshBubbleAnchorNow(): void {
    markers.refreshBubbleAnchor(lastBubbleSize);
  }
  /**
   * 吹き出しの配置を測り直す(公開 API)。渡された実寸を保持しておくので、以後の
   * zoom/layout recompute/選択変更による内部再計測でも同じ実寸のまま位置が追従する。
   */
  function refreshBubbleAnchor(bubble: { width: number; height: number } | null): void {
    lastBubbleSize = bubble;
    refreshBubbleAnchorNow();
  }
  /**
   * guide 再計測(`refreshPageGuides`)と同じ契機でメモ目印・吹き出しの両方を測り直す。
   * `afterGuides` はページ送り・外側/iframe 内 scroll・zoom・レイアウト再計算など
   * `refreshPageGuides` を呼ぶ全経路から届くため、ここへ集約すれば「印は更新するが吹き出しは
   * 更新しない」経路を個々の呼び出し元へ足して回らずに塞げる(呼び忘れを構造的に防ぐ)。
   */
  function refreshOverlayMarkers(): void {
    markers.refreshNoteMarkers();
    refreshBubbleAnchorNow();
  }
  const guides = usePageGuides({
    editor,
    pageBlocks,
    breakEls: pageBreakEls,
    afterGuides: refreshOverlayMarkers,
  });
  const { pageGuides, refreshPageGuides } = guides;
  const zoomFit = useZoomFit({
    editor,
    getContainer: () => containerEl,
    afterZoom: () => {
      refreshRect();
      refreshPageGuides();
    },
  });
  const { zoom, setZoom, fitToView, updateScrollMode } = zoomFit;
  // 起動時の初期倍率(既定 100%)。`setInitialZoom` は load 前に呼ぶ想定で、
  // 呼ばれなければ 100% のまま `applyInitialZoom` が当てる。
  let initialZoom = 1;
  function setInitialZoom(z: number): void {
    initialZoom = z;
  }

  function refreshMove(): void {
    const comp = editor.value?.getSelected();
    canDragSelected.value = !locked && !!comp?.get('draggable');
    const parent = comp?.parent();
    if (!comp || !parent) {
      canMoveUp.value = false;
      canMoveDown.value = false;
      return;
    }
    const i = comp.index();
    canMoveUp.value = i > 0;
    canMoveDown.value = i < parent.components().length - 1;
  }

  // guide 算出は usePageGuides.ts、メモ目印は useCanvasMarkers.ts が担う。

  /** page-view style に現在の可視制御 CSS を流し込む(他ページを `display:none` に)。 */
  function applyPageVisibility(): void {
    if (!pageViewStyleEl) return;
    pageViewStyleEl.textContent = pageViewCss(
      currentPageIndex.value,
      pageCount.value,
      singlePageMode.value,
    );
  }

  /** 根の直下の要素をページに分ける(パーツの数え方は `partKey.ts` の `pagesOf` と同じ)。 */
  function splitRoot(root: HTMLElement) {
    const children = Array.from(root.children).filter(
      (el): el is HTMLElement => el instanceof HTMLElement,
    );
    return splitPages(pageItems(children));
  }

  /**
   * canvas のページを数え直し、`PV_ATTR` マーカーを生 DOM へ付け直す。区切りの増減に追従できる
   * よう、content/load/変更時に呼ぶ。赤入れの装飾を置き直した後も
   * 呼ぶ(`refreshPageMarks`) — 根の直下に置かれた削除要素に印が無いと、全ページに出続ける。
   * マーカーは `el.setAttribute`(生 DOM 直書き)で付け、Component モデルには載せない —
   * `editor.getHtml()` はモデルから再生成するため保存内容(getHtml/getCss)を汚さない。
   *
   * 根は `Canvas.getBody()`(= iframe `<body>`)ではなく GrapesJS の wrapper 要素。GrapesJS は
   * body 直下に `[data-gjs-type=wrapper]` を 1 段挟み、本文の要素はその配下に来る。wrapper が
   * まだ描かれていなければ数えない(`load` の `requestAnimationFrame` / `load` イベントで確定する)。
   */
  function recomputePages(): void {
    const root = editor.value?.getWrapper()?.getEl();
    if (!root) {
      pageBlocks.value = [];
      pageBreakEls.value = [];
      pageCount.value = 0;
      return;
    }
    const split = splitRoot(root);
    markPages(root, split);
    // 中身が同じなら差し替えない。赤入れの再計算のたびに呼ぶので、参照だけ変えると `pageBlocks`
    // を見ている側(パーツのラベル・選択の復元)が空振りで再評価される。
    if (!samePages(pageBlocks.value, split.pages)) pageBlocks.value = split.pages;
    pageBreakEls.value = split.breakEls;
    pageCount.value = split.pages.length;
    currentPageIndex.value = clampPageIndex(currentPageIndex.value, pageCount.value);
    applyPageVisibility();
  }

  /** 選択要素が現在ページ外(隠れたページ配下)なら選択を解除する。 */
  function deselectIfHidden(): void {
    const el = editor.value?.getSelected()?.getEl?.();
    if (!el) return;
    const owner = el.closest?.(`[${PV_ATTR}]`) as HTMLElement | null;
    if (owner && owner.getAttribute(PV_ATTR) !== String(currentPageIndex.value)) {
      editor.value?.select(undefined);
    }
  }

  /** 指定ページへ送る(clamp 込み)。可視制御 → 選択整理 → 先頭へ → 幾何再計算。 */
  function goToPage(i: number): void {
    currentPageIndex.value = clampPageIndex(i, pageCount.value);
    applyPageVisibility();
    deselectIfHidden();
    // 1 ページ表示なので scrollTop=0 で現在ページ先頭に揃う。スクロールは外側 `.gjs-cv-canvas`
    // へ移ったため、iframe document に加えてそちらの scrollTop も 0 へ戻す(背の高いページを送った
    // 直後でも当該ページ先頭が見えるように)。
    editor.value?.Canvas.getDocument()?.defaultView?.scrollTo?.(0, 0);
    if (cvScrollEl) cvScrollEl.scrollTop = 0;
    // 再レイアウト後に overlay/guide を測り直す(`setZoom` と同手法)。`updateScrollMode` も
    // 併せて呼ぶ: ページごとに高さが異なると(content がページ実寸を超える等)送り先で
    // 収まり判定が変わり、縦中央寄せ/上揃えの出し分けが要るため。
    requestAnimationFrame(() => {
      refreshRect();
      refreshPageGuides();
      updateScrollMode();
    });
  }

  function nextPage(): void {
    goToPage(currentPageIndex.value + 1);
  }
  function prevPage(): void {
    goToPage(currentPageIndex.value - 1);
  }

  /** 外側スクロール量から縦位置比率(0..1)を測り直す(`PageRail` のつまみ位置用)。 */
  function updateScrollFraction(): void {
    const el = cvScrollEl;
    if (!el) return;
    const range = el.scrollHeight - el.clientHeight;
    scrollFraction.value = range > 0 ? Math.min(Math.max(el.scrollTop / range, 0), 1) : 0;
  }

  /**
   * 全ページ連続表示時に、指定ページ(0 起点)の先頭が見えるよう外側 `.gjs-cv-canvas` を
   * スクロールする。ページ要素は iframe 内に在るため、要素と scroller の `getBoundingClientRect`
   * 差分(= 現在の scroll を織り込んだ表示座標、zoom 反映済み)で目標 scrollTop を求める。
   * 1 ページ表示時は `goToPage` を使う(本関数は呼ばない)。
   */
  function scrollToPage(i: number): void {
    const idx = clampPageIndex(i, pageCount.value);
    currentPageIndex.value = idx;
    // ページの先頭のパーツへ送る(区切りの帯は前のページの末尾に属する)。
    const el = pageBlocks.value[idx]?.[0];
    if (!cvScrollEl || !el) return;
    const delta = el.getBoundingClientRect().top - cvScrollEl.getBoundingClientRect().top;
    cvScrollEl.scrollTop += delta;
    requestAnimationFrame(() => {
      refreshRect();
      refreshPageGuides();
      updateScrollFraction();
    });
  }

  /** 1 ページ表示の ON/OFF を切り替える(OFF で全ページ連続スクロールへ戻る)。 */
  function setSinglePageMode(on: boolean): void {
    singlePageMode.value = on;
    applyPageVisibility();
    // 1 ページ ⇔ 全ページで body 高さが激変し(他ページの display 切替)、guide / overlay の
    // 座標が旧レイアウトのまま残る。ON 化時のみ隠れたページの選択を外し、スクロールを先頭へ戻して
    // 再レイアウト後に縦配置(`ret-canvas-fits`)と guide/選択枠を測り直す(`goToPage`/`setZoom` と同手法)。
    if (on) deselectIfHidden();
    editor.value?.Canvas.getDocument()?.defaultView?.scrollTo?.(0, 0);
    if (cvScrollEl) cvScrollEl.scrollTop = 0;
    requestAnimationFrame(() => {
      updateScrollMode();
      refreshRect();
      refreshPageGuides();
    });
  }

  /** canvas load 時に呼ばれ、可視制御用の 2 枚目 style を生成・保持する。 */
  function onCanvasLoad(doc: Document): void {
    pageViewStyleEl = doc.createElement('style');
    doc.head.appendChild(pageViewStyleEl);
    // iframe (再)ロード毎に、保持中の差し込み値ハイライト状態を新しい body へ反映し直す。
    // GrapesJS は load の rAF 後にも iframe/body を作り直すことがあり、その際クラスが消える
    // ため、load イベントを正典の再適用点にする(設計正典.md「編集 2 系統」)。
    doc.body.classList.toggle('jinja-vars-highlight', varsHighlight);
  }

  function init(c: GrapesContainers): Editor {
    containerEl = c.canvas;
    const ed = grapesjs.init({
      container: c.canvas,
      height: '100%',
      width: 'auto',
      fromElement: false,
      storageManager: false,
      panels: { defaults: [] },
      // `scrollableCanvas:true` で canvas viewport `.gjs-cv-canvas` を overflow:auto の
      // スクロールコンテナにする。device `height:'auto'` で iframe がページ実寸(複数ページなら
      // 全長)へ育つため、ビューポートより背の高いページは外側 canvas で縦スクロールして到達する
      // (これが無いと stock の `.gjs-cv-canvas{overflow:hidden}` がはみ出しをクリップし、下端/上端へ
      // 行けない)。auto-height とは独立(overflow と scroll 読取りのみ変更)。`.gjs-frame-wrapper` の
      // 縦配置は index.css 側で「収まる時=中央 / 超える時=上揃え」に出し分ける。
      canvas: { scrollableCanvas: true },
      // desktop device に `height:'auto'` を与え GrapesJS の auto-height 経路を起こす。
      // これが無いと frame.height は null のまま base CSS `.gjs-frame{height:100%}` で
      // iframe 高が canvas 高(実機 ~800px)に張り付き、A4 body(`min-height:297mm` ~1123px)が
      // それを超えて iframe が内部スクロールしてしまう(zoom は外側 transform なので解消しない)。
      // `auto` 指定時は `Frame.hasAutoHeight()` 経由で iframe body を ResizeObserver 監視し
      // `iframe.style.height = body.scrollHeight` へ同期 + iframe 内へ `body{overflow:hidden}` を
      // 注入するため、iframe がページ実寸(複数ページなら全長)を内包し内部スクロールが消える。
      // `width:''` は desktop 既定どおり(iframe 幅は index.css `.gjs-frame-wrapper` で A4 幅に制約)。
      deviceManager: {
        default: 'desktop',
        devices: [{ id: 'desktop', name: 'Desktop', width: '', height: 'auto' }],
      },
      // Style/Trait/Selector manager は意図的に未マウント(appendTo を渡さない)。
      // 右ペインが代わりに read-only な part property を表示する。
      selectorManager: { componentFirst: true },
      layerManager: { appendTo: c.layers },
      assetManager: { custom: true },
      // 本文の `<style>` は既定のパーサが取り除くので、その前に原文を運ぶ部品の置き場へ
      // 差し替える(`bodyStyle.ts`)。
      parser: { parserHtml: bodyStyleParserHtml },
      // GrapesJS 既定の cssIcons(cdnjs Font Awesome の <link>)を空にし、CDN から
      // 何も取得させない。layer/toolbar icon が使う FA glyph は main.ts の
      // `import 'font-awesome/...'` で代わりにローカル同梱している。
      cssIcons: '',
      // component script 機能(`data-gjs-script` prop)を使わないので、`getHtml()` が
      // 収集した JS を `<script>` として**連結して返す**既定を切る。これが true のままだと、
      // prop の刈り取りを 1 箇所でも迂回された瞬間に draft → 確定テンプレ(git 管理下)へ
      // script が恒久混入する — CSP は表示時の実行を止めるだけで、永続化は止めない。
      // 刈り取りとは独立に効く二重防御なので、片方が破られてももう片方が残る。
      jsInHtml: false,
      // 幾何(幅・余白)は inline `style` 属性に保存する。既定の `avoidInlineStyle:true` は
      // `setStyle` を `#<自動id>{…}` の CssRule へ書き、自動 id が保存内容の一部になる —
      // 再読込で確定版と構造キーが一致しなくなり、ペア同期(パーツ HTML だけ転写)で幾何が
      // 転写されない。inline ならパーツと一体で、id に依存しない。
      avoidInlineStyle: false,
      // 既定 `forceClass:true` は、component 生成時に inline `style` が非空だと自動生成クラス
      // (`.c<cid>`)へ丸ごと移し替える。avoidInlineStyle:false と合わせて使うと、HTML を
      // 読み込むたび(load 直後の再パース含む)に幾何が inline style → 自動クラスへ化けて
      // round-trip が壊れる。false にして「inline style のまま」を維持する。
      forceClass: false,
      // canvas の下地 CSS(既定は `* { box-sizing: border-box } body { margin: 0 }`)は PDF 側
      // の CSS に無く、canvas と PDF の見た目が食い違う。`getCss()` の先頭にも付いて保存 CSS へ
      // 混入し、load のたび規則として積み増す。空にして PDF と同じ CSS で描く(必要な下地は
      // `a4CanvasCss` に明示する)。
      protectedCss: '',
    });

    // canvas へ入る HTML は他ユーザが書いた draft / テンプレ実体で、canvas の iframe は
    // `about:blank` としてアプリのオリジンを継承する。`parse:html:root` は GrapesJS 既定の
    // サニタイズ後・component 化前に発火する唯一の点で、ここで刈れば `load`
    // (= `setComponents`)・part 挿入・snapshot 復帰と、HTML 文字列をパースする全経路を
    // 1 箇所で覆える。
    //
    // 刈り取りは**許可リスト**で、通す `data-gjs-type` の値は `jinjaComponents` が
    // `addType` する型と同一の配列由来にする(片方だけ更新される事故を構造的に消す)。
    // 落とした件数は利用者へ出す — 黙って消すと「保存したら中身が減っていた」事故になる。
    // GrapesJS は本文の断片を `DOMParser` へ素のまま渡して `body` を取る。HTML の構文規則では、
    // 最初の要素・文字より前のコメントは body ではなく文書の直下へ置かれるため、本文の先頭の
    // コメントが読み込みで消える。値入り HTML の往復の印はコメントなので、先頭がブロックの本文は
    // 保存で原文へ戻せなくなる。明示の `<body>` の中で解析させ、先頭のコメントを body に留める。
    ed.on('parse:html:before', (opts: { input: string }) => {
      opts.input = wrapFragmentInBody(opts.input);
    });
    ed.on('parse:html:root', ({ root }: { root: ParsedNode }) => {
      const report = pruneCanvasActiveContent(root, { allowedGjsTypes: JINJA_COMPONENT_TYPE_SET });
      if (quietParse || report.droppedCount === 0) return;
      const detail = [...report.droppedElements, ...report.droppedAttrs].slice(0, 5).join(', ');
      toast(
        `編集キャンバスで扱えない内容を ${report.droppedCount} 件取り除きました（${detail}）。`,
        'error',
      );
    });

    registerJinjaComponents(ed);
    registerBodyStyleComponent(ed);
    registerPagebreakComponent(ed);
    // 本文の `<style>` を足した・消したら canvas の複製を作り直す(`load` は自分で作り直す)。
    ed.on('component:add component:remove', (comp: Component) => {
      if (!replacing && containsBodyStyle(comp)) syncCanvasCssCopy();
    });

    // ファンド別画像は属性を書き換えず、canvas 専用の `<style>` で差す(`fundImageLayer.ts`)。
    // 対象の `<img>` で GrapesJS の代替画像処理が `src` を差し替えるとセレクタが外れるので、
    // view の拡張は component 生成より前のここで行う。
    registerFundImageView(ed, (src) => resolveFundImageSrc(src, fundImageContext) !== null);
    fundImages = attachFundImages(ed, {
      getContext: () => fundImageContext,
      onImagesReady: scheduleLayoutRecompute,
      onCanvasResize: scheduleLayoutRecompute,
      onWarningsChange: (messages) => {
        imageWarnings.value = messages;
      },
      inspect: options.inspectFundImages,
    });

    // GrapesJS 既定の keymap(`core:undo`=⌘z / `core:redo` / `core:component-delete`=
    // backspace,delete 等)を全撤去する。本エディタは自前の snapshot 方式 Undo/Redo
    // (`useSnapshotHistory.ts`)と独自の削除を使い、ショートカットは `useEditorShortcuts.ts`
    // に一本化するため、GrapesJS 側と二重発火させない(誤削除/二重 undo を防ぐ)。
    ed.Keymaps.removeAll();

    wireGrapesEvents(ed, {
      selected,
      selectedRect,
      revision,
      zoom,
      editing,
      refreshRect,
      refreshMove,
      refreshPageGuides,
      recomputeLayout,
      applyInitialZoom: () => setZoom(initialZoom),
      onCanvasLoad,
      toInfo,
      isLocked: () => locked,
      isApplyingLockState: () => applyingLockState,
      canvasCss: `${jinjaChipCanvasCss}\n${a4CanvasCss}\n${redlineCanvasCss}\n${pagebreakCanvasCss}`,
      callbacks,
    });

    editor.value = ed;

    // 選択変更でも吹き出し位置を測り直す(zoom/layout recompute と並ぶ 3 つ目の再計測経路)。
    // `wireGrapesEvents` 側の `component:selected`/`component:deselected` とは別に、同じ
    // event へ追加 listener を張る形(GrapesJS の event emitter は複数購読を許す)。
    ed.on('component:selected component:deselected', () => {
      refreshBubbleAnchorNow();
    });

    // 外側スクロール(`.gjs-cv-canvas`)に overlay を追従させる。grapesjs.init は canvas DOM を
    // 同期描画するので、この時点で querySelector は要素を返す。scroll は連続発火するため rAF で
    // 1 フレーム 1 回へスロットルし、`refreshRect`(選択枠/ハンドル) と `refreshPageGuides`
    // (ページ境界 guide / メモ印)を測り直す。座標は `noScroll:true`(boundingClientRect 基準)で
    // スクロール量を自動で織り込む。
    cvScrollEl = containerEl?.querySelector<HTMLElement>('.gjs-cv-canvas') ?? null;
    if (cvScrollEl) {
      let pending = false;
      cvScrollHandler = () => {
        if (pending) return;
        pending = true;
        requestAnimationFrame(() => {
          pending = false;
          refreshRect();
          refreshPageGuides();
          updateScrollFraction();
        });
      };
      cvScrollEl.addEventListener('scroll', cvScrollHandler, { passive: true });
    }

    return ed;
  }

  // setZoom / updateScrollMode / fitToView は useZoomFit.ts が担う。

  /**
   * content/構成が変わった後の「全部測り直す」正典。  /**
   * content/構成が変わった後の「全部測り直す」正典。順序厳守:
   * `recomputePages`(ページの数え直し) → `refreshPageGuides`(そのページの境目を読む) →
   * `updateScrollMode`(body 高さ変化で縦配置を出し分け)。
   * body 高さ/ページ構成を変える全経路(GrapesJS イベント・`load`・`patchSelectedStyle`)が
   * これを呼ぶことで、`ret-canvas-fits` や guide が旧レイアウトの値に取り残されるのを防ぐ。
   */
  function recomputeLayout(): void {
    recomputePages();
    refreshPageGuides();
    updateScrollMode();
  }

  /**
   * `recomputeLayout` を rAF で 1 フレーム 1 回へ集約する薄ラッパ。`patchSelectedStyle` の
   * geom ハンドルは mousemove ごとにライブ適用されるため、毎回 `recomputeLayout`(ページの
   * 数え直しと全 guide の測位)を同期実行すると drag がジャンクする。`grapesEvents.ts` の
   * `scheduleHeavyRecompute` と同型(あちらは GrapesJS イベント駆動、こちらは setStyle が
   * イベントを出さない programmatic 経路用)。editor 破棄後の保留フレームは各関数の null ガードで no-op。
   */
  let layoutScheduled = false;
  function scheduleLayoutRecompute(): void {
    if (layoutScheduled) return;
    layoutScheduled = true;
    requestAnimationFrame(() => {
      layoutScheduled = false;
      recomputeLayout();
    });
  }

  /**
   * canvas の編集可否を切り替える。`on` が false のとき canvas は read-only:
   * `Component` は選択可のまま(inspector が機能する)だが text 編集や drag は不可。
   * jinja の `Component` は自身も子孫も各自の既定値を保つ。
   */
  function setEditable(on: boolean): void {
    locked = !on;
    const ed = editor.value;
    if (!ed) return;
    // `editable`/`draggable` はモデルの見た目状態で、`getHtml()` の出力(保存内容)には
    // 現れない。だが一括 set は `component:update` を全ノード分発火させ、そのまま
    // dirty/autosave へ流れると**無編集の draft** が生成される(以後プレビュー/申請が
    // draft 経路に入る)。適用中フラグで `fireChange` に濾させる(同期ループなので確実)。
    applyingLockState = true;
    try {
      // jinja の部品は自身も子孫も触らない。固めた要素の子孫は `init` で選択・編集・移動を
      // 止めてあり(`jinjaComponents.ts` の `lockDescendants`)、ここで切り替えると読み込み直後や
      // Undo / Redo のたびに固定が外れる。
      const visit = (c: Component): void => {
        if (String(c.get('type') ?? '').startsWith('jinja-')) return;
        c.set('editable', on);
        c.set('draggable', on);
        c.set('selectable', true);
        c.components().forEach(visit);
      };
      const wrapper = ed.getWrapper();
      if (wrapper) visit(wrapper);
    } finally {
      applyingLockState = false;
    }
  }

  /**
   * 現在の選択に対する native な drag-to-reorder を開始する。発端の mousedown を渡して
   * GrapesJS 組み込みの move command を起動し、Sorter に処理を委ねる。
   * component:drag:start/end を emit する(配線は `init` 内)。
   */
  function startMove(e: MouseEvent): void {
    const ed = editor.value;
    if (!ed || locked || !ed.getSelected()) return;
    try {
      ed.runCommand('tlb-move', { event: e });
    } catch {
      /* move command が無い環境 — 無視する */
    }
  }

  /** 選択を兄弟内で上(-1)/下(+1)へ移動する。 */
  function moveSelected(dir: -1 | 1): void {
    const ed = editor.value;
    const comp = ed?.getSelected();
    const parent = comp?.parent();
    if (!ed || !comp || !parent) return;
    const i = comp.index();
    const total = parent.components().length;
    const j = i + dir;
    if (j < 0 || j >= total) return;
    // move() は現在リストの目標 index へ挿入する。下へ動かす時は +1 が要る
    comp.move(parent, { at: dir > 0 ? j + 1 : j });
    ed.select(comp);
  }

  /** 現在の選択を削除する。 */
  function deleteSelected(): void {
    editor.value?.getSelected()?.remove();
  }

  /** inline style マップ 2 つが同じ property 集合・同じ値かを判定する。 */
  function sameStyleMap(a: Record<string, string>, b: Record<string, string>): boolean {
    const ak = Object.keys(a);
    if (ak.length !== Object.keys(b).length) return false;
    return ak.every((k) => a[k] === b[k]);
  }

  /** 現在の選択の inline style マップ(未選択時は空)。 */
  function selectedStyle(): Record<string, string> {
    return (editor.value?.getSelected()?.getStyle() ?? {}) as Record<string, string>;
  }

  /**
   * 選択へ inline-style パッチを適用する(`''` 値は該当プロパティを除去)。結果が現在の
   * style と同一なら何もしない — `callbacks.change` は autosave の起点なので、値の動かない
   * 適用まで通すと編集していないのに draft が生成される。
   */
  function patchSelectedStyle(patch: Record<string, string>): void {
    const comp = editor.value?.getSelected();
    if (!comp) return;
    const cur = comp.getStyle() as Record<string, string>;
    const next: Record<string, string> = { ...cur };
    for (const [k, v] of Object.entries(patch)) {
      if (v === '') delete next[k];
      else next[k] = v;
    }
    if (sameStyleMap(cur, next)) return;
    comp.setStyle(next);
    // プログラム経由の setStyle は StyleManager の 'style:update' を emit しないため、
    // listener(autosave)への通知と派生 state の更新を自前で行う。`refreshRect` は即時
    // (ライブ値ラベルの体感応答)、break/guide/ページ列挙/縦配置は幅・余白変更で動くため
    // `scheduleLayoutRecompute` で次フレームへ集約する(ハンドル drag の連続適用を間引く)。
    revision.value++;
    refreshRect();
    scheduleLayoutRecompute();
    callbacks.change?.();
  }

  function toInfo(comp: Component): SelectedInfo {
    const type = comp.get('type') ?? '';
    const partId = comp.getAttributes()['data-part-id'];
    return {
      id: comp.getId(),
      name: (comp.get('name') as string) || comp.get('tagName') || 'element',
      isJinja: typeof type === 'string' && type.startsWith('jinja-'),
      isPagebreak: type === PAGEBREAK_TYPE,
      partId: typeof partId === 'string' ? partId : undefined,
    };
  }

  /** `comp` を含む根の直下の component(wrapper 自身・wrapper の外なら undefined)。 */
  function topLevelOf(wrapper: Component, comp: Component | undefined): Component | undefined {
    let top = comp;
    while (top?.parent() && top.parent() !== wrapper) top = top.parent();
    return top?.parent() === wrapper ? top : undefined;
  }

  /**
   * `comp` が属するパーツ(根の直下)の前後の改ページの状態(`partBreak.ts` の `partBreakState`)。
   * 区切りを置けないもの(区切り自身・固めた範囲の包み・未描画)は null。
   */
  function partBreakOf(comp: Component | undefined): PartBreakState | null {
    const wrapper = editor.value?.getWrapper();
    const root = wrapper?.getEl();
    const el = wrapper ? topLevelOf(wrapper, comp)?.getEl() : undefined;
    return root && el ? partBreakState(el, root) : null;
  }

  /**
   * `comp` が属するパーツの前(後ろ)の改ページを ON / OFF する。ON は区切りを 1 つ置き、OFF は
   * 隣の区切りと inline の該当の宣言を消す(何をするかは `partBreak.ts` の `planBreakToggle`)。
   * 変えたら true。状態が変わらない・区切りを置けないときは何もせず false(呼び出し側が Undo を
   * 積まないため)。
   *
   * 区切りの削除・inline の宣言の削除・挿入をこの 1 回の呼び出しで行い、変更の通知も 1 回にする。
   * Undo は呼び出し側が操作の前に積む 1 つの snapshot で、ここでの変更をまとめて戻す。区切りの
   * 要素 → component の照合は `insertIndex` と同じく、呼んだ時点の `getEl()` で行う。
   */
  function setPartBreak(comp: Component | undefined, edge: BreakEdge, on: boolean): boolean {
    const wrapper = editor.value?.getWrapper();
    const root = wrapper?.getEl();
    const top = wrapper ? topLevelOf(wrapper, comp) : undefined;
    const el = top?.getEl();
    if (!wrapper || !root || !top || !el) return false;
    const plan = planBreakToggle(el, root, edge, on);
    if (!plan) return false;
    for (const br of plan.remove) {
      wrapper
        .components()
        .find((c: Component) => c.getEl() === br)
        ?.remove();
    }
    if (plan.stripProps.length > 0) {
      const next = { ...(top.getStyle() as Record<string, string>) };
      for (const k of plan.stripProps) delete next[k];
      top.setStyle(next);
    }
    if (plan.insert) {
      const i = top.index();
      wrapper.append(PAGEBREAK_HTML, { at: plan.insert === 'before' ? i : i + 1 });
    }
    revision.value++;
    scheduleLayoutRecompute();
    callbacks.change?.();
    return true;
  }

  /**
   * 新しいパーツの挿入先(wrapper の `components()` の中の index)。現在ページの範囲の末尾に
   * 入れる: 現在ページのパーツを選んでいればそのパーツ(根の直下)の直後、そうでなければ次の
   * 区切りの直前(最後のページなら wrapper の末尾)。
   *
   * 「現在ページの最後のパーツの直後」にはしない。作成タブの本文は `{% if %}` などの範囲を
   * 根の直下の HTML コメント(範囲の印)で表し、最後のパーツの直後は閉じの印の手前、つまり
   * 枝の中になる。区切りの直前なら印の後ろに入る。
   *
   * 最後のパーツが inline の `page-break-after`(`break-after`)を持ち、区切りの要素が無いときは、
   * 次のページの先頭のパーツの直前に入る。新しいパーツは改ページの後ろなので次のページの先頭に
   * なるが、利用者の書いた改ページ指定は動かさない(挿入のために `style` を書き換えない)。
   *
   * 固めた範囲の包み(`div.jinja-frozen-body`)の中には入れない(中身は原文から作り直すので、
   * 入れても保存で消える)。次の区切りが包みの中にあるときは wrapper の末尾に入る。
   *
   * 位置は呼んだ時点の DOM を数え直して決め、要素 → component は同じ時点の `getEl()` で
   * 照合する。キャッシュ(`pageBlocks`)の要素は再描画で入れ替わっていることがあり、照合が
   * 外れると別のページへ落ちる。
   */
  function insertIndex(wrapper: Component, sel: Component | undefined): number {
    const comps = wrapper.components();
    const root = wrapper.getEl();
    if (!root) return comps.length;
    const split = splitRoot(root);
    const page = split.pages[currentPageIndex.value] ?? [];
    const indexOfEl = (el: Element) => comps.findIndex((c: Component) => c.getEl() === el);
    let top = sel;
    while (top?.parent() && top.parent() !== wrapper) top = top.parent();
    const topEl = top?.parent() === wrapper ? top.getEl() : undefined;
    if (topEl && page.includes(topEl)) {
      const i = indexOfEl(topEl);
      if (i >= 0) return i + 1;
    }
    const last = page[page.length - 1];
    if (!last) return comps.length;
    // 最後のパーツの後ろで最初に来る区切りか次のページのパーツ(inline の改ページで分かれたとき)。
    const next = split.pages[currentPageIndex.value + 1]?.[0];
    let el = last.nextElementSibling;
    while (el && el !== next && !split.breakEls.includes(el as HTMLElement)) {
      el = el.nextElementSibling;
    }
    if (!el) return comps.length;
    const i = indexOfEl(el);
    return i >= 0 ? i : comps.length;
  }

  /**
   * catalog part の HTML を、現在ページの範囲の末尾(`insertIndex`)へ根の直下のパーツとして
   * 挿入し、選択する。
   */
  function insertPart(content: string, partId: string): void {
    const ed = editor.value;
    const wrapper = ed?.getWrapper();
    if (!ed || !wrapper) return;
    const added = wrapper.append(content, { at: insertIndex(wrapper, ed.getSelected()) });
    const root = Array.isArray(added) ? added[0] : added;
    // catalog id を付与し、後の canvas 選択から docs を引けるようにする
    root?.addAttributes?.({ 'data-part-id': partId });
    if (root) ed.select(root); // prototype 同様、挿入した part を選択する
  }

  /**
   * 差し込み値ハイライト(琥珀)の出し分け。`jinja-vars-highlight` クラスを iframe body へ
   * 付け外しし、CSS(`jinjaChipCanvasCss`)の `.jinja-vars-highlight .jinja-chip.jinja-var`
   * を効かせる。body 直書きクラスは `getHtml()`(モデル再生成)に載らず保存出力を汚さない
   * (ページガイド markers と同じ方針)。設計正典.md「編集 2 系統」: 作成経路のみ true。
   */
  function setVarsHighlight(on: boolean): void {
    varsHighlight = on;
    editor.value?.Canvas.getBody()?.classList.toggle('jinja-vars-highlight', on);
  }

  /**
   * canvas 専用の CSS の複製を作り直す(`canvasCssAssets.ts`)。テンプレの CSS の url()(フォント・
   * 背景画像)は canvas では解けないので配信 URL へ直した複製を置き、本文の `<style>` は canvas に
   * 元の規則が無いので全規則を複製する(参照は文書の位置を基準に解く)。どちらも canvas 専用の
   * `<style>` に置くので保存内容(getHtml / getCss)には載らない。中に Jinja を含む `<style>` は
   * 原文を運ぶチップ(レイヤーには見え、消せる)で、作成タブでは `toFilled` と同じサンプルで描画
   * した規則を同じく複製する。描画できないものは複製せず、チップはそのまま残す。
   */
  function syncCanvasCssCopy(): void {
    const texts = bodyStyleCssTexts(editor.value?.getWrapper(), styleSample);
    fundImages?.setCss([
      ...texts.map((text) => ({ css: text, from: DOC_DIR, whole: true })),
      { css: templateCss, from: TEMPLATE_CSS_FROM },
    ]);
  }

  /**
   * Jinja を含む本文の `<style>` を canvas で効かせるためのサンプルを設定する。作成タブだけが
   * `toFilled` と同じサンプルを渡し、編集タブ(値入りの本文で、チップを持たない)は null。
   * `load` より前に呼ぶ(呼んだ時点の canvas の複製も作り直す)。
   */
  function setStyleSample(sample: SampleData | null): void {
    styleSample = sample;
    syncCanvasCssCopy();
  }

  /**
   * 編集画面のファンド別画像の文脈を設定する。`load` より前に呼ぶ(呼んだ時点の canvas も
   * 作り直す)。Jinja 本文は `{{ fund.code }}` を解き、値入り本文は確定パスだけを差す。
   */
  function setFundImageContext(ctx: FundImageContext): void {
    fundImageContext = ctx;
    fundImages?.refresh();
  }

  /**
   * canvas を HTML + CSS で入れ替える。読み込めたら `true`、外部参照 CSS を拒んだら `false`。
   *
   * CSS 検査はここが最終防衛線で、service の入口ガード(`templateEditorService.loadForEdit`)を
   * 通らない経路(snapshot 復元など)も覆う。判定は shared のトークナイザ 1 本を共有する。
   * hit したときは `setComponents` も `setStyle` も呼ばない — CSS だけ落として開くと、
   * 直後の autosave が draft の CSS を空で上書きしてしまう(「拒む」が「削る」に化ける)。
   */
  function load(bodyEditableHtml: string, css: string, opts: { quiet?: boolean } = {}): boolean {
    const ed = editor.value;
    if (!ed) return false;
    const refs = summarizeExternalCssRefs(css);
    if (refs !== null) {
      // quiet の読み込み(確定版の形を測るだけ)では拒むだけにする。呼び出し側は false を見て
      // 測るのをやめ、利用者が開いた本文はこのあと通常の読み込みで同じ検査を通る。
      if (!opts.quiet)
        toast(`CSSに外部参照が含まれるため読み込みを中止しました（${refs}）。`, 'error');
      return false;
    }
    // `quiet` は通知だけを抑止する(拒否・刈り取り自体は通常どおり)。確定版の正規形を
    // 取るための読み込みで使う — 本文の読み込みで同じ通知が出るため、二重に出すと誤解を招く。
    quietParse = !!opts.quiet;
    replacing = true;
    try {
      ed.setComponents(bodyEditableHtml);
    } finally {
      quietParse = false;
      replacing = false;
    }
    // 複製を `setStyle` より先に作り直す。canvas が描かれていれば、元の規則が canvas に入るより
    // 前に複製が置かれている(`fundImageLayer.ts`)。
    templateCss = css;
    syncCanvasCssCopy();
    ed.setStyle(css);
    // setComponents/setStyle 直後は iframe DOM が未描画で、`component:add` の `fireChange`
    // から走る `recomputePages` が wrapper の要素を引けず、ページを数えられない。その結果
    // ページャ(`singlePageMode && pageCount > 1`)が出ない。再レイアウト後に
    // 測り直してページ数 / 境界 guide を確定させる(`goToPage` と同じ `requestAnimationFrame`)。
    requestAnimationFrame(() => {
      recomputeLayout();
      // load で iframe body が差し替わるため、保持中のハイライト状態を再適用する。
      setVarsHighlight(varsHighlight);
      // `component:add` を経ない入れ替えでも、描画後の canvas で差し替え規則を作り直す
      // (同じ内容なら書き直さないので重ねて呼んでよい)。
      fundImages?.refresh();
    });
    return true;
  }

  /**
   * canvas と同じ正規化(`parse:html:root` の刈り取り)を通して HTML を定義木へ変換する。
   * 赤入れの基準づくり用で、刈り取りは通常どおり行い、利用者向けのトーストだけ抑止する
   * (`quietParse` を見よ)。
   */
  function parseHtmlQuiet(html: string): ComponentDefinition[] {
    const ed = editor.value;
    if (!ed) return [];
    quietParse = true;
    try {
      // `parseHtml` は単一定義と配列のどちらも返しうる。呼び出し側を素直にするため配列へ揃える。
      const parsed = ed.Parser.parseHtml(html).html;
      if (!parsed) return [];
      return Array.isArray(parsed) ? parsed : [parsed];
    } finally {
      quietParse = false;
    }
  }

  /**
   * 保存用の body HTML。GrapesJS は選択したパーツに StyleManager の id セレクタを作り、以後
   * `getHtml()` が自動 id(`ccid`)を属性として出力する。その id が draft / Undo snapshot に
   * 混入すると、再読込で確定版と構造キー(`partKey` / 赤入れ)が一致しなくなる。テンプレ由来の
   * id はモデルの明示属性に載っているので、明示属性に無い id だけを落とす。
   */
  function getBodyHtml(): string {
    return (
      editor.value?.getHtml({
        attributes: (comp, attrs) => {
          const explicit = (comp.get('attributes') as Record<string, unknown> | undefined)?.id;
          if (typeof explicit !== 'string' || explicit === '') delete attrs.id;
          return attrs;
        },
      }) ?? ''
    );
  }

  /**
   * 保存用の CSS。`avoidInlineStyle:false` は編集(`patchSelectedStyle`)を inline style の
   * round-trip に保つために要るが、GrapesJS の CSS export(`CssGenerator.buildFromModel`)は
   * この設定値を生成のたびに読み(`!avoidInline && style` — `grapes.mjs`)、inline style を持つ
   * component へ無条件で `#<自動id>{…}` をミラーしてしまう(`avoidInlineStyle` は deprecated で、
   * この二重出力は抑止できない)。GrapesJS 側の component 走査・文字列連結を手元で再実装して
   * 出力を後掛けで漉すと、ライブラリ更新のたびにその実装とズレる恐れがある。`getConfig()` は
   * 生の設定オブジェクト(参照)を返し `buildFromModel` は毎回そこを読むだけなので、
   * `getCss()` を呼ぶ**同期呼び出しの間だけ** `avoidInlineStyle` を立ててミラーを生成元で
   * 止め、`finally` で必ず戻す(他の経路 — `patchSelectedStyle` 等 — は非同期に挟まらないので
   * 影響しない)。
   *
   * `keepUnusedStyles` も立てる。既定の GrapesJS は、文書のどの要素も使っていない単純な
   * セレクタの規則を書き出さない。CSS はテンプレ単位のファイルで基準日をまたいで共有するので、
   * この文書で使っていない規則(別の基準日の文書が使う規則、最後の要素を消したクラスの規則)を
   * 落とすと、承認でファイルからもペアの CSS からも消える。下書き・申請・CSS の baseline は
   * すべてここを通すので、どれも同じ「全規則」の形になる。
   */
  function getCss(): string {
    const ed = editor.value;
    if (!ed) return '';
    const cfg = ed.getConfig() as { avoidInlineStyle?: boolean };
    const prev = cfg.avoidInlineStyle;
    cfg.avoidInlineStyle = true;
    try {
      return ed.getCss({ keepUnusedStyles: true }) ?? '';
    } finally {
      cfg.avoidInlineStyle = prev;
    }
  }

  function onChange(cb: () => void): void {
    callbacks.change = cb;
  }

  /** inline text 編集が開始(RTE 有効化)— undo 用 snapshot を取る好機。 */
  function onTextEditStart(cb: () => void): void {
    callbacks.textStart = cb;
  }
  /** inline text 編集が終了。`changed` は内容が変わった場合のみ true。 */
  function onTextEditEnd(cb: (changed: boolean) => void): void {
    callbacks.textEnd = cb;
  }

  /** canvas の drag-reorder が開始 — undo 用 snapshot を取る好機。 */
  function onReorderStart(cb: () => void): void {
    callbacks.reorderStart = cb;
  }
  /** canvas の drag-reorder が終了。`moved` は順序が変わった場合のみ true。 */
  function onReorderEnd(cb: (moved: boolean) => void): void {
    callbacks.reorderEnd = cb;
  }

  /** canvas のダブルクリック。ロック中の編集ジェスチャ検知(ガイド表示)に使う。 */
  function onCanvasDblClick(cb: () => void): void {
    callbacks.canvasDblClick = cb;
  }

  function destroy(): void {
    // 外側スクロール listener を先に剥がす(editor 破棄で DOM は消えるが寿命を明示し leak を防ぐ)。
    if (cvScrollEl && cvScrollHandler) cvScrollEl.removeEventListener('scroll', cvScrollHandler);
    cvScrollEl = null;
    cvScrollHandler = null;
    fundImages?.destroy();
    fundImages = null;
    editor.value?.destroy();
    editor.value = undefined;
  }

  return {
    editor,
    selected,
    editing,
    selectedRect,
    canMoveUp,
    canMoveDown,
    canDragSelected,
    pageGuides,
    noteMarkers,
    bubbleAnchor,
    setNoteKeys,
    refreshBubbleAnchor,
    pageBlocks,
    pageCount,
    currentPageIndex,
    singlePageMode,
    scrollFraction,
    zoom,
    revision,
    init,
    load,
    setVarsHighlight,
    setFundImageContext,
    setStyleSample,
    imageWarnings,
    parseHtmlQuiet,
    insertPart,
    partBreakOf,
    setPartBreak,
    getBodyHtml,
    getCss,
    onChange,
    onTextEditStart,
    onTextEditEnd,
    onReorderStart,
    onReorderEnd,
    onCanvasDblClick,
    setZoom,
    fitToView,
    setInitialZoom,
    setEditable,
    goToPage,
    scrollToPage,
    nextPage,
    prevPage,
    setSinglePageMode,
    refreshRect,
    refreshPageGuides,
    refreshPageMarks: recomputePages,
    updateScrollMode,
    startMove,
    moveSelected,
    deleteSelected,
    selectedStyle,
    patchSelectedStyle,
    destroy,
  };
}
