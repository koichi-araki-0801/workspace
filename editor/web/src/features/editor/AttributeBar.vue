<script setup lang="ts">
import type { TemplateAttributes } from '@editor/shared';

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
      <span class="mono text-sm font-medium text-foreground">{{ attributes[it.key] }}</span>
    </div>
  </div>
</template>
