<script setup lang="ts">
// =============================================================================
// PartPreview.vue — 選択中パーツの視覚プレビュー(iframe 縮小描画)
// =============================================================================
/**
 * 左ペインで選んだパーツの `content`(HTML 断片)を、レポート CSS 付きで小さく縮小
 * 描画して「どんなパーツか」を見せる。クラス付き content をそのまま忠実に出すため、
 * レポート CSS のグローバルセレクタ(`body`/`table.data`/`.band` 等)が Vue scoped CSS や
 * 左ペインへ漏れないよう iframe(`srcdoc`)へ隔離する。
 *
 * 実寸は A4 横幅相当(96dpi ≒ 794px)で組み、ステージ実測幅に合わせて `transform: scale`
 * で縮小する。挿入先 canvas には全ファンド共通テーマの複製 CSS が載るため、プレビューも
 * その正テーマ(`510037.css`)1 枚を読めば実物と同じ見た目になる([[editor-tofilled-text-only]])。
 */
import { Eye } from '@lucide/vue';
import { computed, onBeforeUnmount, onMounted, ref, useTemplateRef, watch } from 'vue';
// レポートの正テーマ(全ファンド共通)。クラスの見た目はこの 1 枚で確定する。
import reportCss from '@/api/fixtures/css/510037.css?raw';

const props = defineProps<{ content: string | null }>();

// A4 横幅相当(96dpi)。実寸でレイアウトし、ステージ幅に合わせて scale で縮める。
const CANVAS_WIDTH = 794;

const stageRef = useTemplateRef<HTMLDivElement>('stage');
const frameRef = useTemplateRef<HTMLIFrameElement>('frame');

// ステージ実測幅 / 実寸幅 = 縮小率。iframe 実コンテンツ高 × scale がステージの実高になる。
const scale = ref(0.3);
const contentHeight = ref(200);

const srcdoc = computed(
  () =>
    `<!doctype html><html lang="ja"><head><meta charset="utf-8" /><style>${reportCss}` +
    // body 直書きで余白を詰め、パーツ単体が枠いっぱいに見えるようにする。
    `\nbody{margin:0;padding:10px;width:${CANVAS_WIDTH}px;box-sizing:border-box}` +
    `</style></head><body>${props.content ?? ''}</body></html>`,
);

// ステージ幅の変化(ペイン幅変更など)に追従して scale を測り直す。
let ro: ResizeObserver | null = null;
function measure(): void {
  const w = stageRef.value?.clientWidth ?? 0;
  if (w > 0) scale.value = w / CANVAS_WIDTH;
}

// iframe ロード後に実コンテンツ高を読む。srcdoc 変更のたびに load が再発火する。
function onFrameLoad(): void {
  const body = frameRef.value?.contentDocument?.body;
  if (body) contentHeight.value = body.scrollHeight;
}

onMounted(() => {
  measure();
  ro = new ResizeObserver(measure);
  if (stageRef.value) ro.observe(stageRef.value);
});
onBeforeUnmount(() => ro?.disconnect());

// content が変わったら一旦既定高へ戻す(古い高さのちらつき回避)。load で実高へ更新。
watch(
  () => props.content,
  () => {
    contentHeight.value = 200;
  },
);
</script>

<template>
  <div class="flex h-full flex-col">
    <!-- 未選択: プレースホルダ -->
    <div
      v-if="!content"
      class="flex flex-1 flex-col items-center justify-center gap-2 px-6 text-center text-xs text-muted-foreground"
    >
      <Eye class="h-7 w-7 opacity-40" />
      <span>カテゴリから選ぶと<br />プレビューを表示します</span>
    </div>

    <!-- 選択中: レポート CSS 付きで iframe 縮小描画 -->
    <div v-else ref="stage" class="preview-stage" :style="{ height: `${contentHeight * scale}px` }">
      <iframe
        ref="frame"
        class="preview-frame"
        :srcdoc="srcdoc"
        :style="{
          width: `${CANVAS_WIDTH}px`,
          height: `${contentHeight}px`,
          transform: `scale(${scale})`,
        }"
        sandbox="allow-same-origin"
        title="パーツのプレビュー"
        @load="onFrameLoad"
      />
    </div>
  </div>
</template>

<style scoped>
/* 縮小後の iframe を載せる白いステージ。はみ出しは隠し、高さは scale 後の実高に追従。 */
.preview-stage {
  position: relative;
  overflow: hidden;
  width: 100%;
  background: #fff;
  border: 1px solid var(--border);
  border-radius: 8px;
}
/* 実寸(794px)で組み、`transform: scale` で縮める。原点は左上に固定。 */
.preview-frame {
  position: absolute;
  top: 0;
  left: 0;
  transform-origin: top left;
  border: 0;
}
</style>
