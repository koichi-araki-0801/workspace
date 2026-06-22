// =============================================================================
// useGrapes.ts — GrapesJS canvas のラッパ composable(3-pane editor の中核)
// =============================================================================
// 役割: GrapesJS の init / 選択 rect / ページ境界 guide / zoom / 並べ替え /
// inline style パッチ等を Vue ref として束ね、`useTemplateEditor.ts` へ提供する。
// イベント配線は `grapesEvents.ts` の `wireGrapesEvents` へ委譲する。

import { toAppError } from '@editor/shared';
import grapesjs, { type Component, type Editor } from 'grapesjs';
import { ref, shallowRef } from 'vue';
import { logError } from '@/lib/appError';
import 'grapesjs/dist/css/grapes.min.css';
import { type GrapesCallbacks, type SelectedRect, wireGrapesEvents } from './grapesEvents';
import { jinjaChipCanvasCss, registerJinjaComponents } from './jinjaComponents';

/**
 * A4 sheet 上に描く 1 本のページ境界 guide(canvas 相対 / zoom 考慮の座標、
 * `SelectedRect` と同様)。実際の page break(`break-*` / `page-break-*`、class 由来の
 * `.page` を含む)= 論理ページブロックの末尾だけを表す。改ページ判定は page break のみで
 * 行い、297mm の高さ推定(estimate)は描かない(`refreshPageGuides` を見よ)。
 */
export interface PageGuide {
  top: number;
  left: number;
  width: number;
  /** この境界で*終わる*累積ページ番号(「ここまで N ページ目」)。 */
  page: number;
}

export interface GrapesContainers {
  canvas: HTMLElement;
  layers: HTMLElement;
}

// canvas の zoom 範囲とクリック毎のステップ。`EditorView.vue` の zoom in/out ボタンと
// 共有し、`setZoom` と同じ範囲へ clamp させる。
export const ZOOM_MIN = 0.4;
export const ZOOM_MAX = 1.4;
export const ZOOM_STEP = 0.1;

/**
 * GrapesJS canvas の body を A4 用紙の見た目にする。iframe 自体は index.css の
 * `.gjs-frame*` ルールで A4 幅へ制約しているため、ここ body 側はページの
 * padding/shadow だけで足りる(自動センタリングの margin は不要)。
 */
