<script setup lang="ts">
// =============================================================================
// PreviewView.vue — テンプレートのプレビュー画面(確定保存と PDF 出力を内包)
// =============================================================================
// 上部バーは編集画面(`EditorTopBar`)と揃え, ズーム(+/-/%)とページ送り(◁ x/y ▷)を集約する。
// 実際のズーム/ページ送りは `PreviewPanel`(vivliostyle)へ ref 経由で委譲し, 状態は
// `state` イベントで受け取って表示する。
import { isErr, isOk, type SampleData, type Template } from '@editor/shared';
import { AlertCircle, Crop, FileDown, Loader2, Minus, Plus, Send } from '@lucide/vue';
import { computed, onMounted, reactive, ref } from 'vue';
import { useRoute } from 'vue-router';
import { useReviewRepo } from '@/api/repositories';
import AttributeBar from '@/components/AttributeBar.vue';
import PageNav from '@/components/PageNav.vue';
import PageRail from '@/components/PageRail.vue';
import BackButton from '@/components/ui/BackButton.vue';
import Button from '@/components/ui/Button.vue';
import { confirm } from '@/components/ui/confirm';
import { toastSuccess } from '@/components/ui/toast';
import { withCropMarks } from '@/lib/cropMarks';
import { useAsyncResult } from '@/lib/useAsyncResult';
import { useEditorSessionStore } from '@/stores/editorSession';
import PreviewPanel from './PreviewPanel.vue';
import { useTemplatePreviewService } from './services/templatePreviewService';

const props = defineProps<{ id: string }>();

const preview = useTemplatePreviewService();
const reviews = useReviewRepo();
const route = useRoute();
const sessionStore = useEditorSessionStore();
const template = ref<Template | null>(null);
const sample = ref<SampleData>({});
const restoredHtml = ref('');
const css = ref('');
const previewDoc = ref('');
const renderError = ref<string | null>(null);
// トンボ(トリムマーク)の ON/OFF。画面内トグルのみで保持し, 初期は ON。表示用の `displayDoc`
// と PDF 出力(`exportPdf`)の双方へ効かせる。ベースの `previewDoc`(トンボ無し)は保持し,
// 申請の記入済みインスタンス(`filledHtml`)には一時設定を混入させない。
const cropMarks = ref(true);
// プレビュー表示用ドキュメント。`previewDoc`(ベース)へトンボ CSS を後段注入する。トグル変更で
// `PreviewPanel`(`watch(() => props.html, render)`)が再描画し即反映される。
const displayDoc = computed(() =>
  previewDoc.value ? withCropMarks(previewDoc.value, cropMarks.value) : '',
);
// 初期ロード失敗(API・Worker いずれも含む)を画面に出すためのフラグ。トースト一回だけだと
// 見逃して「無音の白紙」になるため、本文領域に常設のエラー表示を出す。
const loadFailed = ref(false);
const { loading: loadingPreview, run: runLoad } = useAsyncResult();
const { loading: submitting, run: runSubmit } = useAsyncResult();
const { loading: exporting, run: runExport } = useAsyncResult();

// PreviewPanel から受け取るページ送り/ズーム状態(上部バーの表示と活性制御に使う)。
const panel = ref<InstanceType<typeof PreviewPanel> | null>(null);
const nav = reactive({
  currentPage: 1,
  pageCount: 0,
  atFirst: true,
  atLast: false,
  zoom: 1,
  vivlioReady: false,
});
function onState(s: typeof nav) {
  Object.assign(nav, s);
}

const fundCode = computed(() => template.value?.meta.attributes.fundCode ?? '');

onMounted(async () => {
  const res = await runLoad(() => preview.loadForPreview(props.id));
  if (isErr(res)) {
    // runLoad が cause をログ + トースト済み。加えて本文に常設エラーを出して無音化を防ぐ。
    loadFailed.value = true;
    return;
  }
  const v = res.value;
  template.value = v.template;
  sample.value = v.sample;
  restoredHtml.value = v.restoredHtml;
  css.value = v.css;
  previewDoc.value = v.previewDoc;
  renderError.value = v.renderError;
});

