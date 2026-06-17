<script setup lang="ts">
import { isErr, isOk, type SampleData, type Template } from '@editor/shared';
import { FileDown, Loader2, Save } from '@lucide/vue';
import { computed, onMounted, ref } from 'vue';
import BackButton from '@/components/ui/BackButton.vue';
import Button from '@/components/ui/Button.vue';
import { confirm } from '@/components/ui/confirm';
import { toastSuccess } from '@/components/ui/toast';
import AttributeBar from '@/features/editor/AttributeBar.vue';
import { useAsyncResult } from '@/lib/useAsyncResult';
import PreviewPanel from './PreviewPanel.vue';
import { useTemplatePreviewService } from './services/templatePreviewService';

const props = defineProps<{ id: string }>();

const preview = useTemplatePreviewService();
const template = ref<Template | null>(null);
const sample = ref<SampleData>({});
const restoredHtml = ref('');
const css = ref('');
const previewDoc = ref('');
const renderError = ref<string | null>(null);
const { run: runLoad } = useAsyncResult();
const { loading: saving, run: runSave } = useAsyncResult();
const { loading: exporting, run: runExport } = useAsyncResult();

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
      // Keep the rendered document as this confirm's report instance.
      filledHtml: previewDoc.value,
    }),
  );
  if (isOk(saved)) toastSuccess('確定保存しました');
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
  <div class="flex h-screen flex-col bg-muted/30">
    <div class="flex items-center gap-3 border-b bg-card px-4 py-2 print:hidden">
      <BackButton :fallback="{ name: 'editor', params: { id } }" aria-label="エディターに戻る" />
      <AttributeBar v-if="template" :attributes="template.meta.attributes" class="flex-1" />
      <div class="flex items-center gap-2">
        <Button variant="outline" :disabled="exporting" @click="exportPdf">
          <Loader2 v-if="exporting" class="h-4 w-4 animate-spin" />
          <FileDown v-else class="h-4 w-4" /> PDF出力
        </Button>
        <Button :disabled="saving" @click="confirmSave">
          <Loader2 v-if="saving" class="h-4 w-4 animate-spin" />
          <Save v-else class="h-4 w-4" /> 確定保存
        </Button>
      </div>
    </div>

    <div v-if="renderError" class="border-b bg-destructive/10 px-4 py-2 text-sm text-destructive">
      {{ renderError }}
    </div>

    <div class="flex-1 overflow-hidden">
      <PreviewPanel :html="previewDoc" />
    </div>
  </div>
</template>
