<script setup lang="ts">
// =============================================================================
// AttributeBar.vue — template 属性(委託会社コード等)の横並びサマリ表示
// =============================================================================
import type { TemplateAttributes } from '@editor/shared';
import FundCodeName from '@/components/FundCodeName.vue';

defineProps<{ attributes: TemplateAttributes }>();

const items: Array<{ key: keyof TemplateAttributes; label: string }> = [
  { key: 'companyCode', label: '委託会社コード' },
  { key: 'fundCode', label: 'ファンドコード' },
  { key: 'baseDate', label: '基準日' },
  { key: 'editionType', label: '版種' },
];
</script>

<template>
  <div class="flex flex-wrap gap-x-6 gap-y-1 rounded-lg border bg-muted/40 px-4 py-2">
    <div v-for="it in items" :key="it.key" class="flex flex-col">
      <span class="text-xs text-muted-foreground">{{ it.label }}</span>
      <span class="text-sm text-foreground">
        <!-- fundCode 列だけコード＋解決名の共有部品へ委譲(名前解決の配線を二重に持たない) -->
        <FundCodeName v-if="it.key === 'fundCode'" :code="attributes.fundCode" />
        <span v-else class="mono font-medium">{{ attributes[it.key] }}</span>
      </span>
    </div>
  </div>
</template>
