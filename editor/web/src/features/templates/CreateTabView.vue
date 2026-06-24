<script setup lang="ts">
// =============================================================================
// CreateTabView.vue — テンプレ作成タブ (Step1 ファンド指定 → Step2 作成方法選択)
// =============================================================================
import { type DropdownQuery, type GenerateRequest, isErr, type TemplateMeta } from '@editor/shared';
import { FilePlus2, FileText } from '@lucide/vue';
import { computed, reactive, ref, watch } from 'vue';
import { useRouter } from 'vue-router';
import Checkbox from '@/components/ui/Checkbox.vue';
import Step from '@/components/ui/Step.vue';
import { toastError, toastSuccess } from '@/components/ui/toast';
import { useAsyncResult } from '@/lib/useAsyncResult';
import { cn } from '@/lib/utils';
import SearchFilters from './components/SearchFilters.vue';
import TemplateTable from './components/TemplateTable.vue';
import { SELECT_ALL_MSG, useTemplateCreationService } from './services/templateCreationService';

type Method = 'blank' | 'series';

const router = useRouter();
const templates = useTemplateCreationService();
const { loading: creating, run } = useAsyncResult();
const liveQuery = reactive<DropdownQuery>({});
const method = ref<Method | null>(null);
const seriesRows = ref<TemplateMeta[]>([]);
// 属性解決でシリーズファンドと判定できたときだけ「シリーズから作成」を出す (⑥)。
const isSeriesFund = ref(false);
// 償還ファンドとして作成するか (⑦・モック)。
const isRedemption = ref(false);

const canCreate = computed(
  () => !!liveQuery.companyCode && !!liveQuery.fundCode && !!liveQuery.editionType,
);

const methodCards: { key: Method; icon: typeof FilePlus2; title: string; desc: string }[] = [
  { key: 'blank', icon: FilePlus2, title: '白紙から作成', desc: '標準のレイアウトで新規に作成します。' },
  {
    key: 'series',
    icon: FileText,
    title: '既存のシリーズを元に作成',
    desc: '同じシリーズの別ファンド・版を複製して作成します。',
  },
];

// シリーズファンドでなければ「シリーズから作成」カード自体を出さない。
const visibleMethodCards = computed(() =>
  methodCards.filter((c) => c.key !== 'series' || isSeriesFund.value),
);

function onUpdate(q: DropdownQuery) {
  Object.assign(liveQuery, q);
}

// 属性が揃ったらシリーズファンドか属性解決する。属性変更で選択方法もリセット。
watch(
  () => [liveQuery.companyCode, liveQuery.fundCode, liveQuery.editionType],
  async () => {
    method.value = null;
    isSeriesFund.value = false;
    const { companyCode, fundCode, editionType } = liveQuery;
    if (!companyCode || !fundCode || !editionType) return;
    const res = await templates.resolveFund(companyCode, fundCode, editionType);
    if (!isErr(res)) isSeriesFund.value = res.value.isSeriesFund;
  },
);

function selectMethod(m: Method) {
  if (!canCreate.value || creating.value) return;
  // 白紙はカード押下で即作成→編集画面へ。シリーズは候補一覧を表示する。
  if (m === 'blank') {
    createNew();
    return;
  }
  method.value = m;
}

// series モードでは 3 フィールドが揃うと一覧をロードする。カスケードでフィールドを
// リセットすると再ロード/クリアされる。series 以外へ切り替えると一覧をクリアする。
watch(
  () => [liveQuery.companyCode, liveQuery.fundCode, liveQuery.editionType, method.value],
  () => {
    if (method.value !== 'series') {
      seriesRows.value = [];
      return;
    }
    if (canCreate.value) loadSeries();
    else seriesRows.value = [];
  },
);

async function loadSeries() {
  const { companyCode, fundCode, editionType } = liveQuery;
  if (!companyCode || !fundCode || !editionType) return;
  const res = await run(() => templates.listSeriesFunds(companyCode, fundCode, editionType));
  if (isErr(res)) return;
  seriesRows.value = res.value;
}

async function create(req: GenerateRequest, successMsg: string) {
  const res = await run(() => templates.create(req));
  if (isErr(res)) return;
  toastSuccess(successMsg);
  router.push({ name: 'editor', params: { id: res.value.id } });
}

