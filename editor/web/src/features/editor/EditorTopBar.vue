<script setup lang="ts">
// =============================================================================
// EditorTopBar.vue — editor 上部バー(undo/redo / zoom / 保存状態 / プレビュー)
// =============================================================================
import type { TemplateAttributes } from '@editor/shared';
import {
  AlertCircle,
  CheckCircle2,
  Eye,
  Loader2,
  Minus,
  Plus,
  Redo2,
  RotateCcw,
  Rows3,
  Save,
  Undo2,
} from '@lucide/vue';
import BackButton from '@/components/ui/BackButton.vue';
import Badge from '@/components/ui/Badge.vue';
import Button from '@/components/ui/Button.vue';
import type { SaveState } from './useAutosave';

const props = defineProps<{
  fundName: string;
  attributes?: TemplateAttributes;
  saveState: SaveState;
  statusText: string;
  zoom: number;
  canUndo: boolean;
  canRedo: boolean;
  showPageGuides: boolean;
}>();

const emit = defineEmits<{
  undo: [];
  redo: [];
  zoomIn: [];
  zoomOut: [];
  togglePageGuides: [];
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
    class="z-30 flex h-[58px] shrink-0 items-center gap-3.5 border-b bg-card px-4 shadow-sm print:hidden"
  >
    <BackButton :fallback="{ name: 'edit' }" aria-label="一覧へ戻る" />
    <div class="h-[26px] w-px bg-border" />

    <div class="flex min-w-0 flex-col">
      <div class="flex items-center gap-2">
        <span class="truncate text-[15px] font-bold">{{ fundName }}</span>
        <Badge variant="warning">レイアウト調整</Badge>
      </div>
      <div v-if="attributes" class="mt-px flex gap-3.5">
        <span v-for="it in attrItems(attributes)" :key="it.k" class="whitespace-nowrap text-[11.5px] text-muted-foreground">
          {{ it.k }} <span class="mono font-semibold text-foreground">{{ it.v }}</span>
        </span>
      </div>
    </div>

    <span class="flex-1" />

    <!-- undo / redo -->
    <div class="flex items-center gap-1">
      <Button variant="ghost" size="icon" title="元に戻す (⌘Z)" :disabled="!canUndo" @click="emit('undo')">
        <Undo2 class="h-[17px] w-[17px]" />
      </Button>
      <Button variant="ghost" size="icon" title="やり直す (⇧⌘Z)" :disabled="!canRedo" @click="emit('redo')">
        <Redo2 class="h-[17px] w-[17px]" />
      </Button>
    </div>
    <div class="h-[26px] w-px bg-border" />

    <!-- zoom -->
    <div class="flex items-center gap-1.5">
      <Button variant="outline" size="icon" class="h-7 w-7" title="縮小" @click="emit('zoomOut')">
        <Minus class="h-4 w-4" />
      </Button>
      <span class="w-[42px] text-center text-[12.5px] tabular-nums text-muted-foreground">
        {{ Math.round(zoom * 100) }}%
      </span>
      <Button variant="outline" size="icon" class="h-7 w-7" title="拡大" @click="emit('zoomIn')">
        <Plus class="h-4 w-4" />
      </Button>
    </div>
    <div class="h-[26px] w-px bg-border" />

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
    <div class="h-[26px] w-px bg-border" />

    <!-- autosave の状態表示 -->
    <span
      class="flex items-center gap-1.5 text-[12.5px]"
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
    <Button variant="outline" size="sm" :disabled="saveState === 'saving'" title="今すぐ保存" @click="emit('save')">
      <Save class="h-[15px] w-[15px]" /> 保存
    </Button>
    <Button size="sm" @click="emit('preview')"><Eye class="h-[15px] w-[15px]" /> プレビュー</Button>
  </header>
</template>
