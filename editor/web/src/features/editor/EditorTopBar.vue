<script setup lang="ts">
// =============================================================================
// EditorTopBar.vue — editor 上部バー(undo/redo / zoom / 保存状態 / プレビュー)
// =============================================================================
import type { ReviewRequestMeta, TemplateAttributes } from '@editor/shared';
import {
  AlertCircle,
  CheckCircle2,
  CircleHelp,
  Eye,
  FileText,
  Loader2,
  Lock,
  LockOpen,
  Minus,
  Plus,
  Redo2,
  RotateCcw,
  Rows3,
  Save,
  Strikethrough,
  Undo2,
} from '@lucide/vue';
import PageNav from '@/components/PageNav.vue';
import BackButton from '@/components/ui/BackButton.vue';
import Badge from '@/components/ui/Badge.vue';
import Button from '@/components/ui/Button.vue';
import { Tooltip } from '@/components/ui/overlays';
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
  /** 確定版からの変更箇所を赤入れ(旧文言の取り消し線)で表示しているか。 */
  showRedline: boolean;
  /** 赤入れの基準(確定版)があるか。作成経路では無いのでボタンを出さない。 */
  redlineAvailable: boolean;
  /** 1 始まりで表示する現在ページ番号。 */
  currentPage: number;
  pageCount: number;
  singlePageMode: boolean;
  /** 「編集を許可」の状態(左ペイン `PartTree` のトグルと同一 state)。 */
  allowEdit: boolean;
  /** このテンプレの承認待ち申請(あればバッジ表示。クリックで `openReview` を emit)。 */
  pendingReview?: ReviewRequestMeta | null;
}>();

