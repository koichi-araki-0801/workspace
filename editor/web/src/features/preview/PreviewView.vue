<script setup lang="ts">
// =============================================================================
// PreviewView.vue — テンプレートのプレビュー画面(確定保存と PDF 出力を内包)
// =============================================================================
// 上部バーは編集画面(`EditorTopBar`)と揃え, ズーム(+/-/%)とページ送り(◁ x/y ▷)を集約する。
// 実際のズーム/ページ送りは `PreviewPanel`(vivliostyle)へ ref 経由で委譲し, 状態は
// `state` イベントで受け取って表示する。
import { isErr, isOk, type SampleData, type Template } from '@editor/shared';
import { ChevronLeft, ChevronRight, FileDown, Loader2, Minus, Plus, Save } from '@lucide/vue';
import { computed, onMounted, reactive, ref } from 'vue';
import BackButton from '@/components/ui/BackButton.vue';
import Button from '@/components/ui/Button.vue';
import { confirm } from '@/components/ui/confirm';
import { toastSuccess } from '@/components/ui/toast';
import AttributeBar from '@/features/editor/AttributeBar.vue';
import { useAsyncResult } from '@/lib/useAsyncResult';
import { useEditorSessionStore } from '@/stores/editorSession';
import PreviewPanel from './PreviewPanel.vue';
import { useTemplatePreviewService } from './services/templatePreviewService';

const props = defineProps<{ id: string }>();

const preview = useTemplatePreviewService();
const sessionStore = useEditorSessionStore();
const template = ref<Template | null>(null);
const sample = ref<SampleData>({});
const restoredHtml = ref('');
const css = ref('');
const previewDoc = ref('');
const renderError = ref<string | null>(null);
const { run: runLoad } = useAsyncResult();
const { loading: saving, run: runSave } = useAsyncResult();
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
  if (isErr(res)) return;
  const v = res.value;
  template.value = v.template;
  sample.value = v.sample;
  restoredHtml.value = v.restoredHtml;
  css.value = v.css;
  previewDoc.value = v.previewDoc;
  renderError.value = v.renderError;
});

async function confirmSave() {
  if (!template.value) return;
  const proceed = await confirm({
    title: 'このテンプレートを確定保存しますか？',
    description: '編集内容が本番テンプレートに反映されます。この操作は取り消せません。',
    confirmLabel: '確定保存する',
  });
  if (!proceed) return;
  const saved = await runSave(() =>
    preview.confirmSave({
      templateId: props.id,
      html: restoredHtml.value,
      css: css.value,
      fundCode: fundCode.value,
      // レンダリング済みドキュメントを, この確定保存の記入済みレポートインスタンスとして保持する。
      filledHtml: previewDoc.value,
    }),
  );
  if (isOk(saved)) {
    // 確定済みの編集は持ち越さない: 編集セッション(履歴 + Undo/Redo)を破棄する。
    // 次回エディタ表示は新規セッションから始まり、メニュー復帰でも警告は出ない。
    sessionStore.clear(props.id);
    toastSuccess('確定保存しました');
  }
}

async function exportPdf() {
  const res = await runExport(() => preview.renderPdf(restoredHtml.value, css.value, sample.value));
  if (isErr(res)) return;
  const url = URL.createObjectURL(res.value);
  const a = document.createElement('a');
  a.href = url;
  a.download = `${props.id}.pdf`;
  a.click();
  URL.revokeObjectURL(url);
  void preview.recordPdfExport(props.id);
  toastSuccess('PDFを出力しました');
}
</script>

<template>
  <div class="flex h-screen flex-col bg-background">
    <header
      class="z-30 flex h-[58px] shrink-0 items-center gap-3.5 border-b bg-card px-4 shadow-sm print:hidden"
    >
      <BackButton :fallback="{ name: 'editor', params: { id } }" aria-label="エディターに戻る" />
      <div class="h-[26px] w-px bg-border" />
      <AttributeBar v-if="template" :attributes="template.meta.attributes" class="flex-1" />
      <span v-else class="flex-1" />

      <!-- zoom -->
      <div class="flex items-center gap-1.5">
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
      <div class="h-[26px] w-px bg-border" />

      <!-- ページ送り(複数ページかつ vivliostyle 描画時のみ) -->
      <template v-if="nav.vivlioReady && nav.pageCount > 1">
        <div class="flex items-center gap-1.5">
          <Button
            variant="outline"
            size="icon"
            class="h-7 w-7"
            title="前のページ"
            :disabled="nav.atFirst || nav.currentPage <= 1"
            @click="panel?.prevPage()"
          >
            <ChevronLeft class="h-4 w-4" />
          </Button>
          <span class="min-w-[46px] text-center text-[12.5px] tabular-nums text-muted-foreground">
            {{ nav.currentPage }} / {{ nav.pageCount }}
          </span>
          <Button
            variant="outline"
            size="icon"
            class="h-7 w-7"
            title="次のページ"
            :disabled="nav.atLast || nav.currentPage >= nav.pageCount"
            @click="panel?.nextPage()"
          >
            <ChevronRight class="h-4 w-4" />
          </Button>
        </div>
        <div class="h-[26px] w-px bg-border" />
      </template>

      <Button variant="outline" size="sm" :disabled="exporting" @click="exportPdf">
        <Loader2 v-if="exporting" class="h-4 w-4 animate-spin" />
        <FileDown v-else class="h-4 w-4" /> PDF出力
      </Button>
      <Button size="sm" :disabled="saving" @click="confirmSave">
        <Loader2 v-if="saving" class="h-4 w-4 animate-spin" />
        <Save v-else class="h-4 w-4" /> 確定保存
      </Button>
    </header>

    <div v-if="renderError" class="border-b bg-destructive/10 px-4 py-2 text-sm text-destructive">
      {{ renderError }}
    </div>

    <div class="flex-1 overflow-hidden">
      <PreviewPanel ref="panel" :html="previewDoc" @state="onState" />
    </div>
  </div>
</template>
