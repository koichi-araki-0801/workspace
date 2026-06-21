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
    zoom,
    refreshRect,
    refreshMove,
    recomputeBreakEls,
    refreshPageGuides,
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
    }
    // 100% で開く(固定。以後は手動の +/- でそこから調整する)
    try {
      ed.Canvas.setZoom(zoom.value * 100);
    } catch {
      /* zoom API が無い環境 — 無視する */
    }
    // ページ境界 guide: styles/components が出揃ったこの時点で一度走査する
    recomputeBreakEls();
    refreshPageGuides();
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
  // scroll: 位置のみ再計算(cache 済みの break 要素集合を再利用 — 軽い)
  const onScroll = () => {
    refreshRect();
    refreshPageGuides();
  };
  ed.on('canvas:scroll', onScroll);
  ed.on('canvas:update frame:scroll', onScroll);

  const fireChange = () => {
    revision.value++;
    refreshRect();
    refreshMove();
    // content/style が page break を増減した可能性 — 再走査してから再配置する
    recomputeBreakEls();
    refreshPageGuides();
    callbacks.change?.();
  };
  // inline text 編集(RTE): 開始(undo snapshot 用)と終了(実際に内容が変わったか)を
  // 通知する。locked の間はブロックする。
  ed.on('rte:enable', (view: { el?: HTMLElement }) => {
    if (deps.isLocked()) {
      // 二重の安全策: locked 時は `Component` を editable:false にしてあるので RTE は
      // 有効化されないはずだが、万一発火した場合は防御的に抜ける。
      try {
        ed.stopCommand('core:component-edit');
      } catch {
        /* command が無い環境 — 無視する */
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
  ed.on('style:update', fireChange);

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