const emit = defineEmits<{
  undo: [];
  redo: [];
  zoomIn: [];
  zoomOut: [];
  /** ズーム%クリック / ⌘0: 全体フィットへ戻す。 */
  zoomReset: [];
  togglePageGuides: [];
  toggleRedline: [];
  /** ページ番号ジャンプ(1 起点)。`EditorView` で `g.goToPage(n - 1)` へ。 */
  go: [page: number];
  toggleSinglePage: [];
  toggleEdit: [];
  help: [];
  save: [];
  preview: [];
  /** 承認待ちバッジのクリック(`EditorView` が精査画面へ遷移する)。 */
  openReview: [];
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
    class="z-30 flex min-h-[58px] shrink-0 flex-wrap items-center gap-x-2 gap-y-2 border-b bg-card px-4 py-1.5 shadow-sm print:hidden"
  >
    <!-- ── 左ゾーン: 一覧へ戻る + 文書情報(タイトル / 属性チップ) ── -->
    <BackButton :fallback="{ name: 'edit' }" aria-label="一覧へ戻る" />
    <div class="h-[26px] w-px shrink-0 bg-border" />

    <!-- 幅の上限を持たせるのは折り返しの抑止。`flex-wrap` の行送りは shrink より先に効くため、
         左ゾーンが伸びると縮む代わりにヘッダが折り返し、右端のプレビューだけが 2 行目へ落ちる。
         上限は属性チップ 1 行分(実測 418px)で、長いファンド名は truncate へ回す。 -->
    <div class="flex min-w-0 max-w-[420px] flex-col">
      <div class="flex min-w-0 items-center gap-2">
        <span class="truncate text-[15px] font-bold">{{ fundName }}</span>
        <!-- 確定状態のバッジ。下書きは常時自動保存されるが「確定保存」は preview 画面で行うため、
             未確定の編集が残っているかをここで明示する(自動保存ステータスとは別物)。 -->
        <Tooltip v-if="dirty" text="確定保存していない編集があります。プレビュー画面で確定保存できます。">
          <Badge variant="warning" class="shrink-0 whitespace-nowrap">未確定</Badge>
        </Tooltip>
        <Tooltip v-else text="未確定の変更はありません。">
          <Badge variant="secondary" class="shrink-0 whitespace-nowrap">変更なし</Badge>
        </Tooltip>
        <!-- 承認待ちバッジ。申請中のテンプレを重ねて編集し始める事故の抑止も兼ねて常時表示し、
             クリックで精査画面へ飛ぶ(セッション維持の往復 — `useTemplateEditor` の離脱ガード)。 -->
        <Tooltip
          v-if="pendingReview"
          text="このテンプレートには承認待ちの申請があります。クリックで内容を確認します（編集内容は保持されます）。"
        >
          <button
            type="button"
            class="ring-focus shrink-0 rounded-md"
            aria-label="承認待ちの申請を確認"
            @click="emit('openReview')"
          >
            <Badge
              variant="warning"
              class="cursor-pointer whitespace-nowrap transition-colors hover:bg-warning/30"
            >
              承認待ち
            </Badge>
          </button>
        </Tooltip>
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
      <!-- 編集ロックの状態と解除。左ペインの「編集を許可」トグルと同一 state を、常に見える
           上部バーにも出す(左ペインを畳んでいても編集ロックに気付け、その場で解除できる)。 -->
      <Tooltip :text="allowEdit ? '編集中(クリックで閲覧のみに戻す)' : '閲覧のみ(クリックで編集を許可)'">
        <Button
          variant="ghost"
          size="sm"
          class="gap-1.5 px-2"
          :class="allowEdit ? 'text-primary' : 'text-muted-foreground'"
          :aria-label="allowEdit ? '編集中(クリックで閲覧のみに戻す)' : '閲覧のみ(クリックで編集を許可)'"
          :aria-pressed="allowEdit"
          @click="emit('toggleEdit')"
        >
          <component :is="allowEdit ? LockOpen : Lock" class="h-[15px] w-[15px]" />
          <span class="text-xs font-medium">{{ allowEdit ? '編集中' : '閲覧のみ' }}</span>
        </Button>
      </Tooltip>

      <div class="mx-0.5 h-5 w-px bg-border/70" />

      <!-- 元に戻す / やり直す -->
      <Tooltip text="元に戻す (⌘Z)">
        <Button variant="ghost" size="icon" aria-label="元に戻す" :disabled="!canUndo" @click="emit('undo')">
          <Undo2 class="h-[17px] w-[17px]" />
        </Button>
      </Tooltip>
      <Tooltip text="やり直す (⇧⌘Z)">
        <Button variant="ghost" size="icon" aria-label="やり直す" :disabled="!canRedo" @click="emit('redo')">
          <Redo2 class="h-[17px] w-[17px]" />
        </Button>
      </Tooltip>

      <div class="mx-0.5 h-5 w-px bg-border/70" />

      <!-- ズーム -->
      <Tooltip text="縮小 (⌘-)">
        <Button variant="ghost" size="icon" aria-label="縮小" @click="emit('zoomOut')">
          <Minus class="h-4 w-4" />
        </Button>
      </Tooltip>
      <!-- % はボタン: クリックで全体フィット(プレビュー画面の % クリックと挙動を統一)。 -->
      <Tooltip text="画面に合わせる (⌘0)">
        <Button
          variant="ghost"
          class="h-auto w-[42px] rounded p-0 text-[12.5px] font-normal tabular-nums text-muted-foreground hover:bg-transparent hover:text-foreground"
          aria-label="画面に合わせる"
          @click="emit('zoomReset')"
        >
          {{ Math.round(zoom * 100) }}%
        </Button>
      </Tooltip>
      <Tooltip text="拡大 (⌘+)">
        <Button variant="ghost" size="icon" aria-label="拡大" @click="emit('zoomIn')">
          <Plus class="h-4 w-4" />
        </Button>
      </Tooltip>

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
      <Tooltip :text="singlePageMode ? '全ページを連続表示' : '1 ページだけ表示'">
        <Button
          variant="ghost"
          size="icon"
          :aria-label="singlePageMode ? '全ページを連続表示' : '1 ページだけ表示'"
          :class="singlePageMode ? 'text-primary' : ''"
          @click="emit('toggleSinglePage')"
        >
          <FileText class="h-[17px] w-[17px]" />
        </Button>
      </Tooltip>

      <!-- ページ境界 guide のトグル -->
      <Tooltip :text="showPageGuides ? 'ページ境界を隠す' : 'ページ境界を表示'">
        <Button
          variant="ghost"
          size="icon"
          :aria-label="showPageGuides ? 'ページ境界を隠す' : 'ページ境界を表示'"
          :class="showPageGuides ? 'text-primary' : ''"
          @click="emit('togglePageGuides')"
        >
          <Rows3 class="h-[17px] w-[17px]" />
        </Button>
      </Tooltip>

      <!-- 確定版からの変更箇所の赤入れ。旧文言をインラインで挿すため行送りが PDF とずれる —
           OFF で流れを戻せる。作成経路は確定版が無いので出さない。 -->
      <Tooltip
        v-if="redlineAvailable"
        :text="showRedline ? '変更箇所の赤入れを隠す' : '変更箇所を赤入れで表示（旧文言に取り消し線）'"
      >
        <Button
          variant="ghost"
          size="icon"
          :aria-label="showRedline ? '変更箇所の赤入れを隠す' : '変更箇所を赤入れで表示'"
          :class="showRedline ? 'text-primary' : ''"
          @click="emit('toggleRedline')"
        >
          <Strikethrough class="h-[17px] w-[17px]" />
        </Button>
      </Tooltip>
    </div>

    <!-- ── 右ゾーン: 保存状態 + アクション(保存 / プレビュー) ── -->
    <span
      class="flex shrink-0 items-center gap-1.5 whitespace-nowrap text-[12.5px]"
      :class="saveState === 'error' ? 'text-destructive' : 'text-muted-foreground'"
      role="status"
      aria-live="polite"
      :title="statusText"
    >
      <Loader2 v-if="saveState === 'saving'" class="h-[15px] w-[15px] animate-spin" />
      <CheckCircle2 v-else-if="saveState === 'saved'" class="h-[15px] w-[15px] text-success" />
      <AlertCircle v-else-if="saveState === 'error'" class="h-[15px] w-[15px]" />
      <Save v-else class="h-[15px] w-[15px]" />
      <!-- 保存失敗だけは狭幅でも文言を出す — アイコンのみでは失敗を見逃しうるため。
           正常時の閾値が 2xl(1536px)と高いのはヘッダを 1 行に保つため。この行の 1 行分の
           余裕は約 60px しかなく、「HH:MM に自動保存」(117px)を出すとヘッダが折り返して
           右端の「プレビュー」が 2 行目へ落ちる。隠しても状態はアイコンが示し、全文は
           この span の親が `title` で見せる。 -->
      <span :class="saveState === 'error' ? 'inline' : 'hidden 2xl:inline'">{{ statusText }}</span>
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
    <Tooltip text="キーボードショートカット (?)">
      <Button variant="ghost" size="icon" aria-label="キーボードショートカット" @click="emit('help')">
        <CircleHelp class="h-[17px] w-[17px]" />
      </Button>
    </Tooltip>
    <Tooltip text="今すぐ保存 (⌘S)">
      <Button variant="outline" size="sm" :disabled="saveState === 'saving'" @click="emit('save')">
        <Save class="h-[15px] w-[15px]" /> 保存
      </Button>
    </Tooltip>
    <Button size="sm" @click="emit('preview')"><Eye class="h-[15px] w-[15px]" /> プレビュー</Button>
  </header>
</template>
