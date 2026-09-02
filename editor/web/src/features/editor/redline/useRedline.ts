// =============================================================================
// useRedline.ts — 編集キャンバスの赤入れ表示（確定版からの変更箇所）の composable
// =============================================================================
// 役割: 基準（確定版の値埋め込み本文）を 1 回だけ定義木に写して保持し、canvas の変更のたびに
// live のモデル木と比べて装飾を置き直す。装飾は生 DOM だけに置く（`redlineApply.ts`）。
//
// RTE（インライン文字編集）は開始時に `el.innerHTML` を読み、終了時に変わっていればモデルへ
// 再取込する。編集対象の要素に旧文言の `<del>` が残っていると **旧文言が draft に混入**する
// ため、選択のたびにその選択パーツの装飾を外す（click は dblclick = RTE 開始に先行する）。
// 並べ替え（Sorter）はドロップ先の DOM 子要素からモデルを引くので、drag 開始で全装飾を外す。

import { toAppError } from '@editor/shared';
import type { Component, ComponentDefinition, Editor } from 'grapesjs';
import { onUnmounted, type Ref, ref, type ShallowRef, watch } from 'vue';
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
  /**
   * 基準 HTML を canvas と同じ正規化で定義木へ変換する(`useGrapes.parseHtmlQuiet`)。
   * 刈り取りは canvas と同じに揃える必要がある — 揃えないと基準と live の形が食い違い、
   * 差分が全面 add/remove へ化ける。抑止するのは刈り取りの結果を伝えるトーストだけで、
   * 本文の読み込みで既に同じ通知が出ているため、基準づくりで二重に出すと誤解を招く。
   */
  parseHtml: (html: string) => ComponentDefinition[];
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
   * 基準を確保する。編集経路（`?created=1` でない）で確定版の値埋め込み本文（`loadForEdit` が
   * 解決する `confirmedBody`）を渡す。作成経路では undefined を渡し、機能ごと無効にする
   * （トグルも出ない）。
   */
  function setBaseline(filledHtml: string | undefined): void {
    const ed = deps.editor.value;
    if (!ed || !filledHtml) {
      baseline = null;
      available.value = false;
      applyBodyClass();
      return;
    }
    // パースが失敗しても編集セッションを道連れにしない。以後 `g.onChange` 等の登録が続くため、
    // ここで投げると autosave・undo 記録・並べ替えまで丸ごと止まる。
    try {
      baseline = fromDefinitions(deps.parseHtml(getBodyInner(filledHtml)));
      available.value = baseline.length > 0;
    } catch (e) {
      logError(toAppError(e));
      baseline = null;
      available.value = false;
    }
    applyBodyClass();
    schedule();
  }

  /** `comp` が属するパーツ（`.page` 直下の block）の配下だけ装飾を外す。 */
  function clearPartOf(comp: Component | undefined): void {
    const el = comp?.getEl();
    const root = rootEl();
    // `el` が `root` 自身、または `root` の子孫でない場合は登り続けると `<html>` まで届く。
    if (!el || !root || el === root || !root.contains(el)) return;
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
    // RTE 中 / drag 中は DOM に触らない — `clearRedline` の `normalize()` が contenteditable の
    // caret を乱す、または Sorter が読む子要素構成を変えてしまうため。
    if (deps.editing.value || dragging) return;
    clearRedline(root);
    if (!enabled.value || !deps.dirty.value) return;
    try {
      // `rootEl()` が非 null を返した時点で wrapper の存在は確定している(型は
      // `ComponentWrapper | undefined`)。
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
  // 画面離脱後に debounce が発火しても、参照先の canvas は既に破棄されている。
  onUnmounted(() => {
    if (timer) clearTimeout(timer);
  });

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
