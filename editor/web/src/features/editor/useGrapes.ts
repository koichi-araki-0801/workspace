// =============================================================================
// useGrapes.ts — GrapesJS canvas のラッパ composable(3-pane editor の中核)
// =============================================================================
// 役割: GrapesJS の init / ページ送り / 並べ替え / inline style パッチ等を Vue ref として
// 束ね、`useTemplateEditor.ts` へ提供する。イベント配線は `grapesEvents.ts` の
// `wireGrapesEvents` へ、zoom/フィットは `useZoomFit.ts` へ、ページ境界 guide は
// `usePageGuides.ts` へ、選択枠 rect / メモ目印は `useCanvasMarkers.ts` へ委譲する。

import grapesjs, { type Component, type Editor, type ParsedNode } from 'grapesjs';
import { ref, shallowRef } from 'vue';
import 'grapesjs/dist/css/grapes.min.css';
import { toast } from '@/components/ui/toast';
import { pruneCanvasActiveContent } from '@/lib/sanitizeHtml';
import { type GrapesCallbacks, wireGrapesEvents } from './grapesEvents';
import {
  JINJA_COMPONENT_TYPE_SET,
  jinjaChipCanvasCss,
  registerJinjaComponents,
} from './jinjaComponents';
import {
  clampPageIndex,
  enumeratePageEls,
  PV_ATTR,
  pageViewCss,
  strayDirectChildren,
} from './pageView';
import { useCanvasMarkers } from './useCanvasMarkers';
import { usePageGuides } from './usePageGuides';
import { useZoomFit } from './useZoomFit';

// 分離前からの import 元互換(zoom 定数の正典は `useZoomFit`)。
export { ZOOM_STEP } from './useZoomFit';

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
  /** parts catalog から挿入された `Component` の場合の catalog part id。 */
  partId?: string;
}

