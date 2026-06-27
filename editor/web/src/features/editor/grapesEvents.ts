// =============================================================================
// grapesEvents.ts — GrapesJS editor のイベント配線(3-pane editor 用)
// =============================================================================
// 役割: `useGrapes.ts` の `init` から委譲され、selection / RTE / drag-reorder /
// page-break 等の listener をまとめて登録する。`init` を小さく保つための分離で、
// イベントの意味・名前・登録順は inline 版と不変。

import type { Component, Editor } from 'grapesjs';
import type { Ref } from 'vue';
import type { SelectedInfo } from './useGrapes';

/** overlay 用に保持する選択要素の画面 rect(canvas 相対, zoom 考慮)。 */
export interface SelectedRect {
  left: number;
  top: number;
  width: number;
  height: number;
}

/**
 * editor → caller への通知。mutable にしてあるのは、editor 配線後に `useGrapes.ts` の
 * `onChange` 等が後付けで handler を差し込めるようにするため。listener は発火時点の
 * 現在値を読む。
 */
export interface GrapesCallbacks {
  change?: () => void;
  textStart?: () => void;
  textEnd?: (changed: boolean) => void;
  reorderStart?: () => void;
  reorderEnd?: (moved: boolean) => void;
}

export interface GrapesEventDeps {
  selected: Ref<SelectedInfo | null>;
  selectedRect: Ref<SelectedRect | null>;
  /** component/style 変更ごとに加算され、呼び出し側が幾何を再計算できるようにする。 */
  revision: Ref<number>;
  zoom: Ref<number>;
  refreshRect: () => void;
  refreshMove: () => void;
  /** canvas を再走査して page-break 要素を拾い直す(content/style 変更時のみ)。 */
  recomputeBreakEls: () => void;
  /** ページ境界 guide の位置を読み直す(scroll/zoom/content 変更時)。 */
  refreshPageGuides: () => void;
  /** ページ要素(`body > .page`)を列挙し直し、1 ページ表示の可視制御を更新する。 */
  recomputePages: () => void;
  /** canvas を A4 ページ全体が収まる倍率へ合わせる(起動時の初期ズーム)。 */
  fitToView: () => void;
  /** canvas load 時に呼ぶ(useGrapes が可視制御用 style を canvas head へ注入する)。 */
  onCanvasLoad: (doc: Document) => void;
  toInfo: (comp: Component) => SelectedInfo;
  /** canvas の read-only フラグ getter(選択は可だが RTE をブロック)。 */
  isLocked: () => boolean;
  /** load 時に canvas document へ注入する jinja + A4 の合成スタイル。 */
  canvasCss: string;
  callbacks: GrapesCallbacks;
}

/**
 * 3-pane editor 用に GrapesJS editor の listener を一括登録する。`init()` を小さく
 * 保つため `useGrapes.ts` から切り出したもので、イベントの意味・名前・登録順は
 * inline 版から不変。
 */
