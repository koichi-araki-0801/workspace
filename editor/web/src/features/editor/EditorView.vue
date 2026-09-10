<script setup lang="ts">
// =============================================================================
// EditorView.vue — editor 画面のレイアウト(上部バー / 左ペイン / canvas / 右ペイン)
// =============================================================================
// 役割: `useTemplateEditor.ts` / `useGeomHandles.ts` を束ね、canvas 上に選択 overlay
// (ページ境界 guide / ドラッグハンドル / move grip)を描く presentational なルート。
import { GripVertical, PanelLeft, PanelRight, StickyNote, TriangleAlert } from '@lucide/vue';
import { computed, nextTick, onBeforeUnmount, onMounted, ref, useTemplateRef, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import PageRail from '@/components/PageRail.vue';
import { fractionToPage } from '@/components/pageNav';
import Button from '@/components/ui/Button.vue';
import { Tooltip } from '@/components/ui/overlays';
import { toastSuccess } from '@/components/ui/toast';
import { useEditorSessionStore } from '@/stores/editorSession';
import { usePendingReviewsStore } from '@/stores/pendingReviews';
import CommentPanel from './comments/CommentPanel.vue';
import EditorTopBar from './EditorTopBar.vue';
import Inspector from './Inspector.vue';
import NoteBubble from './NoteBubble.vue';
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
  ui,
  template,
  fundName,
  syncStatus,
  displayHistory,
  partLabels,
  selectedPart,
  selectedGeom,
  noteEntries,
  canNote,
  addNote,
  updateNote,
  removeNote,
  allNotes,
  openNoteKeys,
  openNoteCount,
  currentNoteKey,
  replyNote,
  setNoteStatus,
  selectPartByKey,
  allowAdd,
  allowEdit,
  dirty,
  redlineEnabled,
  redlineAvailable,
  toggleRedline,
  autosave,
  canUndo,
  canRedo,
  undo,
  redo,
  beginUndo,
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
  beginUndo,
  applyGeom,
  recordGeomDiff,
});

const rect = computed(() => g.selectedRect.value);

const sessionStore = useEditorSessionStore();

// ── 右ペインの表示(プロパティ / コメント)。編集セッションの ui 状態を継ぐ
// (プレビュー往復で保持、倍率・表示系と同じく永続ミラー経由でリロードでも復元)。 ──
const paneTab = ref<'props' | 'comments'>(ui.paneTab);
watch(paneTab, (v) => {
  ui.paneTab = v;
  sessionStore.persistUi(props.id);
});
// バッジは未対応の**親投稿**の件数(仕様 §4.3)。パーツ数(`openNoteKeys.size`)ではない
// — 1 パーツに複数スレッドがあれば両者は食い違う。
const openCommentCount = computed(() => openNoteCount.value);

// ── メモ吹き出し(選択パーツのスレッド) ──
const noteBubbleEl = useTemplateRef<InstanceType<typeof NoteBubble>>('noteBubbleEl');

// 吹き出しは明示操作(マーカーのクリック / 一覧の行クリック / 投稿の追加)でだけ開く。
// コメントのあるパーツを選んだだけでは開かない — 紙面へ重なる吹き出しが、頼んでいないのに
// 出る形になるため。選択が変われば閉じる(前のパーツの吹き出しが残らない)。同じパーツの
// まま投稿だけが増えたときは開く(閉じたまま追加すると件数だけ増えて本文がどこにも出ない)。
// 選択の変化と投稿数の変化を 1 つの watch にまとめるのは、分けると「選択が別パーツへ
// 変わった結果、その新しいパーツの投稿数がたまたま前パーツより多い」ケースを投稿追加と
// 誤認して開いてしまうため(パーツ間で件数を比べても意味が無い)。`flush:'sync'` は
// `openBubbleFor` の選択直後(`selectPartByKey`)に立てる true が、遅延実行される本 watch の
// close で上書きされるのを防ぐ(`redline.onSelected` の watch と同じ理由。上のコメントを見よ)。
const bubbleOpen = ref(false);
watch(
  () => [g.selected.value, noteEntries.value.length] as const,
  ([selected, n], prev) => {
    const [prevSelected, prevCount] = prev ?? [selected, n];
    if (selected !== prevSelected) {
      bubbleOpen.value = false;
    } else if (n > prevCount) {
      bubbleOpen.value = true;
    }
  },
  { flush: 'sync' },
);
/** 吹き出しの実寸を測り直し `refreshBubbleAnchor` へ渡す(描画されていなければ null で解除)。 */
function measureBubble(): void {
  const el = noteBubbleEl.value?.$el as HTMLElement | null | undefined;
  g.refreshBubbleAnchor(el ? { width: el.offsetWidth, height: el.offsetHeight } : null);
}