// 編集タブ(query なし) / 作成タブ(`?created=1`)の区別。申請に保持し 2 系統を保つ。
const origin = computed<'edit' | 'create'>(() =>
  route.query.created === '1' ? 'create' : 'edit',
);

// 実ファイルへは即時反映せず、精査者(承認者)の承認を経て反映する申請を出す。
async function submitForReview() {
  if (!template.value) return;
  const proceed = await confirm({
    title: '確定保存を申請しますか？',
    description:
      '編集内容を精査者(承認者)へ申請します。承認後に本番テンプレートへ反映されます。' +
      'この時点では実ファイルは変更されません。',
    confirmLabel: '申請する',
  });
  if (!proceed) return;
  const submitted = await runSubmit(() =>
    reviews.submitReview({
      templateId: props.id,
      html: restoredHtml.value,
      css: css.value,
      fundCode: fundCode.value,
      // レンダリング済みドキュメントを、申請の記入済みレポートインスタンスとして保持する。
      filledHtml: previewDoc.value,
      origin: origin.value,
    }),
  );
  if (isOk(submitted)) {
    // 申請済みの編集は持ち越さない: 編集セッション(履歴 + Undo/Redo)を破棄する。
    sessionStore.clear(props.id);
    toastSuccess('確定保存を申請しました（精査者の承認待ちです）');
  }
}

async function exportPdf() {
  const res = await runExport(() =>
    preview.renderPdf(restoredHtml.value, css.value, sample.value, cropMarks.value),
  );
  if (isErr(res)) return;
  const url = URL.createObjectURL(res.value);
  const a = document.createElement('a');
  a.href = url;
  a.download = `${props.id}.pdf`;
  // DOM に載せてから click する(未接続 anchor の click を無視するブラウザ対策)。
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
  void preview.recordPdfExport(props.id);
  // ブラウザがダウンロードをブロックしたかは Web API から検知できないため、
  // 「出力しました」と断定せず開始の通知に留める。
  toastSuccess('PDFのダウンロードを開始しました');
}
</script>

