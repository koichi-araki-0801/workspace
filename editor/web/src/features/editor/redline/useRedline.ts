// =============================================================================
// useRedline.ts — 編集キャンバスの赤入れ表示（確定版からの変更箇所）の composable
// =============================================================================
// 役割: 基準（確定版 `Template.filled`）を 1 回だけ定義木に写して保持し、canvas の変更のたびに
// live のモデル木と比べて装飾を置き直す。装飾は生 DOM だけに置く（`redlineApply.ts`）。
//
// RTE（インライン文字編集）は開始時に `el.innerHTML` を読み、終了時に変わっていればモデルへ
// 再取込する。編集対象の要素に旧文言の `<del>` が残っていると **旧文言が draft に混入**する
// ため、選択のたびにその選択パーツの装飾を外す（click は dblclick = RTE 開始に先行する）。
// 並べ替え（Sorter）はドロップ先の DOM 子要素からモデルを引くので、drag 開始で全装飾を外す。

import { toAppError } from '@editor/shared';
import type { Component, Editor } from 'grapesjs';
import { type Ref, ref, type ShallowRef, watch } from 'vue';
import { createLcsBudget } from '@/features/compare/htmlBlockDiff';
import { logError } from '@/lib/appError';
import { getBodyInner } from '@/lib/templateDoc';
import { applyRedline, clearRedline, clearRedlineWithin } from './redlineApply';
import { REDLINE_BODY_CLASS } from './redlineCss';
import { diffRedline } from './redlineDiff';
import { fromComponents, fromDefinitions, type RedlineNode } from './redlineTree';

/** 連続する変更をまとめる待ち時間。autosave（800ms）より短く、入力の手応えを損ねない範囲。 */
const RECOMPUTE_DEBOUNCE_MS = 300;

interface RedlineDeps {
  editor: ShallowRef<Editor | undefined>;
  revision: Ref<number>;
  editing: Ref<boolean>;
  /** draft が確定版と違う可能性があるか。false なら差分を計算せず装飾を外すだけ。 */
  dirty: Ref<boolean>;
}

export function useRedline(deps: RedlineDeps) {
  const enabled = ref(true);
  const available = ref(false);
  let baseline: RedlineNode[] | null = null;
  let dragging = false;
  let timer: ReturnType<typeof setTimeout> | null = null;

  function rootEl(): HTMLElement | undefined {
    return deps.editor.value?.getWrapper()?.getEl() ?? undefined;
  }

  function applyBodyClass(): void {
    deps.editor.value?.Canvas.getBody()?.classList.toggle(
      REDLINE_BODY_CLASS,
      enabled.value && available.value,
    );
  }

  function clear(): void {
    const root = rootEl();
    if (root) clearRedline(root);
  }

  /**
   * 基準を確保する。編集経路（`?created=1` でない）で `Template.filled` を渡す。作成経路や
   * filled が無い版では undefined を渡し、機能ごと無効にする（トグルも出ない）。
   */
  function setBaseline(filledHtml: string | undefined): void {
    const ed = deps.editor.value;
    if (!ed || !filledHtml) {
      baseline = null;
      available.value = false;
      return;
    }
    const parsed = ed.Parser.parseHtml(getBodyInner(filledHtml)).html;
    baseline = fromDefinitions(parsed);
    available.value = baseline.length > 0;
    applyBodyClass();
    schedule();
  }

  /** `comp` が属するパーツ（`.page` 直下の block）の配下だけ装飾を外す。 */
  function clearPartOf(comp: Component | undefined): void {
    const el = comp?.getEl();
    const root = rootEl();
    if (!el || !root) return;
    let part: HTMLElement = el;
    while (
      part.parentElement &&
      part.parentElement !== root &&
      !part.parentElement.classList.contains('page')
    ) {
      part = part.parentElement;
    }
    clearRedlineWithin(part);
  }

  /**
   * 装飾を置き直す。選択中のパーツは常に素の本文のままにする — RTE は選択後の dblclick で
   * 始まり、開始時に `innerHTML` を読むので、選択パーツに `<del>` があってはならない。
   */
  function recompute(): void {
    const ed = deps.editor.value;
    const root = rootEl();
    applyBodyClass();
    if (!ed || !root || !baseline) return;
    clearRedline(root);
    if (!enabled.value || !deps.dirty.value || deps.editing.value || dragging) return;
    try {
      const live = fromComponents(ed.getWrapper() as Component);
      applyRedline(root, diffRedline(baseline, live, createLcsBudget()));
      clearPartOf(ed.getSelected());
    } catch (e) {
      // 表示の失敗で編集を止めない。装飾は外した状態にして記録だけ残す。
      logError(toAppError(e));
      clearRedline(root);
    }
  }

  function schedule(): void {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = null;
      recompute();
    }, RECOMPUTE_DEBOUNCE_MS);
  }

  function toggle(): void {
    enabled.value = !enabled.value;
    recompute();
  }

  /**
   * 選択変更。選択パーツの装飾は**同期的に**外し（dblclick より前に済ませる）、直前まで
   * 選んでいたパーツの装飾は debounce 後の再計算で戻す（再計算は選択パーツを避ける）。
   * 選択解除（`comp` 無し）でも再計算して、外していた装飾を戻す。
   */
  function onSelected(comp: Component | undefined): void {
    clearPartOf(comp);
    schedule();
  }

  function onDragStart(): void {
    dragging = true;
    if (timer) clearTimeout(timer);
    timer = null;
    clear();
  }

  function onDragEnd(): void {
    dragging = false;
    schedule();
  }

  watch(deps.revision, schedule);
  watch(deps.dirty, schedule);

  return {
    enabled,
    available,
    setBaseline,
    toggle,
    recompute,
    schedule,
    onSelected,
    onDragStart,
    onDragEnd,
  };
}
