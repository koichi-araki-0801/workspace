<script setup lang="ts">
// =============================================================================
// EditorView.vue — editor 画面のレイアウト(上部バー / 左ペイン / canvas / 右ペイン)
// =============================================================================
// 役割: `useTemplateEditor.ts` / `useGeomHandles.ts` を束ね、canvas 上に選択 overlay
// (ページ境界 guide / ドラッグハンドル / move grip)を描く presentational なルート。
import { GripVertical, PanelLeft, PanelRight, StickyNote } from '@lucide/vue';
import { computed, onBeforeUnmount, onMounted, ref, useTemplateRef, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import PageRail from '@/components/PageRail.vue';
import { fractionToPage } from '@/components/pageNav';
import Button from '@/components/ui/Button.vue';
import { toastSuccess } from '@/components/ui/toast';
import EditorTopBar from './EditorTopBar.vue';
import Inspector from './Inspector.vue';
import PartTree from './PartTree.vue';
import ShortcutHelpDialog from './ShortcutHelpDialog.vue';
import { useEditorShortcuts } from './useEditorShortcuts';
import { useGeomHandles } from './useGeomHandles';
import { ZOOM_STEP } from './useGrapes';
import { useTemplateEditor } from './useTemplateEditor';

const props = defineProps<{ id: string }>();
const router = useRouter();
const route = useRoute();

const canvasEl = useTemplateRef<HTMLElement>('canvasEl');
const layersEl = useTemplateRef<HTMLElement>('layersEl');

const {
  g,
  template,
  fundName,
  displayHistory,
  partLabels,
  selectedPart,
  selectedGeom,
  noteText,
  canNote,
  setNote,
  allowAdd,
  allowEdit,
  dirty,
  autosave,
  canUndo,
  canRedo,
  undo,
  redo,
  pushUndo,
  applyGeom,
  recordGeomDiff,
  resetGeom,
  moveSelected,
  deletePart,
  onPartSelect,
  onPartInsert,
} = useTemplateEditor(props.id, { canvasEl, layersEl });

// zoom 非依存のブロック resize / 余白ドラッグハンドル(`useGeomHandles.ts` を見よ)。
const { startHandle, dragLabel } = useGeomHandles({
  selectedGeom,
  selectedRect: g.selectedRect,
  zoom: g.zoom,
  pushUndo,
  applyGeom,
  recordGeomDiff,
});

const rect = computed(() => g.selectedRect.value);

// ページ境界の overlay guide: 既定 ON、上部バーから切替える。
const showPageGuides = ref(true);

// `PageRail` 用の現在ページ(1 起点)。1 ページ表示は表示中 index、全ページ連続表示は
// 実スクロール位置(`scrollFraction`)から逆算する(目盛りのハイライトをスクロールに追従)。
const railCurrentPage = computed(() =>
  g.singlePageMode.value
    ? g.currentPageIndex.value + 1
    : fractionToPage(g.scrollFraction.value, g.pageCount.value),
);

/** レールのジャンプ。1 ページ表示はページ送り、全ページ連続表示は当該ページ先頭へスクロール。 */
function onRailGo(page: number): void {
  const i = page - 1;
  if (g.singlePageMode.value) g.goToPage(i);
  else g.scrollToPage(i);
}

// ── 左右ペインの折りたたみ(狭幅で canvas を広く使うため) ──
// 状態は localStorage に保持し、次回も同じ畳み方で開く(キーは theme.ts と同じ `ret:` 接頭辞)。
function persistedFlag(key: string, def: boolean) {
  const raw = localStorage.getItem(key);
  const flag = ref(raw === '1' ? true : raw === '0' ? false : def);
  watch(flag, (v) => localStorage.setItem(key, v ? '1' : '0'));
  return flag;
}
const leftCollapsed = persistedFlag('ret:editor:leftCollapsed', false);
const rightCollapsed = persistedFlag('ret:editor:rightCollapsed', false);

async function goPreview() {
  await autosave.flush();
  // 編集経路(query なし)/作成経路(`?created=1`)の区別をプレビューへ引き継ぐ。確定保存の
  // 申請(`SubmitReviewRequest.origin`)で 2 系統を保持するため(`PreviewView` が読む)。
  const created = route.query.created === '1' ? { created: '1' } : {};
  router.push({ name: 'preview', params: { id: props.id }, query: created });
}

// ユーザーが zoom +/- で明示的に倍率を決めたか。立っている間は resize で勝手に再フィット
// しない(下の observer を見よ)。初期 `load` 時の自動フィットでは立てない。
const userZoomed = ref(false);

// canvas コンテナのサイズ変化時、A4 を現ビューポートへ再フィットし直し、選択 overlay
// (frame/handle/toolbar)の位置も保つ。fitToView は `load` 時の 1 回きりのため、これが無いと
// window/ペイン resize やブラウザズームで canvasEl の px が変わっても倍率が据え置きになり、
// `.gjs-frame-wrapper{margin:24px auto}` の上揃えと相まってページが上部に小さく残り崩れる。
// 手動ズーム中(`userZoomed`)は倍率を尊重し overlay 追従のみ行う。`requestAnimationFrame` で
// GrapesJS の再レイアウト後まで計測を遅らせる(`setZoom` と同じ手法)。fitToView は内部で
// setZoom→rAF で refreshRect/refreshPageGuides も走らせる。
let canvasResizeObserver: ResizeObserver | null = null;
onMounted(() => {
  const el = canvasEl.value;
  if (!el) return;
  canvasResizeObserver = new ResizeObserver(() => {
    requestAnimationFrame(() => {
      if (userZoomed.value) {
        // 手動ズーム中は倍率を尊重し overlay 追従のみだが、リサイズで canvasEl の client
        // サイズが変われば収まり判定も変わるため `updateScrollMode` で縦配置を出し分け直す。
        g.refreshRect();
        g.refreshPageGuides();
        g.updateScrollMode();
      } else {
        g.fitToView();
      }
    });
  });
  canvasResizeObserver.observe(el);
});
onBeforeUnmount(() => {
  canvasResizeObserver?.disconnect();
  canvasResizeObserver = null;
});

function zoomIn() {
  userZoomed.value = true;
  g.setZoom(g.zoom.value + ZOOM_STEP);
}
function zoomOut() {
  userZoomed.value = true;
  g.setZoom(g.zoom.value - ZOOM_STEP);
}
// Ctrl/⌘+0: 全体にフィットへ戻す。`userZoomed` を下ろし、以後の resize で自動再フィットを許す。
function zoomReset() {
  userZoomed.value = false;
  g.fitToView();
}

// ショートカットヘルプ(`?` / 上部バーのヘルプボタン)。
const helpOpen = ref(false);

/**
 * 手動保存(保存ボタン / Ctrl+S)。autosave の flush と同じだが、明示操作にはトーストで
 * 応える — 自動保存はステータス行のみ(毎回トーストは騒音)で、手動時だけ確信を返す。
 */
async function manualSave(): Promise<void> {
  await autosave.flush();
  if (autosave.state.value === 'saved') toastSuccess('保存しました');
}

// グローバルショートカット(元に戻す / やり直す / 保存 / ズーム / 削除 / ヘルプ)。canvas の
// inline text 編集中・入力欄フォーカス中はネイティブ動作へ委ねる(`useEditorShortcuts.ts`)。
useEditorShortcuts({
  undo,
  redo,
  save: () => void manualSave(),
  zoomIn,
  zoomOut,
  zoomReset,
  remove: deletePart,
  help: () => {
    helpOpen.value = true;
  },
  canUndo: () => canUndo.value,
  canRedo: () => canRedo.value,
  canRemove: () => allowEdit.value && !!g.selected.value,
  isTextEditing: () => g.editing.value,
});

/** autosave のステータス行。判明していれば最終保存時刻も含める。 */
const statusText = computed(() => {
  const at = autosave.lastSavedAt.value;
  const savedAt = at
    ? `${at.toLocaleTimeString('ja-JP', { hour: '2-digit', minute: '2-digit' })} に自動保存`
    : null;
  switch (autosave.state.value) {
    case 'saving':
      return '保存中…';
    case 'error':
      return '保存に失敗しました';
    case 'saved':
      return savedAt ?? '保存しました';
    default:
      return savedAt ?? '自動保存';
  }
});
</script>

<template>
  <div class="flex h-screen flex-col bg-background">
    <EditorTopBar
      :fund-name="fundName"
      :attributes="template?.meta.attributes"
      :dirty="dirty"
      :save-state="autosave.state.value"
      :status-text="statusText"
      :zoom="g.zoom.value"
      :can-undo="canUndo"
      :can-redo="canRedo"
      :show-page-guides="showPageGuides"
      :current-page="g.currentPageIndex.value + 1"
      :page-count="g.pageCount.value"
      :single-page-mode="g.singlePageMode.value"
      :allow-edit="allowEdit"
      @undo="undo"
      @redo="redo"
      @zoom-in="zoomIn"
      @zoom-out="zoomOut"
      @zoom-reset="zoomReset"
      @toggle-page-guides="showPageGuides = !showPageGuides"
      @go="g.goToPage($event - 1)"
      @toggle-single-page="g.setSinglePageMode(!g.singlePageMode.value)"
      @toggle-edit="allowEdit = !allowEdit"
      @help="helpOpen = true"
      @save="manualSave"
      @preview="goPreview"
    />

    <ShortcutHelpDialog v-model:open="helpOpen" />

    <!-- 高ズームで両袖(固定幅)+ 中央が実効ビューポート幅を超える極端な場合は、クリップ
         ではなく横スクロールで全ペインへ到達できるようにする(通常倍率では overflow 無し)。 -->
    <div class="flex flex-1 overflow-x-auto overflow-y-hidden">
      <!-- 左: パーツ追加(チェックボックス → cascading な絞り込み)。畳むと細いレールになる。 -->
      <PartTree
        v-if="!leftCollapsed"
        v-model:allow-add="allowAdd"
        v-model:allow-edit="allowEdit"
        @select="onPartSelect"
        @insert="onPartInsert"
        @collapse="leftCollapsed = true"
      />
      <Button
        v-else
        variant="ghost"
        class="pane-rail h-auto w-7 rounded-none border-r p-0"
        title="左パネルを開く"
        aria-label="左パネルを開く"
        @click="leftCollapsed = false"
      >
        <PanelLeft class="h-4 w-4" />
      </Button>

      <!-- 中央: A4 用紙の見た目にした GrapesJS canvas -->
      <main class="relative min-w-[360px] flex-1 overflow-hidden bg-canvas-backdrop">
        <div ref="canvasEl" class="h-full"></div>
        <!-- GrapesJS の layer manager はマウントするが視覚的に隠す(prototype に layers パネルは無い) -->
        <div ref="layersEl" class="hidden"></div>

        <!-- 選択ブロック上の幅/余白ドラッグハンドル(layout 編集は右ペインの
             `Inspector.vue` にもある。ここに浮動ツールバーは置かない) -->
        <div class="pointer-events-none absolute inset-0 z-20 overflow-hidden">
          <!-- ページ境界 guide: 実際の page break(`.page` / `page-break-*`)の位置のみ。
               1 ページ表示中は現在ページの末尾しか視野に無く、ページ番号は上部バーの
               ページャに集約されるため guide 線は出さない(全ページ表示時のみ)。 -->
          <template v-if="showPageGuides && !g.singlePageMode.value">
            <div
              v-for="gd in g.pageGuides.value"
              :key="gd.page"
              class="pg-line"
              :style="{ left: `${gd.left}px`, top: `${gd.top}px`, width: `${gd.width}px` }"
            >
              <span class="pg-label">ここまで {{ gd.page }}ページ目</span>
            </div>
          </template>

          <!-- メモ有りパーツの目印(エクセルのセルコメント風)。閲覧/編集どちらでも表示し、
               位置のみパーツへ追従、バッジは固定 px(ズーム非依存)。クリックは奪わない
               (pointer-events なし) — パーツ自体をクリックすれば右ペインにメモが出る。 -->
          <div
            v-for="m in g.noteMarkers.value"
            :key="m.key"
            class="note-marker"
            title="メモあり"
            :style="{ left: `${m.left}px`, top: `${m.top}px` }"
          >
            <StickyNote class="h-3 w-3" />
          </div>

          <!-- 編集の affordance(ドラッグハンドル)は編集許可時のみ -->
          <template v-if="rect && selectedGeom && allowEdit">
            <!-- drag grip: 選択ブロックを兄弟内で並べ替える -->
            <div
              v-if="g.canDragSelected.value"
              class="pg-move pointer-events-auto"
              title="ドラッグで順序を移動"
              :style="{ left: `${rect.left}px`, top: `${rect.top}px` }"
              @mousedown="g.startMove($event)"
            >
              <GripVertical class="h-4 w-4" />
            </div>

            <!-- resize box を分かりやすくするための選択フレームの写し -->
            <div
              class="ret-frame"
              :style="{ left: `${rect.left}px`, top: `${rect.top}px`, width: `${rect.width}px`, height: `${rect.height}px` }"
            />

            <!-- edge ハンドル: 左右 = 幅、上下 = 余白 -->
            <div
              class="ret-handle ret-handle-x pointer-events-auto"
              title="幅をドラッグ"
              :style="{ left: `${rect.left + rect.width}px`, top: `${rect.top + rect.height / 2}px`, cursor: 'ew-resize' }"
              @mousedown="startHandle('width', $event)"
            />
            <div
              class="ret-handle ret-handle-x pointer-events-auto"
              title="幅をドラッグ"
              :style="{ left: `${rect.left}px`, top: `${rect.top + rect.height / 2}px`, cursor: 'ew-resize' }"
              @mousedown="startHandle('width-left', $event)"
            />
            <div
              class="ret-handle ret-handle-y pointer-events-auto"
              title="上の余白をドラッグ"
              :style="{ left: `${rect.left + rect.width / 2}px`, top: `${rect.top}px`, cursor: 'ns-resize' }"
              @mousedown="startHandle('mt', $event)"
            />
            <div
              class="ret-handle ret-handle-y pointer-events-auto"
              title="下の余白をドラッグ"
              :style="{ left: `${rect.left + rect.width / 2}px`, top: `${rect.top + rect.height}px`, cursor: 'ns-resize' }"
              @mousedown="startHandle('mb', $event)"
            />

            <!-- ハンドルのドラッグ中に出すライブ値の bubble -->
            <div
              v-if="dragLabel"
              class="ret-drag-label"
              :style="{ left: `${dragLabel.left}px`, top: `${dragLabel.top}px` }"
            >
              {{ dragLabel.text }}
            </div>

          </template>
        </div>

        <!-- 右端の縦ページ目盛り(スクラバ)。400 ページ規模で現在位置の把握と任意ページへの
             ジャンプを担う。1 ページ表示ではページ送り、全ページ連続表示では当該ページ先頭へ
             スクロールする(`onRailGo`)。overlay 層とは別に置き、自前でクリックを拾う。 -->
        <PageRail
          v-if="g.pageCount.value > 1"
          :current-page="railCurrentPage"
          :page-count="g.pageCount.value"
          :scroll-fraction="g.singlePageMode.value ? null : g.scrollFraction.value"
          @go="onRailGo"
        />
      </main>

      <!-- 右: 編集可能なプロパティ(折りたたみ式)+ 履歴。畳むと細いレールになる。 -->
      <Button
        v-if="rightCollapsed"
        variant="ghost"
        class="pane-rail h-auto w-7 rounded-none border-l p-0"
        title="右パネルを開く"
        aria-label="右パネルを開く"
        @click="rightCollapsed = false"
      >
        <PanelRight class="h-4 w-4" />
      </Button>
      <Inspector
        v-else
        :selected="g.selected.value"
        :part="selectedPart"
        :geom="selectedGeom"
        :history="displayHistory"
        :part-labels="partLabels"
        :note="noteText"
        :can-note="canNote"
        :edit-mode="allowEdit"
        :can-up="g.canMoveUp.value"
        :can-down="g.canMoveDown.value"
        @apply="applyGeom"
        @move="moveSelected($event)"
        @reset="resetGeom"
        @del="deletePart"
        @update-note="setNote"
        @collapse="rightCollapsed = true"
      />
    </div>
  </div>
</template>

<style scoped>
/* collapsed-pane rail: thin vertical strip with an expand button. fixed width keeps
   the canvas wide while leaving an obvious affordance to reopen the panel. */
.pane-rail {
  display: grid;
  place-items: center;
  width: 28px;
  flex-shrink: 0;
  background: var(--card);
  color: var(--muted-foreground);
  cursor: pointer;
}
.pane-rail:hover {
  color: var(--foreground);
  background: color-mix(in oklab, var(--muted) 60%, var(--card));
}

/* page-boundary guides drawn over the A4 sheet (sit below the selection frame).
   real page break (from .page / break-* / page-break-*): confident solid line */
.pg-line {
  position: absolute;
  height: 0;
  pointer-events: none;
  z-index: 10;
  border-top: 1px solid color-mix(in oklab, var(--primary) 60%, transparent);
}
.pg-label {
  position: absolute;
  right: 2px;
  bottom: 2px;
  padding: 1px 6px;
  border-radius: 6px 6px 0 0;
  font-size: 11px;
  font-weight: 700;
  line-height: 1.4;
  white-space: nowrap;
  color: var(--primary-foreground);
  background: color-mix(in oklab, var(--primary) 78%, transparent);
}

/* note marker: small amber sticky-note badge at a part's top-right corner.
   purely a visual indicator (pointer-events:none) — like Excel's cell comment mark.
   fixed px size so it stays legible/obvious at any canvas zoom. */
.note-marker {
  position: absolute;
  display: grid;
  place-items: center;
  width: 18px;
  height: 18px;
  transform: translate(-100%, 0);
  border-radius: 4px 4px 4px 0;
  /* 琥珀はテーマの warning トークンへ統一。アイコン/枠の白はテーマ非依存で固定 —
     マーカーは常に白い A4 紙面上に重なるため、ダークテーマでも白が正しい対比になる。 */
  color: #fff;
  background: var(--warning);
  border: 1.5px solid #fff;
  box-shadow: 0 1px 3px rgba(0, 0, 0, 0.3);
  pointer-events: none;
  z-index: 24;
}

/* drag grip on the selected block — large, obvious grab target for reorder */
.pg-move {
  position: absolute;
  display: grid;
  place-items: center;
  width: 24px;
  height: 24px;
  transform: translate(-50%, -110%);
  border-radius: 6px;
  color: var(--primary-foreground);
  background: var(--primary);
  border: 2px solid #fff;
  box-shadow: 0 1px 4px rgba(0, 0, 0, 0.28);
  cursor: grab;
  z-index: 26;
  user-select: none;
}
.pg-move:active {
  cursor: grabbing;
}

/* selection frame echoing the selected block so the resize box is obvious.
   solid primary outline (was a faint dashed line that read as ambiguous). */
.ret-frame {
  position: absolute;
  pointer-events: none;
  border: 2px solid color-mix(in oklab, var(--primary) 80%, transparent);
  border-radius: 4px;
  box-shadow: 0 0 0 1px color-mix(in oklab, var(--primary) 18%, transparent);
  z-index: 22;
}

/* edge handles: elongated bars with a generous transparent hit area.
   The visible knob is centered via the ::before pseudo-element. */
.ret-handle {
  position: absolute;
  transform: translate(-50%, -50%);
  z-index: 25;
  user-select: none;
}
.ret-handle::before {
  content: '';
  position: absolute;
  top: 50%;
  left: 50%;
  transform: translate(-50%, -50%);
  border-radius: 6px;
  background: var(--primary);
  border: 2px solid #fff;
  box-shadow: 0 1px 4px rgba(0, 0, 0, 0.28);
}
/* width handles: tall vertical bar */
.ret-handle-x {
  width: 28px;
  height: 44px;
}
.ret-handle-x::before {
  width: 8px;
  height: 30px;
}
/* margin handles: wide horizontal bar */
.ret-handle-y {
  width: 44px;
  height: 28px;
}
.ret-handle-y::before {
  width: 30px;
  height: 8px;
}
.ret-handle:hover::before {
  background: color-mix(in oklab, var(--primary) 85%, transparent);
}

/* live value bubble shown while dragging a handle */
.ret-drag-label {
  position: absolute;
  transform: translate(-50%, -50%);
  padding: 3px 8px;
  border-radius: 6px;
  background: var(--primary);
  color: var(--primary-foreground);
  font-size: 12px;
  font-weight: 700;
  white-space: nowrap;
  box-shadow: 0 2px 8px rgba(0, 0, 0, 0.3);
  pointer-events: none;
  z-index: 30;
}
</style>

