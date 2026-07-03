<script setup lang="ts">
// =============================================================================
// AttributeBar.vue — template 属性(委託会社コード等)の横並びサマリ表示
// =============================================================================
import type { TemplateAttributes } from '@editor/shared';
import { watch } from 'vue';
import { useFundNames } from '@/lib/useFundNames';

const props = defineProps<{ attributes: TemplateAttributes }>();

const items: Array<{ key: keyof TemplateAttributes; label: string }> = [
  { key: 'companyCode', label: '委託会社コード' },
  { key: 'fundCode', label: 'ファンドコード' },
  { key: 'baseDate', label: '基準日' },
  { key: 'editionType', label: '版種' },
];

const { resolve, nameOf } = useFundNames();
watch(() => props.attributes.fundCode, (code) => resolve([code]), { immediate: true });
</script>

<template>
  <div class="flex flex-wrap gap-x-6 gap-y-1 rounded-lg border bg-muted/40 px-4 py-2">
    <div v-for="it in items" :key="it.key" class="flex flex-col">
      <span class="text-xs text-muted-foreground">{{ it.label }}</span>
      <span class="text-sm font-medium text-foreground">
        <span class="mono">{{ attributes[it.key] }}</span>
        <span v-if="it.key === 'fundCode' && nameOf(attributes.fundCode)" class="ml-2 font-normal text-muted-foreground">
          {{ nameOf(attributes.fundCode) }}
        </span>
      </span>
    </div>
  </div>
</template>
