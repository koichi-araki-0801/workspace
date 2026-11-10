<script setup lang="ts">
// =============================================================================
// NewBaseDateDialog.vue — 編集タブ「新しい基準日で開く」(値入り HTML を作って編集画面へ)
// =============================================================================
// テンプレート(`会社 ファンド 版種`)と基準日を選ぶと、`fillTemplate` が値入り HTML を作る。
// 作成を待ってから編集経路(`created` なし)で開く。失敗時は画面を開かず、理由を出して再試行できる。
import {
  GENERATE_QUEUE_FULL,
  isErr,
  REPORT_COMPANY_UNKNOWN,
  REPORT_TIMEOUT,
  type SkeletonAttributes,
  templateFileName,
  templateIdFromFileName,
} from '@editor/shared';
import { computed, ref, watch } from 'vue';
import { useRouter } from 'vue-router';
import { useTemplateRepo } from '@/api/repositories';
import { buttonVariants } from '@/components/ui/Button.vue';
import { Dialog } from '@/components/ui/overlays';
import { editorRoute } from '../editorRoute';

const open = defineModel<boolean>('open', { default: false });

const repo = useTemplateRepo();
const router = useRouter();
const skeletons = ref<SkeletonAttributes[]>([]);
const selected = ref('');
const date = ref('');
const filling = ref(false);
const failure = ref<string | null>(null);
// 失敗の種別。一覧の取得失敗は一覧を取り直し、作成の失敗は作成をやり直す。
const failureKind = ref<'list' | 'fill'>('fill');

/** 失敗の `code` ごとの利用者向け文言。ここに無い `code` は server の `message` をそのまま出す。 */
const FAILURE_TEXT: Record<string, string> = {
  [GENERATE_QUEUE_FULL]: '作成処理が混み合っています。しばらくしてから再試行してください',
  [REPORT_TIMEOUT]: '時間内に作成が終わりませんでした',
  [REPORT_COMPANY_UNKNOWN]: '委託会社コードが見つかりません',
};

// 一覧の取得失敗のときは、選択が空でも「再試行」で取り直せる。
const primaryEnabled = computed(
  () => !filling.value && (canOpen.value || (failure.value !== null && failureKind.value === 'list')),
);
const canOpen = computed(() => selected.value !== '' && date.value !== '' && !filling.value);

function label(s: SkeletonAttributes): string {
  return `${s.companyCode} ${s.fundCode} ${s.editionType}`;
}

async function loadSkeletons() {
  failure.value = null;
  const res = await repo.listReportSkeletons();
  skeletons.value = isErr(res) ? [] : res.value;
  if (isErr(res)) {
    failureKind.value = 'list';
    failure.value = res.error.message;
  }
}

// 開き直すたびに入力を初期化する。一覧が変わると添字が別のテンプレートを指すため。
watch(
  open,
  (isOpen) => {
    if (!isOpen) {
      return;
    }
    selected.value = '';
    date.value = '';
    void loadSkeletons();
  },
  { immediate: true },
);

// 作成中に閉じると処理だけが続き、成功時に勝手に遷移する。作成中の閉じる操作は無視する。
function onUpdateOpen(value: boolean) {
  if (!value && filling.value) {
    return;
  }
  open.value = value;
}

function onPrimary() {
  if (failure.value && failureKind.value === 'list') {
    void loadSkeletons();
    return;
  }
  void submit();
}

async function submit() {
  const skeleton = skeletons.value[Number(selected.value)];
  if (!skeleton || !canOpen.value) {
    return;
  }
  // `<input type="date">` は yyyy-mm-dd、id の基準日は yyyymmdd。
  const id = templateIdFromFileName(
    templateFileName({ ...skeleton, baseDate: date.value.replaceAll('-', '') }),
  );
  filling.value = true;
  failure.value = null;
  failureKind.value = 'fill';
  try {
    const res = await repo.fillTemplate(id);
    if (isErr(res)) {
      failure.value = FAILURE_TEXT[res.error.code ?? ''] ?? res.error.message;
      return;
    }
    open.value = false;
    router.push(editorRoute(id, { created: false }));
  } finally {
    filling.value = false;
  }
}
</script>

<template>
  <Dialog :open="open" size="md" @update:open="onUpdateOpen" title="新しい基準日で開く" description="テンプレートと基準日を選ぶと、値入りの HTML を作って編集画面を開きます。">
    <div class="mt-4 space-y-3 text-sm">
      <label class="block space-y-1">
        <span class="text-xs text-muted-foreground">テンプレート</span>
        <select
          v-model="selected"
          class="h-9 w-full rounded-md border border-input bg-transparent px-3 text-sm"
          :disabled="filling"
        >
          <option value="" disabled>選択</option>
          <option v-for="(s, i) in skeletons" :key="i" :value="String(i)">{{ label(s) }}</option>
        </select>
      </label>
      <label class="block space-y-1">
        <span class="text-xs text-muted-foreground">基準日</span>
        <input
          v-model="date"
          type="date"
          class="h-9 w-full rounded-md border border-input bg-transparent px-3 text-sm"
          :disabled="filling"
        >
      </label>
      <p v-if="filling" class="text-xs text-muted-foreground" role="status">値入り HTML を作成しています</p>
      <p v-if="failure" class="text-xs text-destructive" role="alert">{{ failure }}</p>
      <div class="flex justify-end gap-2 pt-2">
        <button
          type="button"
          :class="buttonVariants({ size: 'sm' })"
          :disabled="!primaryEnabled"
          @click="onPrimary"
        >
          {{ failure && !filling ? '再試行' : '開く' }}
        </button>
      </div>
    </div>
  </Dialog>
</template>