export function wireGrapesEvents(ed: Editor, deps: GrapesEventDeps): void {
  const {
    selected,
    selectedRect,
    revision,
    refreshRect,
    refreshMove,
    recomputeBreakEls,
    refreshPageGuides,
    recomputePages,
    toInfo,
    callbacks,
  } = deps;
  // listener 内ローカル: RTE 開始時の snapshot と、drag 開始時の兄弟 index。
  let rteStartHtml = '';
  let dragStartIndex = -1;

  ed.on('load', () => {
    const docu = ed.Canvas.getDocument();
    if (docu) {
      const styleEl = docu.createElement('style');
      styleEl.textContent = deps.canvasCss;
      docu.head.appendChild(styleEl);
      // 1 ページ表示の可視制御用に 2 枚目の style を useGrapes 側で確保する。
      deps.onCanvasLoad(docu);
    }
    // 起動時はページ全体がキャンバスに収まる倍率へ自動フィットする(以後は手動 +/- で調整)。
    // 直上で canvasCss(A4 `min-height:297mm`)を head へ注入済みのため、次フレームまで遅らせて
    // body 実寸が確定してから測る。
    requestAnimationFrame(() => deps.fitToView());
    // ページ境界 guide / ページ列挙: styles/components が出揃ったこの時点で一度走査する
    recomputeBreakEls();
    refreshPageGuides();
    recomputePages();
  });

  ed.on('component:selected', () => {
    const comp = ed.getSelected();
    selected.value = comp ? toInfo(comp) : null;
    refreshRect();
    refreshMove();
  });
  ed.on('component:deselected', () => {
    selected.value = null;
    selectedRect.value = null;
    refreshMove();
  });
  // scroll: 位置のみ再計算(cache 済みの break 要素集合を再利用 — 軽い)。canvas の scroll は
  // iframe 内 document で起き、GrapesJS は `frame:scroll` を emit する(`canvas:scroll` という
  // event は存在しない)。`canvas:update` は zoom/サイズ変更時の再配置用に併せて拾う。
  const onScroll = () => {
    refreshRect();
    refreshPageGuides();
  };
  ed.on('canvas:update frame:scroll', onScroll);

  // content/style 変更(`component:update` 等)はテキスト入力中などに高頻度で連続発火する。
  // 重い再走査トリオ(`recomputeBreakEls` は全要素 `getComputedStyle` = 強制リフロー O(n))を
  // イベントごとに同期実行すると編集がジャンクするため、rAF で 1 フレーム 1 回へ集約する。
  // 順序は維持する: `recomputeBreakEls`(break 集合更新) → `refreshPageGuides`(その集合を読む)
  // → `recomputePages`(.page 列挙)。editor 破棄後に保留フレームが発火しても各関数は
  // `editor.value` を null ガードして no-op になるため cancel は不要。
  let heavyScheduled = false;
  const scheduleHeavyRecompute = () => {
    if (heavyScheduled) return;
    heavyScheduled = true;
    requestAnimationFrame(() => {
      heavyScheduled = false;
      recomputeBreakEls();
      refreshPageGuides();
      recomputePages();
    });
  };

  const fireChange = () => {
    // revision/rect/move/change は即時のまま(体感応答 + autosave 側で別途 debounce 済み)。
    revision.value++;
    refreshRect();
    refreshMove();
    // content/style が page break やページ数を増減した可能性 — 重い再走査は次フレームへ集約。
    scheduleHeavyRecompute();
    callbacks.change?.();
  };
  // inline text 編集(RTE): 開始(undo snapshot 用)と終了(実際に内容が変わったか)を
  // 通知する。locked の間はブロックする。
  ed.on('rte:enable', (view: { el?: HTMLElement }) => {
    if (deps.isLocked()) {
      // 二重の安全策: locked 時は `Component` を editable:false にしてあるので RTE は
      // 有効化されないはずだが、万一発火した場合は編集中 `Component` の view の
      // `disableEditing()` で確実に止める(`core:component-edit` という command は GrapesJS に
      // 無く、旧 `stopCommand` は no-op だった)。
      try {
        const editingView = ed.getEditing()?.getView() as
          | { disableEditing?: () => void }
          | undefined;
        editingView?.disableEditing?.();
      } catch {
        /* editing API が無い環境 — 無視する */
      }
      return;
    }
    rteStartHtml = view?.el?.innerHTML ?? '';
    callbacks.textStart?.();
  });
  ed.on('rte:disable', (view: { el?: HTMLElement }) => {
    const changed = (view?.el?.innerHTML ?? '') !== rteStartHtml;
    if (changed) {
      revision.value++;
      refreshRect();
      refreshPageGuides(); // テキスト編集で sheet 高さ / 境界が変わりうる
      callbacks.change?.();
    }
    callbacks.textEnd?.(changed);
  });

  ed.on('component:update', fireChange);
  ed.on('component:add', fireChange);
  ed.on('component:remove', fireChange);
  // inline style 変更(`Component` 由来)。GrapesJS の正規 event は `component:styleUpdate`
  // (旧 `style:update` は存在せず dead listener だった)。
  ed.on('component:styleUpdate', fireChange);

  // native な drag-to-reorder: 開始時に undo 用 snapshot、終了時に history を記録する
  // (`Component` の兄弟内位置が実際に変わったときだけ)。version 依存の payload を
  // 信用せず、selection を直接読む。
  ed.on('component:drag:start', () => {
    dragStartIndex = ed.getSelected()?.index?.() ?? -1;
    callbacks.reorderStart?.();
  });
  ed.on('component:drag:end', () => {
    const moved = (ed.getSelected()?.index?.() ?? -1) !== dragStartIndex;
    callbacks.reorderEnd?.(moved);
  });
}