/**
 * 吹き出しの anchor を幅 244・高さ 0 の見積もりで仮置きし、DOM 更新後に実寸で測り直す。
 * 投稿が無ければ解除する。選択パーツが変わらないまま(既に選択中のパーツの)吹き出しを
 * 開いたとき、下の `watch(noteEntries)` は発火しない(`noteEntries` の参照が変わらない
 * ため)。そのため `openBubbleFor` からも呼び、開いた瞬間に必ず anchor を持つようにする。
 */
function refreshBubbleAnchorEstimate(): void {
  if (noteEntries.value.length === 0) {
    g.refreshBubbleAnchor(null);
    return;
  }
  g.refreshBubbleAnchor({ width: 244, height: 0 });
  void nextTick(measureBubble);
}

/** マーカー / 一覧の行からの明示操作: そのパーツを選択して吹き出しを開く。 */
function openBubbleFor(key: string): void {
  selectPartByKey(key);
  bubbleOpen.value = true;
  refreshBubbleAnchorEstimate();
}

// 折りたたみ/展開・返信欄・編集用テキストエリアの開閉は `noteEntries` を変えずに吹き出しの
// 高さだけを変える。下の watch(noteEntries)(`refreshBubbleAnchorEstimate`)は投稿の増減にしか
// 反応しないため、これらの操作では anchor の下端クランプが実寸とずれたまま古い値で居座り、
// 吹き出しが overlay 層(非スクロール)の下へはみ出しうる。吹き出し要素そのものの実寸変化を
// ResizeObserver で直接観測して測り直す。要素は v-if で着脱するので、テンプレート ref の
// 変化を watch して都度つなぎ直す(jsdom には ResizeObserver が無いのでガードする)。
let bubbleResizeObserver: ResizeObserver | null = null;
watch(
  noteBubbleEl,
  (instance) => {
    bubbleResizeObserver?.disconnect();
    bubbleResizeObserver = null;
    const el = instance?.$el as HTMLElement | null | undefined;
    if (!el || typeof ResizeObserver === 'undefined') return;
    bubbleResizeObserver = new ResizeObserver(() => measureBubble());
    bubbleResizeObserver.observe(el);
  },
  { immediate: true },
);
onBeforeUnmount(() => {
  bubbleResizeObserver?.disconnect();
  bubbleResizeObserver = null;
});

// スレッド(選択パーツの切替 / 追加・編集・削除)が変わるたびに実寸を測り直す(`refreshBubbleAnchorEstimate`)。
// 以後の zoom/layout 再計算は `useGrapes.ts` の `lastBubbleSize` キャッシュがこの実寸のまま追従させる。
watch(noteEntries, refreshBubbleAnchorEstimate, { immediate: true });

// ページ境界の overlay guide: 既定 ON、上部バーから切替える。ui 状態を継ぐ(paneTab と同じ理由)。
const showPageGuides = ref(ui.showPageGuides);
watch(showPageGuides, (v) => {
  ui.showPageGuides = v;
  sessionStore.persistUi(props.id);
});

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

// ── 承認待ちバッジ(上部バー) ──
// このテンプレの承認待ち申請。複数ある場合は最新(取得順の先頭)へ飛ばす。
const pendingReviews = usePendingReviewsStore();
const pendingReview = computed(() => pendingReviews.byTemplate[props.id]?.[0] ?? null);

