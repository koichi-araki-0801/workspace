<script setup lang="ts">
import type { PartCatalogItem, PartClassificationOptions, PartClassificationQuery } from '@editor/shared';
import { Inbox, Loader2, Plus } from 'lucide-vue-next';
import { computed, ref } from 'vue';
import Input from '@/components/ui/Input.vue';
import Label from '@/components/ui/Label.vue';
import Select from '@/components/ui/Select.vue';
import { useCascadingSelect } from '@/lib/useCascadingSelect';
import { usePartCatalogService } from './services/partCatalogService';

const emit = defineEmits<{ select: [PartCatalogItem]; insert: [PartCatalogItem] }>();

const service = usePartCatalogService();

type LevelKey = keyof PartClassificationQuery & string;

const levels: Array<{ key: LevelKey; label: string }> = [
  { key: 'category', label: 'カテゴリ' },
  { key: 'majorClass', label: '大分類' },
  { key: 'middleClass', label: '中分類' },
  { key: 'minorClass', label: '小分類' },
];

const EMPTY: PartClassificationOptions = {
  categories: [],
  majorClasses: [],
  middleClasses: [],
  minorClasses: [],
};

const { query, options, list: parts, loading, onLevelChange } = useCascadingSelect<
  PartClassificationQuery,
  PartClassificationOptions,
  PartCatalogItem
>({
  levels: levels.map((l) => l.key),
  emptyOptions: EMPTY,
  fetchOptions: (q) => service.getOptions(q),
  fetchList: (q) => service.list(q),
});

const search = ref('');
const selectedId = ref<string | null>(null);

const optionsByLevel: Record<LevelKey, () => string[]> = {
  category: () => options.value.categories,
  majorClass: () => options.value.majorClasses,
  middleClass: () => options.value.middleClasses,
  minorClass: () => options.value.minorClasses,
};

const filteredParts = computed(() => {
  const q = search.value.trim();
  return q ? parts.value.filter((p) => p.name.includes(q)) : parts.value;
});

function onSelect(p: PartCatalogItem) {
  selectedId.value = p.id;
  emit('select', p);
}

function onInsert(p: PartCatalogItem) {
  selectedId.value = p.id;
  emit('insert', p);
}
</script>

<template>
  <div class="flex h-full flex-col">
    <!-- cascading dropdowns (vertically stacked) -->
    <div class="space-y-2 border-b px-3 py-3">
      <div v-for="lvl in levels" :key="lvl.key" class="space-y-1">
        <Label class="text-xs text-muted-foreground">{{ lvl.label }}</Label>
        <Select
          v-model="query[lvl.key]"
          :options="optionsByLevel[lvl.key]()"
          :placeholder="`${lvl.label}を選択`"
          :disabled="loading"
          @update:model-value="onLevelChange(lvl.key)"
        />
      </div>
      <Input v-model="search" placeholder="名称で検索" class="mt-1" />
    </div>

    <!-- filtered parts list -->
    <div class="flex-1 overflow-auto px-2 py-2">
      <div v-if="loading" class="flex items-center justify-center gap-2 py-6 text-xs text-muted-foreground">
        <Loader2 class="h-4 w-4 animate-spin" /> 読み込み中…
      </div>
      <div
        v-else-if="filteredParts.length === 0"
        class="flex flex-col items-center gap-2 py-8 text-center text-xs text-muted-foreground"
      >
        <Inbox class="h-7 w-7 opacity-40" />
        <span>該当するパーツがありません</span>
      </div>
      <ul v-else class="space-y-1">
        <li
          v-for="p in filteredParts"
          :key="p.id"
          class="group rounded-md border px-2 py-1.5 transition-colors hover:bg-accent"
          :class="selectedId === p.id ? 'border-primary bg-accent' : 'border-transparent'"
        >
          <button type="button" class="block w-full text-left" @click="onSelect(p)">
            <div class="truncate text-sm font-medium text-foreground">{{ p.name }}</div>
            <div class="truncate text-xs text-muted-foreground">{{ p.classification.minorClass }}</div>
          </button>
          <button
            type="button"
            class="mt-1 inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-xs text-primary hover:bg-primary/10"
            @click="onInsert(p)"
          >
            <Plus class="h-3.5 w-3.5" /> 挿入
          </button>
        </li>
      </ul>
    </div>
  </div>
</template>
