<script setup lang="ts">
// =============================================================================
// CreateTabView.vue — テンプレ作成タブ (Step1 ファンド指定 → Step2 作成方法選択)
// =============================================================================
import { type CreatableInfo, type GenerateRequest, isErr } from '@editor/shared';
import { FilePlus2, FileText, FolderOpen } from '@lucide/vue';
import { computed, reactive, ref, watch } from 'vue';
import { useRouter } from 'vue-router';
import Button from '@/components/ui/Button.vue';
import Checkbox from '@/components/ui/Checkbox.vue';
import { confirm } from '@/components/ui/confirm';
import Step from '@/components/ui/Step.vue';
import { toastError, toastSuccess } from '@/components/ui/toast';
import { useAsyncResult } from '@/lib/useAsyncResult';
import { useLatest } from '@/lib/useLatest';
import { cn } from '@/lib/utils';
import CreateFundSelect, { type CreateFundSelection } from './components/CreateFundSelect.vue';
import SeriesSourceTable from './components/SeriesSourceTable.vue';
import { editorRoute } from './editorRoute';
import { SELECT_ALL_MSG, useTemplateCreationService } from './services/templateCreationService';

type Method = 'blank' | 'series';

const router = useRouter();
const templates = useTemplateCreationService();
const { loading: creating, run } = useAsyncResult();
const liveQuery = reactive<CreateFundSelection>({});
const method = ref<Method | null>(null);
// 3 つがそろったときの作成可否(作成済みか・シリーズのコピー元候補)。
const info = ref<CreatableInfo | null>(null);
// シリーズのコピー元候補があるときだけ「シリーズから作成」を出す。
const isSeriesFund = computed(() => (info.value?.seriesFunds.length ?? 0) > 0);
// 作成済み(templates/ にある)なら作成せず、既存のテンプレートを開かせる(作成しても 409 になる)。
const alreadyCreated = computed(() => info.value?.created === true);
// 償還ファンドとして作成するか(生成器へのパラメータ)。
const isRedemption = ref(false);
// 属性を素早く変えると前の属性の応答が後から届く。反映は最新の要求分だけに絞る。
const latestResolve = useLatest();

// Rep1 の会社コードがそろわない(候補に無い会社)ときは、作成済みもシリーズも分からないので押させない。
const canCreate = computed(
  () =>
    !!liveQuery.companyCode &&
    !!liveQuery.rep1CompanyCode &&
    !!liveQuery.fundCode &&
    !!liveQuery.editionType,
);