/** 承認待ちバッジのクリック。承認タブをこのテンプレートで開く。 */
async function goReview() {
  if (!pendingReview.value) return;
  await autosave.flush();
  router.push({ name: 'reviews', query: { template: props.id } });
}

// canvas コンテナのサイズ変化時、選択 overlay(frame/handle/toolbar)の位置とページ境界 guide・
// 縦配置(収まり判定)を追随させる。倍率は据え置き(起動時 100%・手動フィットのみ変える) —
// window/ペイン resize のたびに再フィットすると、拡大直後に resize が挟まるだけで倍率が
// 勝手に戻ってしまう。`requestAnimationFrame` で GrapesJS の再レイアウト後まで計測を遅らせる
// (`setZoom` と同じ手法)。
let canvasResizeObserver: ResizeObserver | null = null;
onMounted(() => {
  // 承認待ちバッジの表示材料を取り直す(ベストエフォート。失敗してもバッジが出ないだけ)。
  void pendingReviews.refresh();
  const el = canvasEl.value;
  if (!el) return;
  canvasResizeObserver = new ResizeObserver(() => {
    requestAnimationFrame(() => {
      g.refreshRect();
      g.refreshPageGuides();
      g.updateScrollMode();
    });
  });
  canvasResizeObserver.observe(el);
});
onBeforeUnmount(() => {
  canvasResizeObserver?.disconnect();
  canvasResizeObserver = null;
});