<template>
  <div class="flex h-screen flex-col bg-background">
    <header
      class="z-30 flex min-h-[58px] shrink-0 flex-wrap items-center gap-x-3.5 gap-y-2 border-b bg-card px-4 py-1.5 shadow-sm print:hidden"
    >
      <BackButton :fallback="{ name: 'editor', params: { id } }" aria-label="エディターに戻る" />
      <div class="h-[26px] w-px shrink-0 bg-border" />
      <AttributeBar v-if="template" :attributes="template.meta.attributes" class="flex-1" />
      <span v-else class="flex-1" />

      <!-- zoom -->
      <div class="flex shrink-0 items-center gap-1.5">
        <Button
          variant="outline"
          size="icon"
          class="h-7 w-7"
          title="縮小"
          :disabled="!nav.vivlioReady"
          @click="panel?.zoomOut()"
        >
          <Minus class="h-4 w-4" />
        </Button>
        <button
          type="button"
          class="w-[42px] text-center text-[12.5px] tabular-nums text-muted-foreground disabled:opacity-100"
          title="画面に合わせる"
          :disabled="!nav.vivlioReady"
          @click="panel?.fit()"
        >
          {{ Math.round(nav.zoom * 100) }}%
        </button>
        <Button
          variant="outline"
          size="icon"
          class="h-7 w-7"
          title="拡大"
          :disabled="!nav.vivlioReady"
          @click="panel?.zoomIn()"
        >
          <Plus class="h-4 w-4" />
        </Button>
      </div>
      <div class="h-[26px] w-px shrink-0 bg-border" />

      <!-- ページ送り(複数ページかつ vivliostyle 描画時のみ)。番号入力で任意ページへジャンプ
           できる共通 `PageNav`(400 ページ規模対応)。実移動は `PreviewPanel.goToPage` へ委譲。 -->
      <template v-if="nav.vivlioReady && nav.pageCount > 1">
        <PageNav
          variant="outline"
          dense
          :current-page="nav.currentPage"
          :page-count="nav.pageCount"
          @go="panel?.goToPage($event)"
        />
        <div class="h-[26px] w-px shrink-0 bg-border" />
      </template>

      <!-- トンボ(トリムマーク)ON/OFF。ON は塗り(default), OFF は輪郭(outline)で状態を示す。
           表示(`displayDoc`)と PDF 出力(`exportPdf`)の双方へ効く。 -->
      <Button
        :variant="cropMarks ? 'default' : 'outline'"
        size="sm"
        :aria-pressed="cropMarks"
        title="トンボ(トリムマーク)の表示切替"
        @click="cropMarks = !cropMarks"
      >
        <Crop class="h-4 w-4" /> トンボ
      </Button>
      <Button variant="outline" size="sm" :disabled="exporting" @click="exportPdf">
        <Loader2 v-if="exporting" class="h-4 w-4 animate-spin" />
        <FileDown v-else class="h-4 w-4" /> PDF出力
      </Button>
      <Button size="sm" :disabled="submitting" @click="submitForReview">
        <Loader2 v-if="submitting" class="h-4 w-4 animate-spin" />
        <Send v-else class="h-4 w-4" /> 確定保存を申請
      </Button>
    </header>

    <div v-if="renderError" class="border-b bg-destructive/10 px-4 py-2 text-sm text-destructive">
      {{ renderError }}
    </div>

    <div class="relative flex-1 overflow-hidden">
      <PreviewPanel ref="panel" :html="displayDoc" @state="onState" />
      <!-- 右端の縦ページ目盛り(スクラバ)。vivliostyle は離散表示なのでスクロール比率は渡さず、
           クリック/ドラッグで `goToPage`(EPAGE ジャンプ)する。 -->
      <PageRail
        v-if="nav.vivlioReady && nav.pageCount > 1"
        :current-page="nav.currentPage"
        :page-count="nav.pageCount"
        @go="panel?.goToPage($event)"
      />

      <!-- 初期ロード中の表示。Worker ハング等で `previewDoc` が空のまま `PreviewPanel` が早期
           return しても、ここで状態が見える(無音の白紙にしない)。 -->
      <div
        v-if="loadingPreview"
        class="absolute inset-0 z-10 flex items-center justify-center gap-2 bg-background/70 text-sm text-muted-foreground"
      >
        <Loader2 class="h-4 w-4 animate-spin" /> プレビューを読み込み中…
      </div>
      <!-- ロード失敗(API/Worker)を本文に常設表示。トースト見逃し時の原因不明な白紙を防ぐ。 -->
      <div
        v-else-if="loadFailed"
        class="absolute inset-0 z-10 flex flex-col items-center justify-center gap-2 bg-background/80 px-6 text-center text-sm text-destructive"
      >
        <AlertCircle class="h-5 w-5" />
        <p>プレビューの読み込みに失敗しました。時間をおいて再度お試しください。</p>
      </div>
      <!-- 異常系: ロードは成功したが本文が空(かつレンダリングエラーも無い)。本来起きないが、
           起きたときに白紙の理由が分かるよう診断メッセージを出す。 -->
      <div
        v-else-if="!previewDoc && !renderError"
        class="absolute inset-0 z-10 flex flex-col items-center justify-center gap-2 bg-background/80 px-6 text-center text-sm text-muted-foreground"
      >
        <AlertCircle class="h-5 w-5" />
        <p>表示できるプレビュー内容がありません。テンプレートの内容をご確認ください。</p>
      </div>
    </div>
  </div>
</template>
