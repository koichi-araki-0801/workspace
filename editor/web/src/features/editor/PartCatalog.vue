<script setup lang="ts">
// =============================================================================
// PartCatalog.vue — 分類で絞り込む parts catalog(編集 canvas への挿入元)
// =============================================================================
// 4 段の連動プルダウンで小分類まで選ぶと対象パーツが 1 件に確定し、下部にその視覚
// プレビューを出して「追加」ボタンで canvas へ挿入する。小分類が同名で複数該当する
// ときだけコンパクトな選択リストを挟む。名称検索は廃止した(分類で十分絞れるため)。
import type { PartCatalogItem, PartClassificationOptions, PartClassificationQuery } from '@editor/shared';
import { Inbox, Loader2, Plus } from '@lucide/vue';
import { computed, ref, watch } from 'vue';
import Button from '@/components/ui/Button.vue';
import Label from '@/components/ui/Label.vue';
import Select from '@/components/ui/Select.vue';
import { useCascadingSelect } from '@/lib/useCascadingSelect';
import { useUrlQuerySync } from '@/lib/useUrlQuerySync';
import { cn } from '@/lib/utils';
import PartPreview from './PartPreview.vue';
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

// 分類4段を URL クエリへ同期し、編集画面を離れて戻っても絞り込みを復元する。
// EditorView の他 URL パラメータと衝突しないよう `pc` 接頭辞を付ける。
// 一覧(parts)は onMounted(refresh) が常に再取得するので restore 通知は不要。
useUrlQuerySync(query, {
  keys: levels.map((l) => l.key),
  prefix: 'pc',
});

const optionsByLevel: Record<LevelKey, () => string[]> = {
  category: () => options.value.categories,
  majorClass: () => options.value.majorClasses,
  middleClass: () => options.value.middleClasses,
  minorClass: () => options.value.minorClasses,
};

// プレビュー & 追加の対象となる単一選択。`parts` から id で引いて実体に解決する。
const selectedId = ref<string | null>(null);
const selectedPart = computed(() => parts.value.find((p) => p.id === selectedId.value) ?? null);

// 絞り込み結果が変わるたび、1 件なら自動選択し、選択中が消えていれば解除する。
// (複数件のときは下のコンパクトリストでユーザーが 1 件を選ぶ)
watch(parts, (list) => {
  if (list.length === 1) selectedId.value = list[0].id;
  else if (!list.some((p) => p.id === selectedId.value)) selectedId.value = null;
});

// 左の選択と右ペイン Inspector のメタ表示を揃えるため、選択確定で `select` を流す。
watch(selectedPart, (p) => {
  if (p) emit('select', p);
});

function onSelect(p: PartCatalogItem) {
  selectedId.value = p.id;
}

function onInsert() {
  if (selectedPart.value) emit('insert', selectedPart.value);
}
</script>

<template>
  <div class="flex h-full flex-col">
    <!-- cascading なドロップダウン(縦積み) -->
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
    </div>

    <!-- 複数候補のときだけ出すコンパクトな選択リスト -->
    <div v-if="parts.length > 1" class="max-h-32 overflow-auto border-b px-2 py-1.5">
      <ul class="space-y-0.5">
        <li v-for="p in parts" :key="p.id">
          <Button
            variant="ghost"
            :class="
              cn(
                'block h-auto w-full truncate rounded px-2 py-1 text-left font-normal',
                selectedId === p.id
                  ? 'bg-accent font-medium text-foreground'
                  : 'text-muted-foreground hover:text-muted-foreground',
              )
            "
            @click="onSelect(p)"
          >
            {{ p.name }}
          </Button>
        </li>
      </ul>
    </div>

    <!-- プレビュー領域 -->
    <div class="flex-1 overflow-auto px-3 py-3">
      <div v-if="loading" class="flex items-center justify-center gap-2 py-6 text-xs text-muted-foreground">
        <Loader2 class="h-4 w-4 animate-spin" /> 読み込み中…
      </div>
      <div
        v-else-if="parts.length === 0 && (query.category || query.majorClass)"
        class="flex flex-col items-center gap-2 py-8 text-center text-xs text-muted-foreground"
      >
        <Inbox class="h-7 w-7 opacity-40" />
        <span>該当するパーツがありません</span>
      </div>
      <template v-else>
        <PartPreview :content="selectedPart?.content ?? null" />
        <div v-if="selectedPart" class="mt-2.5">
          <div class="truncate text-sm font-semibold text-foreground">{{ selectedPart.name }}</div>
          <p class="mt-0.5 text-xs leading-snug text-muted-foreground">{{ selectedPart.description }}</p>
        </div>
      </template>
    </div>

    <!-- 追加ボタン(下部固定): 選択確定時のみ有効。
         `aria-label` で左ペインの「パーツを追加」トグルとアクセシブル名を区別する
         (どちらも文言に「追加」を含み、支援技術/自動化での取り違えを避ける)。 -->
    <div class="border-t px-3 py-2.5">
      <Button class="w-full" :disabled="!selectedPart" aria-label="選択したパーツを挿入" @click="onInsert">
        <Plus class="h-4 w-4" /> 追加
      </Button>
    </div>
  </div>
</template>
