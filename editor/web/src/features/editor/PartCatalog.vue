<script lang="ts">
/** 編集中テンプレートの委託会社(Rep1 の委託会社コード)の解決状況。 */
export type CompanyFilter = { state: 'pending' } | { state: 'none' } | { state: 'ok'; code: string };
</script>

<script setup lang="ts">
// =============================================================================
// PartCatalog.vue — 分類で絞り込む parts catalog(編集 canvas への挿入元)
// =============================================================================
// 4 段の連動プルダウンで小分類まで選ぶと対象パーツが 1 件に確定し、下部にその視覚
// プレビューを出して「追加」ボタンで canvas へ挿入する。小分類が同名で複数該当する
// ときだけコンパクトな選択リストを挟む。名称検索は持たない(分類で十分絞れるため)。
import {
  ok,
  type PartCatalogItem,
  type PartClassificationOptions,
  type PartClassificationQuery,
} from '@editor/shared';
import { Inbox, Loader2, Plus } from '@lucide/vue';
import { computed, ref, watch } from 'vue';
import { usePartRepo } from '@/api/repositories';
import Button from '@/components/ui/Button.vue';
import Label from '@/components/ui/Label.vue';
import { Tooltip } from '@/components/ui/overlays';
import Select from '@/components/ui/Select.vue';
import { useCascadingSelect } from '@/lib/useCascadingSelect';
import { useUrlQuerySync } from '@/lib/useUrlQuerySync';
import { cn } from '@/lib/utils';
import PartPreview from './PartPreview.vue';

const props = defineProps<{
  /** 今のページに挿入できないときの理由。null なら挿入できる。 */
  insertBlockedReason?: string | null;
  /** 編集中テンプレートの版種。空なら全件。一覧と分類候補をこの版で絞る(URL には載せない)。 */
  editionType?: string | null;
  /**
   * 編集中テンプレートの委託会社。解決できるまで(pending)は一覧を取らず、解決できなければ(none)
   * 空にする。他社のパーツを出さないため、全件にはフォールバックしない。URL には載せない。
   */
  companyFilter: CompanyFilter;
}>();
const emit = defineEmits<{ select: [PartCatalogItem]; insert: [PartCatalogItem] }>();

const repo = usePartRepo();

type LevelKey = Exclude<keyof PartClassificationQuery, 'editionType' | 'companyCode'>;

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

// 版種と委託会社は分類の選択ではなく編集中テンプレートの属性なので、`query`(= URL 同期の対象)へは
// 入れず、取得の直前にだけ足す。
const withEdition = (q: PartClassificationQuery): PartClassificationQuery => {
  const withType = props.editionType ? { ...q, editionType: props.editionType } : q;
  return props.companyFilter.state === 'ok'
    ? { ...withType, companyCode: props.companyFilter.code }
    : withType;
};

// 委託会社が決まるまでは取りに行かない(絞り込み無しの全件を一瞬でも出さない)。
const canFetch = () => props.companyFilter.state === 'ok';

const { query, options, list: parts, loading, onLevelChange, reset, refresh } = useCascadingSelect<
  PartClassificationQuery,
  PartClassificationOptions,
  PartCatalogItem
>({
  levels: levels.map((l) => l.key),
  emptyOptions: EMPTY,
  fetchOptions: (q) =>
    canFetch() ? repo.getPartClassificationOptions(withEdition(q)) : Promise.resolve(ok(EMPTY)),
  fetchList: (q) => (canFetch() ? repo.listParts(withEdition(q)) : Promise.resolve(ok([]))),
});

// 分類4段を URL クエリへ同期し、編集画面を離れて戻っても絞り込みを復元する。
// EditorView の他 URL パラメータと衝突しないよう `pc` 接頭辞を付ける。
// 一覧(parts)は onMounted(refresh) が常に再取得するので restore 通知は不要。
useUrlQuerySync(query, {
  keys: levels.map((l) => l.key),
  prefix: 'pc',
});

// 版種が変わったら(別テンプレートへの切り替え等)、選択を解いて候補と一覧を取り直す。
// 選択が残ると、新しい条件で隠れる分類を選んだまま一覧が空になる。
watch(
  () => props.editionType,
  () => reset(),
);

// 委託会社の解決状況が変わったら取り直す。解決済みの会社から別の状態へ変わったときだけ選択も解く。
// 最初の pending → ok では解かない(URL から復元した分類を残す)。pending / none へ変わるときも
// refresh を通すのは、前の会社の取得中の応答を捨てて一覧を空にするため。
watch(
  () => [
    props.companyFilter.state,
    props.companyFilter.state === 'ok' ? props.companyFilter.code : null,
  ],
  (_now, prev) => (prev[0] === 'ok' ? reset() : void refresh()),
);

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
      <div
        v-if="companyFilter.state === 'none'"
        class="flex flex-col items-center gap-2 py-8 text-center text-xs text-muted-foreground"
      >
        <Inbox class="h-7 w-7 opacity-40" />
        <span>委託会社を特定できないため、パーツを表示できません</span>
      </div>
      <div
        v-else-if="loading || companyFilter.state === 'pending'"
        class="flex items-center justify-center gap-2 py-6 text-xs text-muted-foreground">
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
         (どちらも文言に「追加」を含み、支援技術/自動化での取り違えを避ける)。
         挿入できないページでは押せず、理由をツールチップで出す(押せないボタンはポインタのイベントを
         受けないので、包みの `span` で受ける)。 -->
    <div class="border-t px-3 py-2.5">
      <Tooltip :text="insertBlockedReason ?? ''" :disabled="!insertBlockedReason">
        <span class="block" :tabindex="insertBlockedReason ? 0 : undefined">
          <Button
            class="w-full"
            :disabled="!selectedPart || !!insertBlockedReason"
            aria-label="選択したパーツを挿入"
            @click="onInsert"
          >
            <Plus class="h-4 w-4" /> 追加
          </Button>
        </span>
      </Tooltip>
    </div>
  </div>
</template>
