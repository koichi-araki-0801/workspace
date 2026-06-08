<script setup lang="ts">
import type { PartCatalogItem } from '@editor/shared';
import { computed } from 'vue';

const props = defineProps<{ part: PartCatalogItem | null }>();

const classificationPath = computed(() => {
  const c = props.part?.classification;
  return c ? [c.category, c.majorClass, c.middleClass, c.minorClass].join(' ＞ ') : '';
});

function fmt(ts: string | null): string {
  return ts ? new Date(ts).toLocaleString('ja-JP') : '—';
}
</script>

<template>
  <div v-if="!part" class="px-3 py-4 text-xs text-muted-foreground">パーツを選択してください</div>
  <div v-else class="space-y-4 px-3 py-3">
    <!-- 名称・説明 -->
    <section class="space-y-1">
      <h3 class="text-sm font-semibold text-foreground">{{ part.name }}</h3>
      <p class="text-xs leading-relaxed text-muted-foreground">{{ part.description }}</p>
    </section>

    <!-- 分類パス -->
    <section class="space-y-1">
      <div class="text-xs text-muted-foreground">分類</div>
      <div class="rounded-md bg-muted/40 px-2 py-1.5 text-xs text-foreground">{{ classificationPath }}</div>
    </section>

    <!-- 使用上の注意・更新情報 -->
    <section class="space-y-1">
      <div class="text-xs text-muted-foreground">使用上の注意</div>
      <p class="text-xs leading-relaxed text-foreground">{{ part.usageNotes }}</p>
    </section>

    <section class="space-y-0.5 border-t pt-2 text-xs text-muted-foreground">
      <div>更新: {{ fmt(part.updatedAt) }}</div>
      <div>更新者: {{ part.updatedBy ?? '—' }}</div>
    </section>
  </div>
</template>
