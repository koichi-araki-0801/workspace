<script setup lang="ts">
// =============================================================================
// EditorTopBar.vue — editor 上部バー(undo/redo / zoom / 保存状態 / プレビュー)
// =============================================================================
import type { TemplateAttributes } from '@editor/shared';
import {
  AlertCircle,
  CheckCircle2,
  Eye,
  FileText,
  Loader2,
  Minus,
  Plus,
  Redo2,
  RotateCcw,
  Rows3,
  Save,
  Undo2,
} from '@lucide/vue';
import PageNav from '@/components/PageNav.vue';
import BackButton from '@/components/ui/BackButton.vue';
import Badge from '@/components/ui/Badge.vue';
import Button from '@/components/ui/Button.vue';
import type { SaveState } from './useAutosave';

const props = defineProps<{
  fundName: string;
  attributes?: TemplateAttributes;
  /** 確定保存していない編集が残っているか(下書き自動保存とは別。確定保存は preview 画面)。 */
  dirty: boolean;
  saveState: SaveState;
  statusText: string;
  zoom: number;
  canUndo: boolean;
  canRedo: boolean;
  showPageGuides: boolean;
  /** 1 始まりで表示する現在ページ番号。 */
  currentPage: number;
  pageCount: number;
  singlePageMode: boolean;
}>();

const emit = defineEmits<{
  undo: [];
  redo: [];
  zoomIn: [];
  zoomOut: [];
  togglePageGuides: [];
  /** ページ番号ジャンプ(1 起点)。`EditorView` で `g.goToPage(n - 1)` へ。 */
  go: [page: number];
  toggleSinglePage: [];
  save: [];
  preview: [];
}>();

const attrItems = (a: TemplateAttributes) => [
  { k: '委託会社コード', v: a.companyCode },
  { k: 'ファンドコード', v: a.fundCode },
  { k: '基準日', v: a.baseDate },
  { k: '版種', v: a.editionType },
];
</script>