function zoomIn() {
  g.setZoom(g.zoom.value + ZOOM_STEP);
}
function zoomOut() {
  g.setZoom(g.zoom.value - ZOOM_STEP);
}
// Ctrl/⌘+0: 画面に合わせる(手動フィット)。
function zoomReset() {
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
  <div class="flex h-full min-h-0 flex-col bg-background">
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
      :show-redline="redlineEnabled"
      :redline-available="redlineAvailable"
      :current-page="g.currentPageIndex.value + 1"
      :page-count="g.pageCount.value"
      :single-page-mode="g.singlePageMode.value"
      :allow-edit="allowEdit"
      :pending-review="pendingReview"
      @undo="undo"
      @redo="redo"
      @zoom-in="zoomIn"
      @zoom-out="zoomOut"
      @zoom-reset="zoomReset"
      @toggle-page-guides="showPageGuides = !showPageGuides"
      @toggle-redline="toggleRedline"
      @go="g.goToPage($event - 1)"
      @toggle-single-page="g.setSinglePageMode(!g.singlePageMode.value)"
      @toggle-edit="allowEdit = !allowEdit"
      @help="helpOpen = true"
      @save="manualSave"
      @preview="goPreview"
      @open-review="goReview"
    />

    <ShortcutHelpDialog v-model:open="helpOpen" />

    <!-- 交付版⇄全体版 ペア同期の未解決競合バナー。競合中のパーツは自動同期が止まって
         いる(両版の内容を一致させると次回承認時に解消される)。放置による二重メンテ回帰を
         防ぐため、解消まで開くたびに表示する(閉じるボタンは意図的に置かない)。 -->
    <div
      v-if="syncStatus && syncStatus.conflicts.length > 0"
      class="flex items-center gap-2 border-b bg-warning/15 px-4 py-1.5 text-[12.5px] text-warning-foreground"
      role="alert"
    >
      <TriangleAlert class="h-4 w-4 shrink-0" />
      <span>
        ペア（{{ syncStatus.pairTemplateId }}）と {{ syncStatus.conflicts.length }} 件のパーツが
        競合しています（自動同期停止中）:
        {{ syncStatus.conflicts.map((c) => `${c.partKey}〔${c.kind}〕`).join('、') }}
      </span>
    </div>

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
      <Tooltip v-else text="左パネルを開く" side="right">
        <Button
          variant="ghost"
          class="pane-rail h-auto w-7 rounded-none border-r p-0"
          aria-label="左パネルを開く"
          @click="leftCollapsed = false"
        >
          <PanelLeft class="h-4 w-4" />
        </Button>
      </Tooltip>

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

          <!-- メモ有りパーツの目印(エクセルのセルコメント風)。クリックでそのパーツを選択して
               吹き出しを開く(選択しただけでは開かない)。overlay 層は pointer-events:none なので
               マーカーだけ auto で復帰させる。 -->
          <button
            v-for="m in g.noteMarkers.value"
            :key="m.key"
            type="button"
            data-note-marker
            class="note-marker"
            :class="openNoteKeys.has(m.key) ? '' : 'note-marker-resolved'"
            :title="openNoteKeys.has(m.key) ? '未対応のコメントあり(クリックで開く)' : 'コメントあり(解決済み。クリックで開く)'"
            :aria-label="'コメントを開く'"
            :style="{ left: `${m.left}px`, top: `${m.top}px` }"
            @click="openBubbleFor(m.key)"
          >
            <StickyNote class="h-3 w-3" />
          </button>

          <!-- メモ吹き出し(選択パーツのスレッド)。表計算ソフトのセルコメントと同じく常に
               ページへ重ねて出す。大きさ・倍率は変えない(`noteBubbleLayout` を見よ)。 -->
          <template v-if="g.bubbleAnchor.value && noteEntries.length > 0 && bubbleOpen">
            <NoteBubble
              ref="noteBubbleEl"
              :entries="noteEntries"
              :anchor="g.bubbleAnchor.value"
              @update="updateNote"
              @remove="removeNote"
              @reply="replyNote"
              @set-status="setNoteStatus"
              @close="bubbleOpen = false"
            />
          </template>

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
      <Tooltip v-if="rightCollapsed" text="右パネルを開く" side="left">
        <Button
          variant="ghost"
          class="pane-rail h-auto w-7 rounded-none border-l p-0"
          aria-label="右パネルを開く"
          @click="rightCollapsed = false"
        >
          <PanelRight class="h-4 w-4" />
        </Button>
      </Tooltip>
      <Inspector
        v-else
        :selected="g.selected.value"
        :part="selectedPart"
        :geom="selectedGeom"
        :history="displayHistory"
        :part-labels="partLabels"
        :pane-tab="paneTab"
        :comment-count="openCommentCount"
        :edit-mode="allowEdit"
        :can-up="g.canMoveUp.value"
        :can-down="g.canMoveDown.value"
        @apply="applyGeom"
        @move="moveSelected($event)"
        @reset="resetGeom"
        @del="deletePart"
        @pane-tab="paneTab = $event"
        @collapse="rightCollapsed = true"
      >
        <template #comments>
          <CommentPanel
            :entries="allNotes"
            :selected-key="currentNoteKey"
            :can-add="canNote"
            :part-labels="partLabels"
            @add="(content) => addNote(content)"
            @reply="replyNote"
            @set-status="setNoteStatus"
            @update="updateNote"
            @remove="removeNote"
            @focus="openBubbleFor"
          />
        </template>
      </Inspector>
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
   like Excel's cell comment mark, but clickable — opens the bubble for that part
   (overlay layer is pointer-events:none; the marker restores pointer-events:auto).
   fixed px size so it stays legible/obvious at any canvas zoom. button resets
   (margin/padding/font/appearance) undo UA button chrome so it keeps the same look. */
.note-marker {
  position: absolute;
  display: grid;
  place-items: center;
  width: 18px;
  height: 18px;
  margin: 0;
  padding: 0;
  font: inherit;
  appearance: none;
  transform: translate(-100%, 0);
  border-radius: 4px 4px 4px 0;
  /* 琥珀・灰色ともテーマトークンではなく固定値を使う。アイコン/枠の白も同じ理由でテーマ
     非依存 — マーカーは常に白い A4 紙面上に重なるため、ダークテーマでも同じ配色が正しい
     対比になる(テーマの `--muted-foreground` はダークテーマで明るい色に化けて紙面上で
     読めなくなる)。 */
  color: #fff;
  background: var(--warning);
  border: 1.5px solid #fff;
  box-shadow: 0 1px 3px rgba(0, 0, 0, 0.3);
  pointer-events: auto;
  cursor: pointer;
  z-index: 24;
}
/* 全部解決済みのパーツは灰色で残す(「見た」ことは分かるが、次に見るべき場所ではない)。 */
.note-marker-resolved {
  background: #9aa0a6;
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

