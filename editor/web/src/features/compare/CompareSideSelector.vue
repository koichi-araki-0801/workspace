<script setup lang="ts">
// =============================================================================
// CompareSideSelector.vue — 比較の片側(A/B)でテンプレートと版を選ぶセレクタ
// =============================================================================
import { type DropdownQuery, isErr, type TemplateMeta, type TemplateVersionMeta } from '@editor/shared';
import { computed, ref, watch } from 'vue';
import Label from '@/components/ui/Label.vue';
import Select from '@/components/ui/Select.vue';
import SearchFilters from '@/features/templates/components/SearchFilters.vue';
import { versionLabel } from '@/lib/format';
import { useAsyncResult } from '@/lib/useAsyncResult';
import CompareCandidateTable from './CompareCandidateTable.vue';
import { type CompareCandidate, type CompareVersionRow, useCompareService } from './services/compareService';

// `side` は URL クエリ同期の名前空間 ('a'/'b')。同一ルート(/compare)に A/B 2 つ置くため,
// 互いの絞り込みキーが衝突しないよう接頭辞として SearchFilters へ渡す。
defineProps<{ heading?: string; side?: string }>();
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
// 一度でも絞り込み/検索したか。未検索のうちは候補を出さず検索を促す
// (初期マウントで全件を出していた挙動を廃止)。
const searched = ref(false);

// 候補テンプレートを「テンプレート × 版」に平坦化し、版ごとの行としてテーブルへ渡す。
const rows = computed<CompareVersionRow[]>(() =>
  candidates.value.flatMap((c) => c.versions.map((version) => ({ meta: c.meta, version }))),
);

const versionOptions = computed(() =>
  versions.value.map((v) => ({ label: versionLabel(v), value: v.historyId })),
);

function emitChange() {
  const v = versions.value.find((x) => x.historyId === historyId.value);
  emit('change', selectedMeta.value && v ? { meta: selectedMeta.value, version: v } : null);
}

async function refreshCandidates(query: DropdownQuery) {
  searched.value = true; // @update/@search のどちらでもユーザー操作時に立つ。
  const res = await run(() => compare.listCandidates(query));
  if (isErr(res)) return;
  candidates.value = res.value;
  // 既存選択がまだ候補内にあれば版の選択状態を保持する。消えていた場合は、候補が
  // 1 件に確定したら連動で自動選択し「比較する版」を有効化、複数なら選択をクリアする。
  if (!res.value.some((c) => c.meta.id === templateId.value)) {
    pick(res.value.length === 1 ? res.value[0] : null);
  }
}

// 候補が 1 件に確定したときの自動選択。版は候補が持つリストから取り、既定で最新版を選ぶ。
function pick(candidate: CompareCandidate | null) {
  templateId.value = candidate?.meta.id;
  selectedMeta.value = candidate?.meta ?? null;
  versions.value = candidate?.versions ?? [];
  historyId.value = candidate?.versions[0]?.historyId; // 新しい順の先頭 = 最新版
  emitChange();
}

// テーブルの版行を直接クリックしたとき。テンプレートと版を同時に確定し、ドロップダウン
// (versionOptions/historyId)もその版へ連動する。
function selectVersion(row: CompareVersionRow) {
  templateId.value = row.meta.id;
  selectedMeta.value = row.meta;
  versions.value = candidates.value.find((c) => c.meta.id === row.meta.id)?.versions ?? [row.version];
  historyId.value = row.version.historyId;
  emitChange();
}

// ドロップダウンで版を切り替えたときも変更を伝える(同一テンプレ内の版移動)。
watch(historyId, emitChange);
</script>

<template>
  <div class="space-y-3">
    <h3 v-if="heading" class="text-[15px] font-bold">{{ heading }}</h3>
    <SearchFilters
      bare
      stack-actions
      search-label="絞り込み"
      :query-key="side"
      @update="refreshCandidates"
      @search="refreshCandidates"
      @restore="refreshCandidates"
    >
      <!-- 版種の右で「比較する版」を直接選ばせる。操作(選択)と表示を同じ位置にまとめる
           ため、旧・読み取り専用インジケータを廃しドロップダウン本体をここへ移設した。 -->
      <template #field-trailing>
        <div class="min-w-[220px] flex-1 space-y-1.5">
          <Label>比較する版</Label>
          <!-- テンプレート未選択時は版が無いので非活性。placeholder が旧「未選択」を兼ねる。 -->
          <Select v-model="historyId" :options="versionOptions" :disabled="!templateId" placeholder="版を選択" />
        </div>
      </template>
    </SearchFilters>
    <CompareCandidateTable
      v-if="searched"
      :rows="rows"
      :selected-id="historyId"
      @select="selectVersion"
    />
    <!-- 未検索のうちは候補を出さず、絞り込みを促す (初期全量表示の廃止)。 -->
    <p v-else class="rounded-lg border border-dashed bg-card px-4 py-8 text-center text-[13px] text-muted-foreground">
      委託会社・ファンド・基準日・版種で絞り込み、検索してください。
    </p>
  </div>
</template>
