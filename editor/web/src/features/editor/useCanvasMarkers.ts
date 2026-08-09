// =============================================================================
// useCanvasMarkers.ts — 選択枠 rect とメモ目印の overlay 計測
// =============================================================================
// 役割: 選択要素の画面 rect(浮動ツールバー / ハンドル用)と、版を跨ぐメモを持つ
// パーツの目印位置を、canvas 相対 / zoom 考慮(`noScroll:true` の viewport 相対)で測る。
// ページ表示状態(pageEls / currentPageIndex / singlePageMode)は `ctx` の ref を読む。

import { toAppError } from '@editor/shared';
import type { Editor } from 'grapesjs';
import { type Ref, ref, type ShallowRef } from 'vue';
import { logError } from '@/lib/appError';
import type { SelectedRect } from './grapesEvents';
import { partEls, partPathKeyFor } from './partKey';

/**
 * 版を跨ぐメモを持つパーツの目印(canvas 相対 / zoom 考慮の座標、`SelectedRect` と同様)。
 * エクセルのセルコメント風に、パーツ右上隅へ固定 px の小バッジを重畳する。位置のみ
 * パーツへ追従し、バッジ自体のサイズはズーム非依存(`refreshNoteMarkers` を見よ)。
 * `useTemplateEditor` の推論戻り値型が参照するため export が必要(TS4058 回避)。 @public
 */
export interface NoteMarker {
  /** 紐づく構造パスキー(`partKey.ts` の `partPathKeyFor`)。 */
  key: string;
  top: number;
  /** パーツ右上隅の x(`rect.left + rect.width`)。 */
  left: number;
}

interface CanvasMarkersContext {
  editor: ShallowRef<Editor | undefined>;
  pageEls: ShallowRef<HTMLElement[]>;
  currentPageIndex: Ref<number>;
  singlePageMode: Ref<boolean>;
}

export function useCanvasMarkers(ctx: CanvasMarkersContext) {
  /** overlay 用に保持する選択要素の画面 rect(canvas 相対, zoom 考慮)。 */
  const selectedRect = ref<SelectedRect | null>(null);
  /** 版を跨ぐメモを持つパーツの構造キー集合(外部 = `usePartNote` から `setNoteKeys` で注入)。 */
  const noteKeys = ref<Set<string>>(new Set());
  /** メモ目印の overlay 位置(`refreshNoteMarkers` が現在ページのパーツから算出)。 */
  const noteMarkers = ref<NoteMarker[]>([]);

  /** 選択要素の画面上 rect を再計算する(浮動ツールバー / ハンドル用)。 */
  function refreshRect(): void {
    const ed = ctx.editor.value;
    const comp = ed?.getSelected();
    const el = comp?.getEl?.();
    if (!ed || !el) {
      selectedRect.value = null;
      return;
    }
    try {
      // `noScroll: true`: overlay 相対の viewport 座標へ揃える(`refreshPageGuides` 参照)。
      const p = ed.Canvas.getElementPos(el, { noScroll: true });
      selectedRect.value = { left: p.left, top: p.top, width: p.width, height: p.height };
    } catch (e) {
      // 幾何の再計算に失敗(canvas の一時的な状態) — 観測のため log は残すが、
      // toast でユーザーに見せず toolbar を隠したままにする。
      logError(toAppError(e));
      selectedRect.value = null;
    }
  }

  /**
   * メモを持つパーツ(`noteKeys`)の overlay 目印位置を再計算する。1 ページ表示中は現在
   * ページのパーツのみを走査する(非表示ページの `getElementPos` は 0 になり位置が崩れる
   * ため)。全ページ表示時は全ページを走査する。座標は `noScroll:true`(guide/rect と同様、
   * 非スクロールの overlay 層に重ねるための viewport 相対)で測る。
   */
  function refreshNoteMarkers(): void {
    const ed = ctx.editor.value;
    const root = ed?.getWrapper()?.getEl?.() ?? ed?.Canvas.getBody();
    if (!ed || !root || noteKeys.value.size === 0) {
      noteMarkers.value = [];
      return;
    }
    const pages = ctx.singlePageMode.value
      ? [ctx.pageEls.value[ctx.currentPageIndex.value]]
      : ctx.pageEls.value;
    try {
      const out: NoteMarker[] = [];
      for (const page of pages) {
        if (!page) continue;
        for (const part of partEls(page)) {
          const key = partPathKeyFor(part, root);
          if (!key || !noteKeys.value.has(key)) continue;
          const p = ed.Canvas.getElementPos(part, { noScroll: true });
          out.push({ key, top: p.top, left: p.left + p.width });
        }
      }
      noteMarkers.value = out;
    } catch (e) {
      logError(toAppError(e));
      noteMarkers.value = [];
    }
  }

  /** メモを持つパーツの構造キー集合を差し替え、目印を即時に測り直す(`usePartNote` から)。 */
  function setNoteKeys(keys: Set<string>): void {
    noteKeys.value = keys;
    refreshNoteMarkers();
  }

  return { selectedRect, noteMarkers, refreshRect, refreshNoteMarkers, setNoteKeys };
}
