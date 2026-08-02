<script setup lang="ts">
// =============================================================================
// MergeSelectionList.vue — 結合対象テンプレの選択済みリスト(並び替え/削除)
// =============================================================================
// 並び順 = 結合 PDF のページ順。並び替えは上下ボタン方式 — D&D ライブラリの新規依存を
// 増やさず、キーボード操作でも順序を確定できる。
import type { TemplateMeta } from '@editor/shared';
import { ArrowDown, ArrowUp, FileStack, X } from '@lucide/vue';
import FundCodeName from '@/components/FundCodeName.vue';
import Button from '@/components/ui/Button.vue';

defineProps<{ items: TemplateMeta[] }>();

const emit = defineEmits<{ move: [index: number, dir: -1 | 1]; remove: [index: number] }>();
</script>

<template>
  <div class="rounded-lg border bg-card">
    <div class="border-b px-4 py-2.5 text-sm font-semibold">
      結合する順序({{ items.length }}件)
    </div>
    <ul v-if="items.length > 0" class="divide-y">
      <li v-for="(m, i) in items" :key="m.id" class="flex items-center gap-3 px-4 py-2">
        <span class="w-6 shrink-0 text-center font-semibold text-muted-foreground">{{ i + 1 }}</span>
        <div class="min-w-0 flex-1">
          <div class="truncate">
            <FundCodeName :code="m.attributes.fundCode" />
          </div>
          <div class="mono truncate text-xs text-muted-foreground">
            {{ m.attributes.companyCode }} / {{ m.attributes.baseDate }} / {{ m.attributes.editionType }}
          </div>
        </div>
        <div class="flex shrink-0 items-center gap-1">
          <Button variant="ghost" size="iconSm" :disabled="i === 0" aria-label="上へ" @click="emit('move', i, -1)">
            <ArrowUp class="h-4 w-4" />
          </Button>
          <Button
            variant="ghost"
            size="iconSm"
            :disabled="i === items.length - 1"
            aria-label="下へ"
            @click="emit('move', i, 1)"
          >
            <ArrowDown class="h-4 w-4" />
          </Button>
          <Button variant="ghost" size="iconSm" aria-label="削除" @click="emit('remove', i)">
            <X class="h-4 w-4" />
          </Button>
        </div>
      </li>
    </ul>
    <div v-else class="flex flex-col items-center gap-2 px-4 py-8 text-sm text-muted-foreground">
      <FileStack class="h-8 w-8 opacity-40" />
      <span>検索結果から「追加」でテンプレートを選んでください</span>
    </div>
  </div>
</template>
