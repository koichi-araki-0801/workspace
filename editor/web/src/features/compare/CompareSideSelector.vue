<script setup lang="ts">
// =============================================================================
// CompareSideSelector.vue — 比較の片側(A/B)でテンプレートと版を選ぶセレクタ
// =============================================================================
import { type DropdownQuery, isErr, type TemplateMeta, type TemplateVersionMeta } from '@editor/shared';
import { computed, onMounted, ref, watch } from 'vue';
import Label from '@/components/ui/Label.vue';
import Select from '@/components/ui/Select.vue';
import SearchFilters from '@/features/templates/components/SearchFilters.vue';
import { formatDateTimeShort } from '@/lib/format';
import { useAsyncResult } from '@/lib/useAsyncResult';
import CompareCandidateTable from './CompareCandidateTable.vue';
import { type CompareCandidate, useCompareService } from './services/compareService';

defineProps<{ heading?: string }>();
const emit = defineEmits<{
  change: [{ meta: TemplateMeta; version: TemplateVersionMeta } | null];
}>();

const compare = useCompareService();
const { run } = useAsyncResult();

const candidates = ref<CompareCandidate[]>([]);
const templateId = ref<string | undefined>(undefined);
const selectedMeta = ref<TemplateMeta | null>(null);
const versions = ref<TemplateVersionMeta[]>([]);
const historyId = ref<string | undefined>(undefined);

const versionOptions = computed(() =>
  versions.value.map((v) => ({
    // 現行版(原本)は `timestamp` を持たない。日時を出さず「現行版」だけを見せる。
    label: v.timestamp ? `${formatDateTimeShort(v.timestamp)}・${v.user}` : v.user,
    value: v.historyId,
  })),
);

function emitChange() {
  const v = versions.value.find((x) => x.historyId === historyId.value);
  emit('change', selectedMeta.value && v ? { meta: selectedMeta.value, version: v } : null);
}

async function refreshCandidates(query: DropdownQuery) {
  const res = await run(() => compare.listCandidates(query));
  if (isErr(res)) return;
  candidates.value = res.value;
  // 絞り込み後に現在の選択が候補一覧から消えたらクリアする。
  if (!res.value.some((c) => c.meta.id === templateId.value)) pick(null);
}

function pick(meta: TemplateMeta | null) {
  templateId.value = meta?.id;
  selectedMeta.value = meta;
  historyId.value = undefined;
  versions.value = [];
  emitChange();
}

onMounted(() => refreshCandidates({}));

watch(templateId, async (id) => {
  versions.value = [];
  if (!id) return;
  const res = await run(() => compare.listVersions(id));
  if (isErr(res)) return;
  versions.value = res.value; // 新しい順(newest first)
  historyId.value = res.value[0]?.historyId; // 既定で最新版を選ぶ
  emitChange();
});

watch(historyId, emitChange);
</script>

<template>
  <div class="space-y-3">
    <h3 v-if="heading" class="text-[15px] font-bold">{{ heading }}</h3>
    <SearchFilters bare search-label="絞り込み" @update="refreshCandidates" @search="refreshCandidates" />
    <CompareCandidateTable
      :rows="candidates"
      :selected-id="templateId"
      :min-versions="1"
      @select="pick"
    />
    <div v-if="templateId" class="space-y-1.5">
      <Label>比較する版</Label>
      <Select v-model="historyId" :options="versionOptions" placeholder="版を選択" class="max-w-[360px]" />
    </div>
  </div>
</template>