const methodCards: { key: Method; icon: typeof FilePlus2; title: string; desc: string }[] = [
  {
    key: 'blank',
    icon: FilePlus2,
    title: '属性から新規作成',
    desc: '指定した属性（委託会社・ファンド・版種）をもとに標準レイアウトで作成します。',
  },
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

function onUpdate(q: CreateFundSelection) {
  Object.assign(liveQuery, q);
}

// 属性がそろったら作成可否を問い合わせる。属性変更で選択方法もリセット。
watch(
  () => [liveQuery.companyCode, liveQuery.rep1CompanyCode, liveQuery.fundCode, liveQuery.editionType],
  async () => {
    method.value = null;
    info.value = null;
    const { companyCode, rep1CompanyCode, fundCode, editionType } = liveQuery;
    if (!companyCode || !rep1CompanyCode || !fundCode || !editionType) return;
    const isLatest = latestResolve.begin();
    const res = await templates.getCreatableInfo({ companyCode, rep1CompanyCode, fundCode, editionType });
    if (!isLatest()) return; // 属性を変え直した後に届いた旧応答は捨てる
    if (isErr(res)) {
      // 取れないと「シリーズから作成」カードが黙って消えるだけになるため明示する。
      toastError(res.error.message);
      return;
    }
    info.value = res.value;
  },
);

function selectMethod(m: Method) {
  if (!canCreate.value || alreadyCreated.value || creating.value) return;
  // 属性から新規作成 (`blank`) はカード押下で即作成→編集画面へ。シリーズは候補一覧を表示する。
  if (m === 'blank') {
    void createNew();
    return;
  }
  method.value = m;
}

async function create(req: GenerateRequest, successMsg: string) {
  const res = await run(() => templates.create(req));
  if (isErr(res)) return;
  toastSuccess(successMsg);
  // 作成タブの産物は必ず作成経路で開く(`created` query の生成は `editorRoute` に集約する)。
  router.push(editorRoute(res.value.id, { created: true }));
}

/**
 * 作業中(同じ id の下書きか pending)があれば、作り直しの同意を取る。同意しなければ null(作らない)。
 * サーバは同意(`replaceExisting`)の無い作り直しを 409 で止めるので、送る前にここで聞く。
 */
async function recreateConsent(): Promise<{ replaceExisting?: true } | null> {
  if (!info.value?.inProgressId) return {};
  const ok = await confirm({
    title: '作業中の内容を捨てて作り直しますか',
    description:
      '作成中のテンプレートの下書きと生成した内容を捨てて、新しく作り直します。コメントと修正履歴は残ります。',
    confirmLabel: '作り直す',
    variant: 'destructive',
  });
  return ok ? { replaceExisting: true } : null;
}

/** 作成経路(差し込み値のハイライトあり)で開く。作成済みは申請 → 承認で templates/ を上書きする。 */
function openInCreateRoute(id: string | undefined) {
  if (id) router.push(editorRoute(id, { created: true }));
}

async function createNew() {
  const { companyCode, fundCode, editionType } = liveQuery;
  if (!companyCode || !fundCode || !editionType) {
    toastError(SELECT_ALL_MSG);
    return;
  }
  const consent = await recreateConsent();
  if (!consent) return;
  await create(
    { companyCode, fundCode, editionType, isRedemption: isRedemption.value, ...consent },
    'テンプレートを作成しました',
  );
}

async function createFromSeries(sourceFundCode: string) {
  if (creating.value || alreadyCreated.value) return; // 連打・作成済みで二重に作らせない
  // コピー元は候補のファンド。作成されるのは Step1 で選んだファンド。
  const { companyCode, fundCode, editionType } = liveQuery;
  if (!companyCode || !fundCode || !editionType) {
    toastError(SELECT_ALL_MSG);
    return;
  }
  const consent = await recreateConsent();
  if (!consent) return;
  await create(
    {
      companyCode,
      fundCode,
      editionType,
      sourceFundCode,
      isRedemption: isRedemption.value,
      ...consent,
    },
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
        <CreateFundSelect @update="onUpdate" />
      </Step>

      <!-- Step 2 — 作成方法を選び、実行する -->
      <Step
        :n="2"
        title="作成方法を選ぶ"
        :hint="canCreate ? '属性から新規作成を選ぶと編集画面が開きます。シリーズは候補から選びます。' : 'ステップ1を完了すると選択できます。'"
        :active="canCreate"
        :connector="false"
      >
        <div
          v-if="canCreate && alreadyCreated"
          class="mb-3 flex flex-wrap items-center gap-3 rounded-[11px] border border-warning/40 bg-warning/10 px-4 py-2.5 text-[12.5px] text-foreground"
        >
          <span>この会社・ファンド・版種のテンプレートは作成済みです。直すときは既存のテンプレートを開いてください。</span>
          <Button
            v-if="info?.templateId"
            variant="outline"
            size="sm"
            @click="openInCreateRoute(info?.templateId)"
          >
            <FolderOpen /> 既存のテンプレートを開く
          </Button>
        </div>
        <div
          v-else-if="canCreate && info?.inProgressId"
          class="mb-3 flex flex-wrap items-center gap-3 rounded-[11px] border border-warning/40 bg-warning/10 px-4 py-2.5 text-[12.5px] text-foreground"
        >
          <span>この会社・ファンド・版種のテンプレートは作成中です。続きは作成中のテンプレートを開いてください。作り直すと作業中の内容は捨てられます。</span>
          <Button variant="outline" size="sm" @click="openInCreateRoute(info?.inProgressId)">
            <FolderOpen /> 作成中のテンプレートを開く
          </Button>
        </div>
        <label
          v-if="canCreate"
          class="mb-3 flex w-fit cursor-pointer items-center gap-2 text-[13px] text-foreground"
        >
          <Checkbox v-model="isRedemption" />
          償還ファンドとして作成する
        </label>

        <div :class="cn('flex flex-wrap gap-3', (!canCreate || alreadyCreated) && 'pointer-events-none')">
          <Button
            v-for="c in visibleMethodCards"
            :key="c.key"
            variant="ghost"
            :class="
              cn(
                'h-auto flex-[1_1_220px] items-start justify-start gap-3 whitespace-normal rounded-[11px] border-[1.5px] px-[15px] py-3.5 text-left font-normal transition-all disabled:opacity-100 [&_svg]:size-[15px]',
                method === c.key
                  ? 'border-primary bg-primary-soft ring-[3px] ring-primary/15 hover:bg-primary-soft'
                  : 'border-border bg-card hover:bg-card',
              )
            "
            :disabled="!canCreate || alreadyCreated"
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
          </Button>
        </div>

        <!-- 文脈依存の action — series のみ。blank はカード押下で即遷移する -->
        <div v-if="method === 'series'" class="mt-4 grid gap-2.5">
          <p class="text-[12.5px] text-muted-foreground">
            元にするファンドの「作成」を押すと、そのテンプレートを基にした編集画面に進みます。コピー元のテンプレートが無いファンドは選べません。
          </p>
          <SeriesSourceTable
            :rows="info?.seriesFunds ?? []"
            :disabled="creating"
            @create="createFromSeries"
          />
        </div>
      </Step>
    </div>
  </div>
</template>