const a4CanvasCss = `
  html { background: transparent; }
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
  const zoom = ref(1);
  /** canvas の read-only フラグ(!allowEdit のミラー)。選択は可だが RTE/drag をブロック。 */
  let locked = false;
  /** component/style 変更ごとに加算され、呼び出し側が幾何を再計算できるようにする。 */
  const revision = ref(0);
  /** overlay 用に保持する選択要素の画面 rect(canvas 相対, zoom 考慮)。 */
  const selectedRect = ref<SelectedRect | null>(null);
  const canMoveUp = ref(false);
  const canMoveDown = ref(false);
  /** 現在の選択が drag-reorder 可能か(move grip の表示を駆動する)。 */
  const canDragSelected = ref(false);
  /** ページ境界の overlay guide 群(`refreshPageGuides` を見よ)。 */
  const pageGuides = ref<PageGuide[]>([]);
  /**
   * `recomputeBreakEls` が cache する page-break 要素。画面上の位置は scroll/zoom
   * ごとに `refreshPageGuides` が読み直す。
   */
  let breakEls: { el: HTMLElement; edge: 'before' | 'after' }[] = [];
  /** editor → caller の通知。下の `onX` setter 群で差し込む。 */
  const callbacks: GrapesCallbacks = {};

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

  /** `break-*` / `page-break-*` で使う page-break キーワードに該当すれば true。 */
  function isBreakValue(v: string | undefined): boolean {
    return (
      v === 'always' ||
      v === 'page' ||
      v === 'left' ||
      v === 'right' ||
      v === 'recto' ||
      v === 'verso'
    );
  }

  /**
   * canvas document を走査し、印刷ページの開始/終了となる要素を `break-before/after`
   * や旧来の `page-break-*` から拾う。class 由来のルール(例
   * `.page { page-break-after: always }`)も含むが、それらは computed style にしか
   * 現れない(inline 専用の `geom.ts` の `geomFromStyle` は取りこぼす)。全ノードの
   * computed style を読むため重い。よって content/style 変更時のみ走らせ、
   * `refreshPageGuides` は scroll/zoom 時に cache 済み集合を再利用する。
   */
  function recomputeBreakEls(): void {
    const ed = editor.value;
    const doc = ed?.Canvas.getDocument();
    const win = doc?.defaultView;
    const body = ed?.Canvas.getBody();
    if (!doc || !win || !body) {
      breakEls = [];
      return;
    }
    const out: { el: HTMLElement; edge: 'before' | 'after' }[] = [];
    for (const el of Array.from(body.querySelectorAll<HTMLElement>('*'))) {
      const cs = win.getComputedStyle(el);
      if (isBreakValue(cs.breakBefore || cs.pageBreakBefore)) out.push({ el, edge: 'before' });
      if (isBreakValue(cs.breakAfter || cs.pageBreakAfter)) out.push({ el, edge: 'after' });
    }
    breakEls = out;
  }

  /**
   * 連続スクロールの canvas(`page-break-*` は画面レイアウトに効かない)の上に、
   * ページ境界 guide 線を再計算する。改ページ判定は実際の page break のみで行う:
   *
   * - cache 済みの各 break(`.page` 末尾、`break-*` / `page-break-*`)を hard break =
   *   論理ページの末尾とみなし、その位置に guide を 1 本引く。
   * - guide は出現順に累積ページ番号を付ける(「ここまで N ページ目」)。
   *
   * 高さ 297mm 由来の estimate(推定改ページ)は描かない。厳密な改ページは
   * Vivliostyle preview の役目であり、ここは page break 位置の可視化に徹する。
   */
  function refreshPageGuides(): void {
    const ed = editor.value;
    const body = ed?.Canvas.getBody();
    if (!ed || !body) {
      pageGuides.value = [];
      return;
    }
    try {
      const bodyPos = ed.Canvas.getElementPos(body);
      const top0 = bodyPos.top;
      const bottom = bodyPos.top + bodyPos.height;

      // hard break(論理ページ末尾)を昇順に並べ、端ぎりぎりのものは捨てる。
      const hard = breakEls
        .map(({ el, edge }) => {
          const p = ed.Canvas.getElementPos(el);
          return edge === 'before' ? p.top : p.top + p.height;
        })
        .filter((t) => t > top0 + 1 && t < bottom - 1)
        .sort((a, b) => a - b);

      // 各 hard break に guide を 1 本ずつ。番号は出現順の累積ページ。
      pageGuides.value = hard.map((top, i) => ({
        top,
        left: bodyPos.left,
        width: bodyPos.width,
        page: i + 1,
      }));
    } catch (e) {
      // 幾何の再計算に失敗(canvas の一時的な状態) — guide を静かに隠す。
      logError(toAppError(e));
      pageGuides.value = [];
    }
  }

  /** 選択要素の画面上 rect を再計算する(浮動ツールバー / ハンドル用)。 */
  function refreshRect(): void {
    const ed = editor.value;
    const comp = ed?.getSelected();
    const el = comp?.getEl?.();
    if (!ed || !el) {
      selectedRect.value = null;
      return;
    }
    try {
      const p = ed.Canvas.getElementPos(el);
      selectedRect.value = { left: p.left, top: p.top, width: p.width, height: p.height };
    } catch (e) {
      // 幾何の再計算に失敗(canvas の一時的な状態) — 観測のため log は残すが、
      // toast でユーザーに見せず toolbar を隠したままにする。
      logError(toAppError(e));
      selectedRect.value = null;
    }
  }

  function init(c: GrapesContainers): Editor {
    const ed = grapesjs.init({
      container: c.canvas,
      height: '100%',
      width: 'auto',
      fromElement: false,
      storageManager: false,
      panels: { defaults: [] },
      // Style/Trait/Selector manager は意図的に未マウント(appendTo を渡さない)。
      // 右ペインが代わりに read-only な part property を表示する。
      selectorManager: { componentFirst: true },
      layerManager: { appendTo: c.layers },
      assetManager: { custom: true },
      // GrapesJS 既定の cssIcons(cdnjs Font Awesome の <link>)を空にし、CDN から
      // 何も取得させない。layer/toolbar icon が使う FA glyph は main.ts の
      // `import 'font-awesome/...'` で代わりにローカル同梱している。
      cssIcons: '',
    });

    registerJinjaComponents(ed);

    wireGrapesEvents(ed, {
      selected,
      selectedRect,
      revision,
      zoom,
      refreshRect,
      refreshMove,
      recomputeBreakEls,
      refreshPageGuides,
      toInfo,
      isLocked: () => locked,
      canvasCss: `${jinjaChipCanvasCss}\n${a4CanvasCss}`,
      callbacks,
    });

    editor.value = ed;
    return ed;
  }

  function setZoom(z: number): void {
    const clamped = Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, Math.round(z * 100) / 100));
    zoom.value = clamped;
    editor.value?.Canvas.setZoom(clamped * 100);
    requestAnimationFrame(() => {
      refreshRect();
      refreshPageGuides();
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
    // listener(autosave)への通知と派生 state の更新を自前で行う。
    revision.value++;
    refreshRect();
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

  /** catalog part の HTML を現在の選択の後ろ(無ければ末尾)に挿入する。 */
  function insertPart(content: string, partId: string): void {
    const ed = editor.value;
    if (!ed) return;
    const sel = ed.getSelected();
    const parent = sel?.parent();
    const added =
      parent && sel
        ? parent.append(content, { at: sel.index() + 1 })
        : ed.getWrapper()?.append(content);
    const root = Array.isArray(added) ? added[0] : added;
    // catalog id を付与し、後の canvas 選択から docs を引けるようにする
    root?.addAttributes?.({ 'data-part-id': partId });
    if (root) ed.select(root); // prototype 同様、挿入した part を選択する
  }

  function load(bodyEditableHtml: string, css: string): void {
    const ed = editor.value;
    if (!ed) return;
    ed.setComponents(bodyEditableHtml);
    ed.setStyle(css);
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

  function destroy(): void {
    editor.value?.destroy();
    editor.value = undefined;
  }

  return {
    editor,
    selected,
    selectedRect,
    canMoveUp,
    canMoveDown,
    canDragSelected,
    pageGuides,
    zoom,
    revision,
    init,
    load,
    insertPart,
    getBodyHtml,
    getCss,
    onChange,
    onTextEditStart,
    onTextEditEnd,
    onReorderStart,
    onReorderEnd,
    setZoom,
    setEditable,
    refreshRect,
    refreshPageGuides,
    startMove,
    moveSelected,
    deleteSelected,
    selectedStyle,
    patchSelectedStyle,
    destroy,
  };
}