export function useGrapes() {
  const editor = shallowRef<Editor>();
  const selected = ref<SelectedInfo | null>(null);
  // canvas で inline text 編集(RTE)中か。GrapesJS は iframe のキー入力を親 document へ
  // 転送するため、編集中はキーボードショートカット側(`useEditorShortcuts.ts`)が undo/redo/
  // delete を横取りしないよう、この flag を見てネイティブのテキスト編集へ委ねる。
  const editing = ref(false);
  /** canvas の read-only フラグ(!allowEdit のミラー)。選択は可だが RTE/drag をブロック。 */
  let locked = false;
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

  // ── ページ送り(1 ページだけ表示)の状態。判定は `pageView.ts` の純粋関数に委譲する ──
  /** 現在 canvas に在るページ要素(`body > .page`、無ければ `[body]`)の cache。 */
  const pageEls = shallowRef<HTMLElement[]>([]);
  /** ページ総数(= `pageEls.length`)。 */
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
  const markers = useCanvasMarkers({ editor, pageEls, currentPageIndex, singlePageMode });
  const { selectedRect, noteMarkers, refreshRect, setNoteKeys } = markers;
  const guides = usePageGuides({ editor, afterGuides: markers.refreshNoteMarkers });
  const { pageGuides, recomputeBreakEls, refreshPageGuides } = guides;
  const zoomFit = useZoomFit({
    editor,
    getContainer: () => containerEl,
    afterZoom: () => {
      refreshRect();
      refreshPageGuides();
    },
  });
  const { zoom, setZoom, fitToView, updateScrollMode } = zoomFit;

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

  // break 収集 / guide 算出は usePageGuides.ts、メモ目印は useCanvasMarkers.ts が担う。

  /** page-view style に現在の可視制御 CSS を流し込む(他ページを `display:none` に)。 */
  function applyPageVisibility(): void {
    if (!pageViewStyleEl) return;
    pageViewStyleEl.textContent = pageViewCss(
      currentPageIndex.value,
      pageCount.value,
      singlePageMode.value,
    );
  }

  /**
   * canvas のページ要素を列挙し直し、`PV_ATTR` マーカーを生 DOM へ付け直す。content 変更で
   * `.page` が増減しても追従できるよう、`recomputeBreakEls` と同じく content/load/変更時に呼ぶ。
   * マーカーは `el.setAttribute`(生 DOM 直書き)で付け、Component モデルには載せない —
   * `editor.getHtml()` はモデルから再生成するため保存内容(getHtml/getCss)を汚さない。
   *
   * 列挙の起点は `Canvas.getBody()`(= iframe `<body>`)ではなく GrapesJS の wrapper 要素。
   * GrapesJS は body 直下に `[data-gjs-type=wrapper]` を 1 段挟み、ページ要素(`.page`)は
   * その配下に来る。body.children では wrapper しか拾えず `enumeratePageEls` が `.page` を
   * 0 件と判定してしまうため、content root を wrapper にする(未描画の早期タイミングだけ
   * body へフォールバック。`load` の `requestAnimationFrame` / `load` イベントで確定する)。
   */
  function recomputePages(): void {
    const root = editor.value?.getWrapper()?.getEl() ?? editor.value?.Canvas.getBody();
    if (!root) {
      pageEls.value = [];
      pageCount.value = 0;
      return;
    }
    // 旧マーカーを一掃してから、新しい列挙結果へ index を振り直す。
    for (const el of Array.from(root.querySelectorAll<HTMLElement>(`[${PV_ATTR}]`))) {
      el.removeAttribute(PV_ATTR);
    }
    const els = enumeratePageEls(root);
    els.forEach((el, i) => {
      el.setAttribute(PV_ATTR, String(i));
    });
    pageEls.value = els;
    pageCount.value = els.length;
    currentPageIndex.value = clampPageIndex(currentPageIndex.value, pageCount.value);
    // 防御的措置: wrapper 直下に `.page` でない孤立要素が生じても全ページ重複しないよう、
    // 現在ページと同じ `PV_ATTR` を付けて「現在ページの一部」として扱う(`strayDirectChildren`)。
    // root が body フォールバック(`.page` 0 件 / `els===[root]`)のときは付けない(全体が 1 ページ)。
    if (pageCount.value > 0 && els[0] !== root) {
      for (const el of strayDirectChildren(root)) {
        el.setAttribute(PV_ATTR, String(currentPageIndex.value));
      }
    }
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
    const el = pageEls.value[idx];
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
    ed.on('parse:html:root', ({ root }: { root: ParsedNode }) => {
      const report = pruneCanvasActiveContent(root, { allowedGjsTypes: JINJA_COMPONENT_TYPE_SET });
      if (report.droppedCount === 0) return;
      const detail = [...report.droppedElements, ...report.droppedAttrs].slice(0, 5).join(', ');
      toast(
        `編集キャンバスで扱えない内容を ${report.droppedCount} 件取り除きました（${detail}）。`,
        'error',
      );
    });

    registerJinjaComponents(ed);

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
      fitToView,
      onCanvasLoad,
      toInfo,
      isLocked: () => locked,
      canvasCss: `${jinjaChipCanvasCss}\n${a4CanvasCss}`,
      callbacks,
    });

    editor.value = ed;

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
   * `recomputeBreakEls`(break 集合更新) → `refreshPageGuides`(その集合を読む) →
   * `recomputePages`(.page 列挙) → `updateScrollMode`(body 高さ変化で縦配置を出し分け)。
   * body 高さ/ページ構成を変える全経路(GrapesJS イベント・`load`・`patchSelectedStyle`)が
   * これを呼ぶことで、`ret-canvas-fits` や guide が旧レイアウトの値に取り残されるのを防ぐ。
   */
  function recomputeLayout(): void {
    recomputeBreakEls();
    refreshPageGuides();
    recomputePages();
    updateScrollMode();
  }

  /**
   * `recomputeLayout` を rAF で 1 フレーム 1 回へ集約する薄ラッパ。`patchSelectedStyle` の
   * geom ハンドルは mousemove ごとにライブ適用されるため、毎回 `recomputeBreakEls`(全要素
   * `getComputedStyle` = O(n))を同期実行すると drag がジャンクする。`grapesEvents.ts` の
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
   * jinja の `Component` は各自の既定値を保つ。
   */
  function setEditable(on: boolean): void {
    locked = !on;
    const ed = editor.value;
    if (!ed) return;
    ed.getWrapper()?.onAll((c) => {
      const type = String(c.get('type') ?? '');
      if (type.startsWith('jinja-')) return; // jinja の locked 挙動は保つ
      c.set('editable', on);
      c.set('draggable', on);
      c.set('selectable', true);
    });
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

  /** 現在の選択の inline style マップ(未選択時は空)。 */
  function selectedStyle(): Record<string, string> {
    return (editor.value?.getSelected()?.getStyle() ?? {}) as Record<string, string>;
  }

  /** 選択へ inline-style パッチを適用する(`''` 値は該当プロパティを除去)。 */
  function patchSelectedStyle(patch: Record<string, string>): void {
    const comp = editor.value?.getSelected();
    if (!comp) return;
    const next: Record<string, string> = { ...(comp.getStyle() as Record<string, string>) };
    for (const [k, v] of Object.entries(patch)) {
      if (v === '') delete next[k];
      else next[k] = v;
    }
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
      partId: typeof partId === 'string' ? partId : undefined,
    };
  }

  /**
   * 現在表示中ページ(`.page`)の Component を返す(`.page` が 1 件も無ければ undefined)。
   * `wrapper.components()` から `.page` Component を毎回ライブに filter し、
   * `currentPageIndex` 番目(範囲外は末尾フォールバック、`clampPageIndex` と整合)を返す。
   *
   * `pageEls`(生 DOM キャッシュ)との `getEl() === pageEl` 同一性照合にはしない。
   * GrapesJS の `getEl()` は描画済みでないと有効でなく、`load`/再レイアウト/`fireChange` の
   * 再描画で `pageEls` が detach すると照合が外れて undefined を返し、`insertPart` が
   * wrapper 直下 append にフォールバック → 孤立要素が全ページ重複する。
   * Component を class で直接引くことで stale な生 DOM 参照に依存しない。
   * (`components()` のイテレーション順は DOM 子順と一致するため index 参照してよい。)
   */
  function currentPageComponent(): Component | undefined {
    const wrapper = editor.value?.getWrapper();
    if (!wrapper) return undefined;
    const pages = wrapper
      .components()
      .filter((c: Component) => c.getEl?.()?.classList?.contains('page'));
    if (pages.length === 0) return undefined;
    return pages[currentPageIndex.value] ?? pages[pages.length - 1];
  }

  /**
   * catalog part の HTML を挿入する。挿入先は「現在ページの `.page` 配下」に限定する:
   * ページ内の要素を選択中ならその直後へ、そうでなければ(選択なし / `.page` 自身を選択)
   * 現在ページの末尾へ append する。wrapper 直下へ落とすと `.page` の兄弟=どのページにも
   * 属さない孤立要素になり、ページ可視制御(`data-pv-idx`)の対象外として全ページに
   * 出続けるため、それを避ける。`.page` を持たない fallback 時のみ wrapper へ。
   */
  function insertPart(content: string, partId: string): void {
    const ed = editor.value;
    if (!ed) return;
    const wrapper = ed.getWrapper();
    const sel = ed.getSelected();
    const parent = sel?.parent();
    // 選択要素が「現在ページの `.page` 子孫」のときだけ、その直後へ挿入する。選択が現在ページ外
    // (再描画で選択が別ページ要素へずれた等)を指す場合は別ページ/孤立要素直下へ落ちうるため、
    // 現在ページ判定(`deselectIfHidden` と同型)で弾き、`currentPageComponent` 経由へ回す。
    const owner = sel?.getEl?.()?.closest?.(`[${PV_ATTR}]`) as HTMLElement | null;
    const selInCurrentPage = owner?.getAttribute(PV_ATTR) === String(currentPageIndex.value);
    const added =
      sel && parent && parent !== wrapper && selInCurrentPage
        ? parent.append(content, { at: sel.index() + 1 })
        : (currentPageComponent() ?? wrapper)?.append(content);
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

  function load(bodyEditableHtml: string, css: string): void {
    const ed = editor.value;
    if (!ed) return;
    ed.setComponents(bodyEditableHtml);
    ed.setStyle(css);
    // setComponents/setStyle 直後は iframe DOM が未描画で、`component:add` の `fireChange`
    // から走る `recomputePages` が `.page` を拾えず `[body]` フォールバック(`pageCount=1`)に
    // 落ちる。その結果ページャ(`singlePageMode && pageCount > 1`)が出ない。再レイアウト後に
    // 測り直してページ数 / 境界 guide を確定させる(`goToPage` と同じ `requestAnimationFrame`)。
    requestAnimationFrame(() => {
      recomputeLayout();
      // load で iframe body が差し替わるため、保持中のハイライト状態を再適用する。
      setVarsHighlight(varsHighlight);
    });
  }

  function getBodyHtml(): string {
    return editor.value?.getHtml() ?? '';
  }

  function getCss(): string {
    return editor.value?.getCss() ?? '';
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
    setNoteKeys,
    pageCount,
    currentPageIndex,
    singlePageMode,
    scrollFraction,
    zoom,
    revision,
    init,
    load,
    setVarsHighlight,
    insertPart,
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
    setEditable,
    goToPage,
    scrollToPage,
    nextPage,
    prevPage,
    setSinglePageMode,
    refreshRect,
    refreshPageGuides,
    updateScrollMode,
    startMove,
    moveSelected,
    deleteSelected,
    selectedStyle,
    patchSelectedStyle,
    destroy,
  };
}