function createNew() {
  const { companyCode, fundCode, editionType } = liveQuery;
  if (!companyCode || !fundCode || !editionType) {
    toastError(SELECT_ALL_MSG);
    return;
  }
  create(
    { companyCode, fundCode, editionType, isRedemption: isRedemption.value },
    'テンプレートを作成しました',
  );
}

function createFromSeries(m: TemplateMeta) {
  // 「基にする」だけが候補テンプレ。作成されるのは Step1 で選んだファンド。
  const { companyCode, fundCode, editionType } = liveQuery;
  if (!companyCode || !fundCode || !editionType) {
    toastError(SELECT_ALL_MSG);
    return;
  }
  create(
    { companyCode, fundCode, editionType, basedOnTemplateId: m.id, isRedemption: isRedemption.value },
    'シリーズを基にテンプレートを作成しました',
  );
}
</script>

<template>
  <div class="grid gap-4">
    <div>
      <h2 class="text-lg font-bold">テンプレート作成</h2>
      <p class="mt-1 text-[13px] text-muted-foreground">
        2つのステップで新しいテンプレートを作成します。
      </p>
    </div>

    <div class="rounded-[14px] border bg-card px-6 pb-1 pt-6 shadow-sm">
      <!-- Step 1 — 作成するファンドを指定 -->
      <Step
        :n="1"
        title="作成するファンドを指定"
        hint="委託会社・ファンド・版種を選択してください。"
        :active="!canCreate"
        :done="canCreate"
      >
        <SearchFilters
          :fields="['companyCode', 'fundCode', 'editionType']"
          :required-fields="['companyCode', 'fundCode', 'editionType']"
          hide-search
          bare
          @update="onUpdate"
          @restore="onUpdate"
        />
      </Step>

      <!-- Step 2 — 作成方法を選び、実行する -->
      <Step
        :n="2"
        title="作成方法を選ぶ"
        :hint="canCreate ? '白紙を選ぶと編集画面が開きます。シリーズは候補から選びます。' : 'ステップ1を完了すると選択できます。'"
        :active="canCreate"
        :connector="false"
      >
        <label
          v-if="canCreate"
          class="mb-3 flex w-fit cursor-pointer items-center gap-2 text-[13px] text-foreground"
        >
          <Checkbox v-model="isRedemption" />
          償還ファンドとして作成する（特定パーツを償還用に置換）
        </label>

        <div :class="cn('flex flex-wrap gap-3', !canCreate && 'pointer-events-none')">
          <button
            v-for="c in visibleMethodCards"
            :key="c.key"
            type="button"
            class="ring-focus flex flex-[1_1_220px] items-start gap-3 rounded-[11px] border-[1.5px] px-[15px] py-3.5 text-left transition-all duration-150"
            :class="
              method === c.key
                ? 'border-primary bg-primary-soft ring-[3px] ring-primary/15'
                : 'border-border bg-card'
            "
            :disabled="!canCreate"
            @click="selectMethod(c.key)"
          >
            <span
              class="mt-px grid h-[17px] w-[17px] shrink-0 place-items-center rounded-full border-[1.5px]"
              :class="method === c.key ? 'border-primary' : 'border-input'"
            >
              <span v-if="method === c.key" class="h-[9px] w-[9px] rounded-full bg-primary" />
            </span>
            <span class="min-w-0 flex-1">
              <span class="flex items-center gap-1.5 text-[13.5px] font-bold text-foreground">
                <component :is="c.icon" class="h-[15px] w-[15px] text-primary" /> {{ c.title }}
              </span>
              <span class="mt-1 block text-xs leading-relaxed text-muted-foreground">{{ c.desc }}</span>
            </span>
          </button>
        </div>

        <!-- 文脈依存の action — series のみ。blank はカード押下で即遷移する -->
        <div v-if="method === 'series'" class="mt-4 grid gap-2.5">
          <p class="text-[12.5px] text-muted-foreground">
            元にするファンドの「作成」を押すと、それを基にした編集画面に進みます。
          </p>
          <div
            v-if="seriesRows.length === 0"
            class="rounded-[11px] border border-dashed bg-muted/50 px-4 py-5 text-center text-[13px] text-muted-foreground"
          >
            該当するシリーズファンドが見つかりませんでした。
          </div>
          <TemplateTable v-else :rows="seriesRows" action="create" @action="createFromSeries" />
        </div>
      </Step>
    </div>
  </div>
</template>