<template>
  <header
    class="z-30 flex min-h-[58px] shrink-0 flex-wrap items-center gap-x-3 gap-y-2 border-b bg-card px-4 py-1.5 shadow-sm print:hidden"
  >
    <!-- ── 左ゾーン: 一覧へ戻る + 文書情報(タイトル / 属性チップ) ── -->
    <BackButton :fallback="{ name: 'edit' }" aria-label="一覧へ戻る" />
    <div class="h-[26px] w-px shrink-0 bg-border" />

    <div class="flex min-w-0 flex-col">
      <div class="flex min-w-0 items-center gap-2">
        <span class="truncate text-[15px] font-bold">{{ fundName }}</span>
        <!-- 確定状態のバッジ。下書きは常時自動保存されるが「確定保存」は preview 画面で行うため、
             未確定の編集が残っているかをここで明示する(自動保存ステータスとは別物)。 -->
        <Badge
          v-if="dirty"
          variant="warning"
          class="shrink-0 whitespace-nowrap"
          title="確定保存していない編集があります。プレビュー画面で確定保存できます。"
        >
          未確定
        </Badge>
        <Badge
          v-else
          variant="secondary"
          class="shrink-0 whitespace-nowrap"
          title="未確定の変更はありません。"
        >
          変更なし
        </Badge>
      </div>
      <!-- 属性はラベル小 + 値強調のチップに。テキスト羅列より値の判別が速い -->
      <div v-if="attributes" class="mt-0.5 flex flex-wrap items-center gap-1.5">
        <span
          v-for="it in attrItems(attributes)"
          :key="it.k"
          class="inline-flex items-center gap-1 whitespace-nowrap rounded-md bg-muted px-1.5 py-px text-[10.5px]"
        >
          <span class="text-muted-foreground">{{ it.k }}</span>
          <span class="mono font-semibold tabular-nums text-foreground">{{ it.v }}</span>
        </span>
      </div>
    </div>

    <span class="flex-1" />

    <!-- ── 中央ゾーン: 表示操作(元に戻す/やり直す・ズーム・ページ・表示切替・境界 guide)。
         関連操作を 1 つの面に束ね、内部だけ細い区切りで小分けする(等間隔罫線の平板さを解消)。
         グループ全体が `shrink-0` なので狭幅では塊ごと次行へ折り返す(ズーム崩れの回避)。 -->
    <div class="flex shrink-0 flex-wrap items-center gap-1 rounded-lg bg-muted/50 px-1.5 py-1">
      <!-- 元に戻す / やり直す -->
      <Button variant="ghost" size="icon" title="元に戻す (⌘Z)" :disabled="!canUndo" @click="emit('undo')">
        <Undo2 class="h-[17px] w-[17px]" />
      </Button>
      <Button variant="ghost" size="icon" title="やり直す (⇧⌘Z)" :disabled="!canRedo" @click="emit('redo')">
        <Redo2 class="h-[17px] w-[17px]" />
      </Button>

      <div class="mx-0.5 h-5 w-px bg-border/70" />

      <!-- ズーム -->
      <Button variant="ghost" size="icon" title="縮小 (⌘-)" @click="emit('zoomOut')">
        <Minus class="h-4 w-4" />
      </Button>
      <span class="w-[42px] text-center text-[12.5px] tabular-nums text-muted-foreground">
        {{ Math.round(zoom * 100) }}%
      </span>
      <Button variant="ghost" size="icon" title="拡大 (⌘+)" @click="emit('zoomIn')">
        <Plus class="h-4 w-4" />
      </Button>

      <div class="mx-0.5 h-5 w-px bg-border/70" />

      <!-- ページ送り(1 ページ表示時、複数ページのときだけ出す)。番号入力で任意ページへジャンプ
           できる共通 `PageNav`(400 ページ規模対応)。全ページ連続表示中は canvas 右端の
           `PageRail`(`EditorView.vue`)に集約するためここには出さない。 -->
      <template v-if="singlePageMode && pageCount > 1">
        <PageNav
          variant="ghost"
          :current-page="currentPage"
          :page-count="pageCount"
          @go="emit('go', $event)"
        />
        <div class="mx-0.5 h-5 w-px bg-border/70" />
      </template>

      <!-- 1 ページ表示 / 全ページ連続表示の切替 -->
      <Button
        variant="ghost"
        size="icon"
        :title="singlePageMode ? '全ページを連続表示' : '1 ページだけ表示'"
        :class="singlePageMode ? 'text-primary' : ''"
        @click="emit('toggleSinglePage')"
      >
        <FileText class="h-[17px] w-[17px]" />
      </Button>

      <!-- ページ境界 guide のトグル -->
      <Button
        variant="ghost"
        size="icon"
        :title="showPageGuides ? 'ページ境界を隠す' : 'ページ境界を表示'"
        :class="showPageGuides ? 'text-primary' : ''"
        @click="emit('togglePageGuides')"
      >
        <Rows3 class="h-[17px] w-[17px]" />
      </Button>
    </div>

    <!-- ── 右ゾーン: 保存状態 + アクション(保存 / プレビュー) ── -->
    <span
      class="flex shrink-0 items-center gap-1.5 whitespace-nowrap text-[12.5px]"
      :class="saveState === 'error' ? 'text-destructive' : 'text-muted-foreground'"
      role="status"
      aria-live="polite"
    >
      <Loader2 v-if="saveState === 'saving'" class="h-[15px] w-[15px] animate-spin" />
      <CheckCircle2 v-else-if="saveState === 'saved'" class="h-[15px] w-[15px] text-success" />
      <AlertCircle v-else-if="saveState === 'error'" class="h-[15px] w-[15px]" />
      <Save v-else class="h-[15px] w-[15px]" />
      <span class="hidden md:inline">{{ statusText }}</span>
    </span>

    <Button
      v-if="saveState === 'error'"
      size="sm"
      variant="outline"
      class="text-destructive hover:text-destructive"
      @click="emit('save')"
    >
      <RotateCcw class="h-4 w-4" /> 再試行
    </Button>
    <Button variant="outline" size="sm" :disabled="saveState === 'saving'" title="今すぐ保存 (⌘S)" @click="emit('save')">
      <Save class="h-[15px] w-[15px]" /> 保存
    </Button>
    <Button size="sm" @click="emit('preview')"><Eye class="h-[15px] w-[15px]" /> プレビュー</Button>
  </header>
</template>
