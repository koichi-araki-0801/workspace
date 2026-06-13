<script setup lang="ts">
import { toAppError } from '@editor/shared';
import { Loader2 } from '@lucide/vue';
import { onBeforeUnmount, ref, watch } from 'vue';
import { logError } from '@/lib/appError';

const props = defineProps<{ html: string }>();

const viewport = ref<HTMLElement>();
const iframe = ref<HTMLIFrameElement>();
const useFallback = ref(false);
const rendering = ref(false);
// biome-ignore lint/suspicious/noExplicitAny: @vivliostyle/core の CoreViewer 型が動的import用途に不十分なため
let viewer: any = null;
let blobUrl: string | null = null;

function revoke() {
  if (blobUrl) {
    URL.revokeObjectURL(blobUrl);
    blobUrl = null;
  }
}

async function render() {
  revoke();
  if (!props.html) {
    rendering.value = false;
    return;
  }
  rendering.value = true;
  blobUrl = URL.createObjectURL(new Blob([props.html], { type: 'text/html' }));

  try {
    const mod = await import('@vivliostyle/core');
    const CoreViewer = mod.CoreViewer;
    if (!viewport.value) return;
    viewport.value.innerHTML = '';
    viewer = new CoreViewer(
      { viewportElement: viewport.value },
      { autoResize: true },
    );
    viewer.loadDocument({ url: blobUrl });
    useFallback.value = false;
  } catch (e) {
    // Fallback: plain iframe preview if vivliostyle fails to load/paginate.
    // The fallback keeps the preview working, so log for observability only
    // (no user toast).
    logError(toAppError(e));
    useFallback.value = true;
    if (iframe.value) iframe.value.srcdoc = props.html;
  } finally {
    rendering.value = false;
  }
}

watch(() => props.html, render, { immediate: true });

onBeforeUnmount(() => {
  revoke();
  try {
    viewer?.cleanup?.();
  } catch (e) {
    logError(toAppError(e));
  }
});
</script>

<template>
  <div class="relative h-full w-full overflow-auto bg-muted">
    <div
      v-if="rendering"
      class="absolute inset-0 z-10 flex items-center justify-center gap-2 bg-muted/70 text-sm text-muted-foreground"
    >
      <Loader2 class="h-4 w-4 animate-spin" /> プレビューを生成中…
    </div>
    <div v-show="!useFallback" ref="viewport" class="min-h-full w-full"></div>
    <iframe
      v-show="useFallback"
      ref="iframe"
      class="h-full min-h-[600px] w-full border-0 bg-white"
      title="プレビュー"
    ></iframe>
  </div>
</template>
