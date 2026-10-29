<script setup lang="ts">
// =============================================================================
// ReviewTabView.vue — 承認タブ(全申請一覧とテンプレート単位の精査詳細)
// =============================================================================
// query なしでは可視範囲内の全申請を状態別に表示し、行を選ぶと `?template=<id>` 付きの
// テンプレート詳細へ進む。詳細では対象テンプレートの申請を新しい順にアコーディオンで並べ、
// 展開した区画だけが `ReviewDetail` を持ち、その右欄の「コメント」タブ(`#comments` の slot)へ
// コメントパネルを差し込む。全件一覧ではテンプレートごとのパーツ構造・コメントを混在させず、
// 詳細へ移ってから読み込む。
// 画面の上端は 1 行の見出し(パンくず・状態の絞り込みチップ・「編集画面へ」)。申請の見出しも
// 1 行で、開閉のボタンと「申請ごと却下する…」のボタンを並べる(button を入れ子にしない)。

import {
  isErr,
  isOk,
  type ReviewRequestMeta,
  type ReviewStatus,
  type TemplateMeta,
} from '@editor/shared';
import { ChevronDown, ChevronRight, ClipboardCheck } from '@lucide/vue';
import { computed, onMounted, reactive, ref, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { useNoteRepo, useReviewRepo, useTemplateRepo } from '@/api/repositories';
import AttributeBar from '@/components/AttributeBar.vue';
import Badge from '@/components/ui/Badge.vue';
import Button from '@/components/ui/Button.vue';
import EmptyState from '@/components/ui/EmptyState.vue';
import Skeleton from '@/components/ui/Skeleton.vue';
import CommentPanel from '@/features/editor/comments/CommentPanel.vue';
import { useComments } from '@/features/editor/useComments';
import { editorRoute, opensAsCreate } from '@/features/templates/editorRoute';
import { formatDateTimeShort } from '@/lib/format';
import { useAsyncResult } from '@/lib/useAsyncResult';
import { useLatest } from '@/lib/useLatest';
import { useAuthStore } from '@/stores/auth';
import { usePendingReviewsStore } from '@/stores/pendingReviews';
import ReviewDetail from './ReviewDetail.vue';
import { resolveReviewTarget } from './resolveReviewTarget';
import { toggleExpanded } from './reviewAccordion';
import { partMapsFromHtml } from './reviewPartMaps';

const route = useRoute();
const router = useRouter();
const reviews = useReviewRepo();
const templates = useTemplateRepo();
const noteRepo = useNoteRepo();
const auth = useAuthStore();
const pending = usePendingReviewsStore();
const { loading, run } = useAsyncResult();
const latestLoad = useLatest();

/** 画面の見出し(読み上げ用)は読者のロールで分ける(精査者=承認する側 / 編集者=自分の申請を追う側)。 */
const heading = computed(() => (auth.isApprover ? '承認' : '申請状況'));

// ── 1. 対象テンプレート ──
const targetId = computed(() => resolveReviewTarget(route.query));
const isOverview = computed(() => targetId.value === null);

/**
 * コメントの宛先をどこで選んだか。`paper` は紙面・右欄(`ReviewDetail` の `select`)で、宛先のキーは
 * `ReviewDetail` の slot props(`selectedNo`・`selectedKey`)に従う — 選択が外れれば宛先も外れる。
 * キーは編集経路が確定版側の `beforePartKey`、作成経路が `partKey` で、確定版に無い追加パーツは
 * null。`list` はコメント一覧の見出しで選んだ変更の無いパーツ(`ReviewDetail` の選択に無い)。
 * 区画の値が null なら、まだ選んでいない。
 */
type CommentTarget = { from: 'paper' } | { from: 'list'; key: string };

/** `#comments` の slot props のうち、宛先を決めるのに使う分(`ReviewDetail.vue` の slot)。 */
interface CommentSlotState {
  selectedNo: number | null;
  selectedKey: string | null;
}

// 宛先(区画〈申請 id〉ごとに持つ — 2 区画を同時展開しても互いに干渉しない。「直近に操作した
// 区画」で解決すると、A で本文を打ち B の紙面を触ってから A の追加を押すと B 宛に投稿される
// 〈表示と結果がずれる〉ので、投稿先は必ず呼び出し側〈区画〉が明示する)とアコーディオンの展開状態。
const targets = reactive<Record<string, CommentTarget | null>>({});
const expanded = ref<string[]>([]);
watch(targetId, () => {
  // 同じルートで template だけが変わると画面は再マウントされない。前テンプレートの宛先・
  // 展開状態・絞り込みを持ち越さないよう、下の読み込み系 watch より先にリセットする。
  for (const k of Object.keys(targets)) delete targets[k];
  expanded.value = [];
  statusFilter.value = 'pending';
  searchText.value = '';
});

// ── 2. 申請一覧(全状態を 1 回で取り、対象テンプレートで絞る) ──
const all = ref<ReviewRequestMeta[]>([]);
const scoped = computed(() =>
  targetId.value === null ? all.value : all.value.filter((m) => m.templateId === targetId.value),
);

// 行バッジ・決着状態行・絞り込みチップの文言は「却下」系で統一する(操作ボタン・理由欄も同語。
// 「差し戻し」は使わない)。
const STATUS_META: Record<
  ReviewStatus,
  { label: string; variant: 'warning' | 'success' | 'destructive' }
> = {
  pending: { label: '承認待ち', variant: 'warning' },
  approved: { label: '承認済み', variant: 'success' },
  rejected: { label: '却下済み', variant: 'destructive' },
};
const ORIGIN_LABEL: Record<ReviewRequestMeta['origin'], string> = {
  edit: '編集',
  create: '作成',
};

const STATUS_CHIPS: ReviewStatus[] = ['pending', 'approved', 'rejected'];
const statusFilter = ref<ReviewStatus | 'all'>('pending');
/** 全申請一覧の簡易検索。テンプレートID・属性・申請者・処理者・申請元を部分一致で探す。 */
const searchText = ref('');

const normalizedSearchText = computed(() => searchText.value.trim().toLowerCase());

const searchedScope = computed(() => {
  if (!isOverview.value || normalizedSearchText.value === '') {
    return scoped.value;
  }

  const needle = normalizedSearchText.value;

  return scoped.value.filter((meta) => {
    const originLabel = ORIGIN_LABEL[meta.origin];

    return [
      meta.templateId,
      meta.attributes.companyCode,
      meta.attributes.fundCode,
      meta.attributes.baseDate,
      meta.attributes.editionType,
      meta.submittedBy,
      meta.reviewedBy,
      originLabel,
    ].some((value) =>
      String(value ?? '')
        .toLowerCase()
        .includes(needle),
    );
  });
});

const countOf = (status: ReviewStatus) =>
  searchedScope.value.filter((meta) => meta.status === status).length;

const items = computed(() =>
  (statusFilter.value === 'all'
    ? searchedScope.value
    : searchedScope.value.filter((meta) => meta.status === statusFilter.value)
  )
    .slice()
    .sort((a, b) => b.submittedAt.localeCompare(a.submittedAt)),
);

function toggleFilter(v: ReviewStatus) {
  statusFilter.value = statusFilter.value === v ? 'all' : v;
}

async function load() {
  const isLatest = latestLoad.begin();
  const res = await run(() => reviews.listReviews({}));
  if (!isErr(res) && isLatest()) all.value = res.value;
}
onMounted(load);
watch(targetId, load);

// ── 3. アコーディオン(既定は先頭 1 件を開く) ──
watch(
  items,
  (list) => {
    if (isOverview.value) {
      expanded.value = [];
      return;
    }

    const visible = new Set(list.map((meta) => meta.id));
    expanded.value = expanded.value.filter((id) => visible.has(id));

    if (expanded.value.length === 0 && list.length > 0) {
      expanded.value = [list[0].id];
    }
  },
  { immediate: true },
);

/** 全件一覧から申請自身のテンプレート詳細を開く。 */
function openReview(meta: ReviewRequestMeta): void {
  router.push({
    name: 'reviews',
    query: { template: meta.templateId },
  });
}
/** 対象テンプレートの詳細から、全申請の一覧へ戻る。 */
function openOverview(): void {
  router.push({ name: 'reviews' });
}

function toggle(id: string) {
  expanded.value = toggleExpanded(expanded.value, id);
}
const detailRefs = reactive<Record<string, InstanceType<typeof ReviewDetail> | undefined>>({});

/** 開閉のボタンが `aria-controls` で指す、開いた申請の中身の id。 */
function panelIdOf(id: string): string {
  return `review-panel-${id}`;
}

/** 見出しの「申請ごと却下する…」。理由欄はその申請の `ReviewDetail` が開く。 */
function openRequestReject(id: string): void {
  detailRefs[id]?.openRequestReject();
}

/** 決着した申請を一覧へ写す(チップの件数もここで動く)。承認待ちバッジも取り直す。 */
function onDecided(meta: ReviewRequestMeta) {
  all.value = all.value.map((m) => (m.id === meta.id ? meta : m));
  void pending.refresh();
}
const allDone = computed(
  () => !isOverview.value && scoped.value.length > 0 && countOf('pending') === 0,
);

// ── 4. コメント(対象テンプレートの全投稿。宛先は紙面・右欄・コメント一覧の見出しで選ぶ) ──
// 承認タブは区画(申請)ごとに宛先を持ち、投稿先は呼び出し側(区画)が明示する(`comments.add`
// の第 3 引数)。`currentKey` は「今開いている 1 つの選択」という編集タブ向けの概念で、
// 複数区画が同時展開されうる承認タブには対応しないため常に `null` を返す。
const comments = useComments(
  () => targetId.value ?? '',
  () => null,
  noteRepo,
);
watch(targetId, () => void comments.reload(), { immediate: true });

/** パーツの表示ラベルとページ index。確定版の本文から `reviewPartMaps.ts` の規則で作る。 */
const partLabels = ref<Map<string, string>>(new Map());
const partPages = ref<Map<string, number>>(new Map());
/** `getTemplate` の応答有無に関わらず読み込みが確定したか。取得失敗でも true にする
 * (下の `partsUnavailable` が「確定版がまだ無い」文言を出すのに、成功/失敗を区別せず
 * 「読み込みが終わったのに空」であることだけを使うため)。`targetId` が変わるたびに
 * `loadParts` の先頭で false へ戻す。 */
const partsLoaded = ref(false);
/** 対象テンプレートのメタ。「編集画面へ」を編集経路と作成経路のどちらで開くかに使う。 */
const targetMeta = ref<TemplateMeta | null>(null);
const latestLoadParts = useLatest();
async function loadParts() {
  const isLatest = latestLoadParts.begin();
  partLabels.value = new Map();
  partPages.value = new Map();
  partsLoaded.value = false;
  targetMeta.value = null;
  const id = targetId.value;
  if (!id) return;
  const tpl = await templates.getTemplate(id);
  if (!isLatest()) return;
  partsLoaded.value = true;
  if (!isOk(tpl)) return;
  targetMeta.value = tpl.value.meta;
  // `filled`(per-fund 実値埋め込み済み本文)は rest でも値を返す。パーツ構造しか要らないので
  // 値の有無を区別する `??` でなく、空文字も拾う `||` で `html` へ落とす。
  const maps = partMapsFromHtml(tpl.value.filled || tpl.value.html);
  partLabels.value = maps.labels;
  partPages.value = maps.pages;
}
watch(targetId, loadParts, { immediate: true });

/** 確定版の構造が引けない(取得失敗、または構造はあってもパーツ 0 件)。読み込み中
 * (`!partsLoaded`)はここに含めない — 正常なテンプレでも読み込み中は一瞬 `partLabels.size
 * === 0` になり、含めると文言が一瞬だけ出てしまう。`m.origin`(区画=申請ごとの由来)は
 * 見ない — `partLabels` はテンプレ単位の状態で申請単位ではない。宛先は確定版の構造から
 * 作るため、申請側にだけ在る追加パーツ(新規追加ブロック等)にも宛てられない。 */
const partsUnavailable = computed(() => partsLoaded.value && partLabels.value.size === 0);

const PARTS_UNAVAILABLE_TEXT =
  'このテンプレートの確定版がまだ無いため、パーツ宛のコメントは付けられません';
const ADDED_PART_TEXT = '追加したパーツは確定版にまだ無いため、コメントを書けません。';
const PARTS_LOADING_TEXT = '確定版のパーツを読み込んでいます…';

/** 紙面・右欄で選んだ(`ReviewDetail` の `select`)。宛先のキーは slot props から引く。 */
function onSelect(reqId: string): void {
  targets[reqId] = { from: 'paper' };
}

/** 区画で選んだ宛先。`undefined` はまだ選んでいない(紙面の選択が外れたときも含む)。 */
function chosenOf(reqId: string, slot: CommentSlotState): { key: string | null } | undefined {
  const t = targets[reqId];
  if (!t) return undefined;
  if (t.from === 'list') return { key: t.key };
  return slot.selectedNo === null ? undefined : { key: slot.selectedKey };
}

/**
 * 区画のコメントの宛先のキー。宛先は確定版の構造(`partLabels`)にあるキーだけ(計画で決めた
 * こと 13)。編集経路の追加パーツ(`key` が null)と、作成経路で確定版に無い `partKey` は書けない。
 * 構造の読み込み中は確かめられないので書かせない。
 */
function addKeyOf(reqId: string, slot: CommentSlotState): string | null {
  const key = chosenOf(reqId, slot)?.key ?? null;
  return key !== null && partLabels.value.has(key) ? key : null;
}

/**
 * 入力欄の代わりに出す文。宛先を選ぶ前は出さない(入力欄は畳んで案内を出す)。選んだのに構造を
 * 読み込み中なら、その旨を出す(「パーツを押すと…」の案内を出すと、押したのに効かないように見える)。
 */
function addBlockedTextOf(reqId: string, slot: CommentSlotState): string | undefined {
  if (partsUnavailable.value) return PARTS_UNAVAILABLE_TEXT;
  if (!chosenOf(reqId, slot)) return undefined;
  if (!partsLoaded.value) return PARTS_LOADING_TEXT;
  return addKeyOf(reqId, slot) === null ? ADDED_PART_TEXT : undefined;
}

/**
 * コメント一覧の見出しから選ぶ。変更のあるパーツ(`partNumbers` にある)は `ReviewDetail` に選ばせ
 * (紙面と右欄が動き、`select` で宛先が返る)、変更の無いパーツは宛先にしてページだけ送る。
 * 削除済みパーツ(確定版の構造に無いキー)は無視する(宛先にさせない)。
 */
function focusPart(reqId: string, key: string, partNumbers: ReadonlyMap<string, number>) {
  if (!partLabels.value.has(key)) return;
  const detail = detailRefs[reqId];
  if (partNumbers.has(key)) {
    // 選ばせると `select` が返り、宛先は紙面の選択に従う。
    detail?.selectPart(key);
    return;
  }
  targets[reqId] = { from: 'list', key };
  const page = partPages.value.get(key);
  if (page !== undefined) detail?.gotoPage(page);
}

function goEdit() {
  // メタ未取得(`loadParts` の応答前・取得失敗)でも申請の `origin` を第 2 の根拠にする。
  // 見るのは承認待ちだけ — 決着済みの作成申請は「承認で値入り HTML になった」か「却下で
  // 何も無い」かのどちらかで、いま作成経路で開く根拠にならない(取得失敗はテンプレートが
  // 直るまで続くので、決着済みまで見ると誤判定が固定化する)。
  // 根拠がどちらも無いときだけ編集経路へ落とす — pending だけのテンプレートを編集経路で
  // 開くと、値入り HTML が無いまま申請へ進んで server に拒否される。
  const created = targetMeta.value
    ? opensAsCreate(targetMeta.value)
    : scoped.value.some((meta) => meta.origin === 'create' && meta.status === 'pending');

  if (targetId.value) router.push(editorRoute(targetId.value, { created }));
  else router.push({ name: 'edit' });
}
</script>

<template>
  <div class="space-y-4">
    <h2 class="sr-only">{{ heading }}</h2>

    <!-- 1 行の見出し: パンくず・状態の絞り込みチップ・編集画面へ -->
    <div class="flex flex-wrap items-center gap-x-3.5 gap-y-2" data-review-head>
      <nav class="flex min-w-0 items-center gap-2 text-[15px]" aria-label="現在の位置" data-review-crumb>
        <span v-if="isOverview" class="font-bold">すべての申請</span>
        <template v-else>
          <button
            type="button"
            class="shrink-0 rounded-sm text-primary hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            @click="openOverview"
          >
            すべての申請
          </button>
          <span class="shrink-0 text-muted-foreground" aria-hidden="true">›</span>
          <span class="mono min-w-0 font-bold" data-review-crumb-id data-break-anywhere aria-current="page">{{
            targetId
          }}</span>
        </template>
      </nav>
      <span class="flex-1" />
      <fieldset class="m-0 flex flex-wrap gap-1.5 border-0 p-0">
        <legend class="sr-only">状態で絞り込む</legend>
        <!-- 選択中は塗りで示す(フォーカスの輪 `ring` と紛らわしくしない)。もう一度押すと解除。 -->
        <button
          v-for="s in STATUS_CHIPS"
          :key="s"
          type="button"
          class="inline-flex items-center gap-1.5 rounded-full border px-3 py-[3px] text-xs transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1"
          :class="
            statusFilter === s
              ? 'border-foreground bg-foreground text-background'
              : 'bg-card hover:bg-muted/60'
          "
          :data-review-chip="s"
          :aria-pressed="statusFilter === s"
          @click="toggleFilter(s)"
        >
          {{ STATUS_META[s].label }} <b class="tabular-nums">{{ countOf(s) }}</b>
        </button>
      </fieldset>
      <Button v-if="!isOverview" variant="outline" size="sm" @click="goEdit"> 編集画面へ </Button>
    </div>

    <div
      v-if="isOverview"
      class="flex flex-wrap items-end gap-3 rounded-[12px] border bg-card px-4 py-3"
      data-review-search
    >
      <label class="grid min-w-[280px] flex-1 gap-1">
        <span class="text-[12px] font-medium text-muted-foreground"> 申請を検索 </span>

        <input
          v-model="searchText"
          type="search"
          class="h-9 w-full rounded-[8px] border bg-background px-3 text-sm outline-none focus:ring-2 focus:ring-ring"
          placeholder="ファンドコード、委託会社、版種、申請者など"
          aria-label="申請を検索"
        >
      </label>

      <Button variant="outline" size="sm" :disabled="searchText === ''" @click="searchText = ''">
        クリア
      </Button>
    </div>

    <Skeleton v-if="loading && scoped.length === 0" class="h-24 w-full" />
    <!-- 申請が 1 件も無い全件一覧は、どこから申請するかを案内する。 -->
    <EmptyState
      v-else-if="isOverview && scoped.length === 0"
      :icon="ClipboardCheck"
      title="編集タブでテンプレートを開いてから、承認タブを押してください"
      hint="編集画面のプレビューから「確定保存を申請」すると、申請がここに並びます。"
    >
      <Button variant="outline" @click="goEdit">編集タブへ</Button>
    </EmptyState>
    <EmptyState
      v-else-if="scoped.length === 0"
      :icon="ClipboardCheck"
      title="このテンプレートには申請がありません"
      hint="編集画面のプレビューから「確定保存を申請」すると、ここに並びます。"
    />

    <EmptyState
      v-else-if="items.length === 0"
      :icon="ClipboardCheck"
      :title="
        isOverview && normalizedSearchText !== ''
          ? '検索条件に一致する申請はありません'
          : 'この状態の申請はありません'
      "
      :hint="
        isOverview && normalizedSearchText !== ''
          ? '検索文字を変更するか、クリアしてください。'
          : '上のチップをもう一度押すと絞り込みを解除します。'
      "
    />

    <!-- アコーディオン -->
    <ul v-else class="space-y-3" data-review-list>
      <li
        v-for="m in items"
        :key="m.id"
        class="rounded-[12px] border bg-card shadow-sm"
        :data-review-item="m.id"
      >
        <!-- 申請の見出し 1 行。開閉のボタンと「申請ごと却下する…」のボタンを並べる。
             `data-review-toggle` は phrasing content のみ(button の内容モデル制約)。
             `AttributeBar` は `inline` 指定でルート・各列を `span` で描かせる。 -->
        <div class="flex items-center gap-3 px-4 py-2.5">
          <button
            type="button"
            class="relative flex min-w-0 flex-1 flex-wrap items-center gap-3 rounded-sm text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            data-review-toggle
            :aria-expanded="!isOverview && expanded.includes(m.id)"
            :aria-controls="!isOverview && expanded.includes(m.id) ? panelIdOf(m.id) : undefined"
            @click="isOverview ? openReview(m) : toggle(m.id)"
          >
            <!-- 読み上げ用の文字(`sr-only`)は absolute なので、ボタンを relative にして包む(包まないと
                 一覧の下端の外に置かれ、文書全体が縦に伸びうる) -->
            <span class="sr-only">
              {{ isOverview ? '申請の詳細を開く' : '申請内容を開閉する' }}
            </span>

            <ChevronDown v-if="!isOverview && expanded.includes(m.id)" class="h-4 w-4 shrink-0" />

            <ChevronRight v-else class="h-4 w-4 shrink-0" />
            <Badge :variant="STATUS_META[m.status].variant">{{ STATUS_META[m.status].label }}</Badge>
            <Badge variant="secondary">{{ ORIGIN_LABEL[m.origin] }}</Badge>
            <!-- 属性は枠と地を外して見出しの行に溶かす(モックの `.attrs`)。 -->
            <AttributeBar
              inline
              :attributes="m.attributes"
              class="min-w-0 flex-1 border-0! bg-transparent! px-0! py-0!"
            />
            <span class="text-xs text-muted-foreground">
              申請: {{ m.submittedBy }}・{{ formatDateTimeShort(m.submittedAt) }}
            </span>
            <!-- 申請者の申告件数は閉じているときだけ。開いたら実際の差分(右欄)を見る。 -->
            <span
              v-if="m.changedSummary && !(!isOverview && expanded.includes(m.id))"
              class="basis-full text-xs text-muted-foreground"
            >
              変更 {{ m.changedSummary.count }} か所<template v-if="m.changedSummary.names.length">
                （{{ m.changedSummary.names.join('、') }}）</template
              >（申請者の申告。実際の差分は開いて確認します）
            </span>
            <span v-if="m.reviewedBy" class="basis-full text-xs text-muted-foreground">
              {{ m.status === 'approved' ? '承認' : '却下' }}: {{ m.reviewedBy }}・{{
                formatDateTimeShort(m.reviewedAt)
              }}
              <template v-if="m.status === 'rejected' && m.comment">・理由: {{ m.comment }}</template>
            </span>
          </button>
          <!-- 申請ごと却下は例外の操作なので、最終確定から離して見出しの右端に控えめに置く。
               出すかどうかは一覧の行(`m.status`。読んだ時点の状態)でなく、開いた申請が今
               判定できるか(`ReviewDetail` の `canDecide`)で決める。 -->
          <button
            v-if="!isOverview && expanded.includes(m.id) && detailRefs[m.id]?.canDecide === true"
            type="button"
            class="shrink-0 rounded-sm px-1 py-0.5 text-xs text-destructive underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            data-review-reject-link
            @click="openRequestReject(m.id)"
          >
            申請ごと却下する…
          </button>
        </div>

        <div
          v-if="!isOverview && expanded.includes(m.id)"
          :id="panelIdOf(m.id)"
          class="border-t p-4"
        >
          <ReviewDetail
            :ref="
              (el) => {
                detailRefs[m.id] = el as InstanceType<typeof ReviewDetail> | undefined;
              }
            "
            :req-id="m.id"
            @decided="onDecided"
            @select="onSelect(m.id)"
          >
            <template #comments="slot">
              <CommentPanel
                :entries="comments.all.value"
                :selected-key="addKeyOf(m.id, slot)"
                :can-add="addKeyOf(m.id, slot) !== null"
                :part-labels="partLabels"
                :part-numbers="slot.partNumbers"
                :part-names="slot.partNames"
                :add-blocked-text="addBlockedTextOf(m.id, slot)"
                collapse-input-until-target
                compact
                @add="(content) => comments.add(content, addKeyOf(m.id, slot) ?? undefined)"
                @reply="comments.reply"
                @set-status="comments.setStatus"
                @update="comments.update"
                @remove="comments.remove"
                @focus="(key) => focusPart(m.id, key, slot.partNumbers)"
              />
            </template>
          </ReviewDetail>
        </div>
      </li>
    </ul>

    <div
      v-if="allDone"
      class="flex items-center gap-3 rounded-[12px] border bg-muted/30 px-4 py-3 text-sm"
    >
      このテンプレートの承認待ちはすべて決着しました。
      <Button size="sm" @click="router.push({ name: 'edit' })">編集タブへ戻る</Button>
    </div>
  </div>
</template>
