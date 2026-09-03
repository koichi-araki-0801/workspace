<script setup lang="ts">
// =============================================================================
// ReviewVisualCompare.vue — 精査画面の主役: 修正前｜修正後の左右組版比較
// =============================================================================
// PreviewPanel(隔離 preview-host iframe)を 2 面並べ、実際の帳票と同じ組版で前後を
// 見せる。ページ送りは左右連動、変更ブロックは黄マーカー(トグルで消して素の見た目も
// 確認できる — 完全性要件)。新規作成申請(isCreate)は前面が存在しないため単面表示。
// 文書の組み立て(マーカー・アンカー)は `reviewCompareDocs.ts` に委譲する。
import { ChevronLeft, ChevronRight, MapPin } from '@lucide/vue';
import { computed, ref } from 'vue';
import Button from '@/components/ui/Button.vue';
import Checkbox from '@/components/ui/Checkbox.vue';
import PreviewPanel from '@/features/preview/PreviewPanel.vue';
import { buildCompareDocs } from './services/reviewCompareDocs';

const props = defineProps<{
  beforeHtml: string;
  afterHtml: string;
  cssBefore: string;
  cssAfter: string;
  /** 変更ページの index 集合(0 始まり。`buildHtmlDiff` の `diff.pages` の index 由来)。 */
  changedPageIndexes: number[];
  /**
   * diff が数えた before/after 各面の期待ページ数(`HtmlDiff.beforePageCount`/`afterPageCount`)。
   * `buildCompareDocs` が文書内の実際の `.page` 数と突き合わせ、不一致なら誤マーク防止のため
   * その面を無印へ degrade する(未取得時は undefined = 検査しない)。
   */
  beforePageCount?: number;
  afterPageCount?: number;
  isCreate: boolean;
}>();

const showMarker = ref(true);

// マーカーのレイヤ名は乱数だが、docs は入力とトグルにのみ依存する computed で組む
// (`ReviewDetail` の renderedRows と同じ規律 — 無関係な再描画で全再組版を起こさない)。
const docs = computed(() =>
  buildCompareDocs({
    beforeHtml: props.beforeHtml,
    afterHtml: props.afterHtml,
    cssBefore: props.cssBefore,
    cssAfter: props.cssAfter,
    changedPageIndexes: new Set(props.changedPageIndexes),
    beforeExpectedPageCount: props.beforePageCount,
    afterExpectedPageCount: props.afterPageCount,
    marker: showMarker.value,
  }),
);

const beforePanel = ref<InstanceType<typeof PreviewPanel>>();
const afterPanel = ref<InstanceType<typeof PreviewPanel>>();
const beforeState = ref({ currentPage: 1, pageCount: 0, atFirst: true, atLast: false });
const afterState = ref({ currentPage: 1, pageCount: 0, atFirst: true, atLast: false });

/** ページ送りは左右へ同時に送る(片面が短い場合は末尾で止まるだけ)。 */
function prev() {
  beforePanel.value?.prevPage();
  afterPanel.value?.prevPage();
}
function next() {
  beforePanel.value?.nextPage();
  afterPanel.value?.nextPage();
}

/** 「次の変更箇所へ」— アンカー巡回。移動が効かない環境ではマーカー+手動送りで代替。 */
const anchorIndex = ref(-1);
function nextAnchor() {
  const anchors = docs.value.anchors;
  if (anchors.length === 0) return;
  anchorIndex.value = (anchorIndex.value + 1) % anchors.length;
  const id = anchors[anchorIndex.value];
  beforePanel.value?.gotoAnchor(id);
  afterPanel.value?.gotoAnchor(id);
}

/**
 * 指定ページ(0 始まり)へ両面を送る。承認タブのコメント一覧が「行クリックで該当ページへ」
 * に使う。アンカーはページ単位(`buildCompareDocs` が `.page` に付ける)なので、パーツ単位の
 * 精度は持たない — ページが見えれば承認者はパーツを目で追える。コメントは変更の有無に
 * 関わらず全パーツへ付けられるため、変更ページのみの `anchors`(「次の変更箇所へ」用、
 * `anchorIndex` はその巡回カーソル)ではなく全ページの `pageAnchors` を引く。ここでの移動は
 * 「次の変更箇所へ」の巡回とは独立の操作なので `anchorIndex` は触らない。
 */
function gotoPage(index: number): void {
  const id = docs.value.pageAnchors[index];
  if (!id) return;
  beforePanel.value?.gotoAnchor(id);
  afterPanel.value?.gotoAnchor(id);
}
defineExpose({ gotoPage });
</script>

<template>
  <div class="space-y-2">
    <div class="flex flex-wrap items-center gap-2">
      <Button variant="outline" size="sm" :disabled="afterState.atFirst" @click="prev">
        <ChevronLeft class="h-4 w-4" /> 前のページ
      </Button>
      <Button variant="outline" size="sm" :disabled="afterState.atLast" @click="next">
        次のページ <ChevronRight class="h-4 w-4" />
      </Button>
      <Button
        v-if="docs.anchors.length > 0"
        variant="outline"
        size="sm"
        @click="nextAnchor"
      >
        <MapPin class="h-4 w-4" /> 次の変更箇所へ
      </Button>
      <span class="text-xs text-muted-foreground">
        {{ afterState.currentPage }} / {{ afterState.pageCount || '?' }} ページ（左右連動）
      </span>
      <label class="ml-auto flex cursor-pointer items-center gap-1.5">
        <Checkbox v-model="showMarker" />
        <span class="text-xs">変更箇所に印を付ける</span>
      </label>
    </div>
    <div class="grid gap-3" :class="isCreate ? '' : 'md:grid-cols-2'">
      <figure v-if="!isCreate" class="min-w-0 space-y-1">
        <figcaption class="text-xs font-medium text-muted-foreground">
          修正前（現在の本番）
        </figcaption>
        <div class="h-[70vh] overflow-hidden rounded border">
          <PreviewPanel
            ref="beforePanel"
            :html="docs.beforeDoc"
            @state="(s) => (beforeState = s)"
          />
        </div>
      </figure>
      <figure class="min-w-0 space-y-1">
        <figcaption class="text-xs font-medium text-accent-foreground">
          {{ isCreate ? '新規作成される内容' : '修正後（申請された内容）' }}
        </figcaption>
        <div class="h-[70vh] overflow-hidden rounded border">
          <PreviewPanel
            ref="afterPanel"
            :html="docs.afterDoc"
            @state="(s) => (afterState = s)"
          />
        </div>
      </figure>
    </div>
  </div>
</template>
