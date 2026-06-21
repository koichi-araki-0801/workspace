<script setup lang="ts">
// =============================================================================
// CompareResultView.vue — 版比較の結果画面(ページ単位の差分を左右並列で表示)
// =============================================================================
import type { TemplateVersionMeta } from '@editor/shared';
import { ChevronLeft, ChevronRight } from '@lucide/vue';
import { computed, onBeforeUnmount, ref } from 'vue';
import Button from '@/components/ui/Button.vue';
import { formatDateTimeShort } from '@/lib/format';
import { HL_ADDED, HL_CHANGED, HL_REMOVED, type HtmlDiff } from './htmlBlockDiff';

const props = defineProps<{
  before: TemplateVersionMeta; // ファイルA(左)
  after: TemplateVersionMeta; // ファイルB(右)
  beforeFile: string; // ファイルA のファイル名
  afterFile: string; // ファイルB のファイル名
  diff: HtmlDiff;
  cssBefore: string;
  cssAfter: string;
}>();

const emit = defineEmits<{ back: [] }>();

// 最初の変更ありページを開く(無ければ先頭)。
const firstChanged = props.diff.pages.findIndex((p) => p.changed);
const currentPage = ref(firstChanged >= 0 ? firstChanged : 0);
const pageCount = computed(() => props.diff.pages.length);
const page = computed(() => props.diff.pages[currentPage.value] ?? null);

function goPage(i: number) {
  currentPage.value = Math.min(Math.max(i, 0), Math.max(pageCount.value - 1, 0));
}

// テンプレート CSS と差分ハイライトを内包した `iframe` ドキュメントを組み立てる。
const HIGHLIGHT_CSS = `
  body{margin:0;padding:18px;background:#fff;}
  .${HL_CHANGED}{background:rgba(220,38,38,.06)!important;box-shadow:inset 3px 0 0 #dc2626;}
  .${HL_ADDED}{background:rgba(22,163,74,.08)!important;box-shadow:inset 3px 0 0 #16a34a;}
  .${HL_REMOVED}{background:rgba(217,119,6,.08)!important;box-shadow:inset 3px 0 0 #d97706;}
`;
function buildDoc(fragment: string, css: string): string {
  return `<!doctype html><html lang="ja"><head><meta charset="utf-8" /><style>${css}</style><style>${HIGHLIGHT_CSS}</style></head><body>${fragment}</body></html>`;
}

const beforeDoc = computed(() => buildDoc(page.value?.beforeHtml ?? '', props.cssBefore));
const afterDoc = computed(() => buildDoc(page.value?.afterHtml ?? '', props.cssAfter));

// `iframe` を中身の高さに合わせる(srcdoc は同一オリジンなので `contentDocument` 可)。
function fitTo(f: HTMLIFrameElement | null | undefined) {
  if (!f) return;
  try {
    const h = f.contentDocument?.body?.scrollHeight;
    if (h) f.style.height = `${h + 4}px`;
  } catch {
    /* ignore */
  }
}
// `@load` 時の初回フィット。同時に、幅が変わると中身が再フローして高さも変わるため、
// `<iframe>` 自身を `ResizeObserver` で監視して以降の幅変化(ウィンドウ/ペインのリサイズ、
// `md:grid-cols-2` の折返し)にも追随させる。
const frameObservers = new WeakMap<HTMLIFrameElement, ResizeObserver>();
function fitFrame(e: Event) {
  const f = e.target as HTMLIFrameElement;
  fitTo(f);
  if (!frameObservers.has(f)) {
    const ro = new ResizeObserver(() => fitTo(f));
    ro.observe(f);
    frameObservers.set(f, ro);
    observed.push(f);
  }
}

// クリーンアップ用に監視中の `iframe` を保持(`WeakMap` は列挙できないため)。
const observed: HTMLIFrameElement[] = [];
onBeforeUnmount(() => {
  for (const f of observed) frameObservers.get(f)?.disconnect();
  observed.length = 0;
});
</script>

<template>
  <div class="space-y-4">
    <!-- 上部バー -->
    <div class="flex flex-wrap items-center gap-3 border-b pb-3">
      <Button variant="outline" size="sm" @click="emit('back')">
        <ChevronLeft class="h-4 w-4" /> 選択に戻る
      </Button>
      <span class="text-lg font-bold">ファイルの比較</span>
      <span class="mono text-xs text-muted-foreground">比較元: {{ beforeFile }}　↔　比較先: {{ afterFile }}</span>
      <div class="ml-auto flex items-center gap-3">
        <span
          class="rounded-full px-2 py-0.5 text-xs font-medium"
          :class="diff.changedPageCount ? 'bg-destructive/10 text-destructive' : 'bg-muted text-muted-foreground'"
        >
          変更ありページ: {{ diff.changedPageCount }} / {{ pageCount }}
        </span>
        <span class="flex items-center gap-1 text-xs text-muted-foreground">
          <span class="inline-block h-1.5 w-1.5 rounded-full bg-destructive" /> = 変更あり
        </span>
      </div>
    </div>

    <!-- ページナビゲータ -->
    <div class="flex items-center justify-center gap-2">
      <Button variant="outline" size="icon" :disabled="currentPage <= 0" @click="goPage(currentPage - 1)">
        <ChevronLeft class="h-4 w-4" />
      </Button>
      <button
        v-for="(p, i) in diff.pages"
        :key="i"
        type="button"
        class="relative min-w-9 rounded px-3 py-1 text-sm font-medium transition-colors"
        :class="i === currentPage ? 'bg-primary-soft text-primary' : 'text-muted-foreground hover:bg-accent'"
        @click="goPage(i)"
      >
        {{ i + 1 }}
        <span
          v-if="p.changed"
          class="absolute -bottom-0.5 left-1/2 h-1.5 w-1.5 -translate-x-1/2 rounded-full bg-destructive"
        />
      </button>
      <Button
        variant="outline"
        size="icon"
        :disabled="currentPage >= pageCount - 1"
        @click="goPage(currentPage + 1)"
      >
        <ChevronRight class="h-4 w-4" />
      </Button>
    </div>

    <!-- 現在のページ -->
    <div v-if="page" class="space-y-3">
      <div class="flex flex-wrap items-center gap-2">
        <h3 class="text-[15px] font-bold">ページ {{ currentPage + 1 }}・概要</h3>
        <template v-if="page.changed">
          <span class="rounded-full bg-destructive/10 px-2 py-0.5 text-xs font-medium text-destructive">
            変更あり
          </span>
          <span class="text-xs text-muted-foreground">変更ブロック {{ page.changedBlockCount }} 箇所</span>
        </template>
        <span v-else class="rounded-full bg-muted px-2 py-0.5 text-xs font-medium text-muted-foreground">
          変更なし
        </span>
      </div>

      <div class="grid gap-3 md:grid-cols-2">
        <figure class="space-y-1.5">
          <figcaption class="text-xs text-muted-foreground">
            比較元・{{ beforeFile }}・{{ formatDateTimeShort(before.timestamp) }}・{{ before.user }}
          </figcaption>
          <div class="overflow-hidden rounded border bg-white">
            <iframe
              :srcdoc="beforeDoc"
              title="比較元"
              class="block w-full"
              style="height: 600px; border: 0"
              @load="fitFrame"
            />
          </div>
        </figure>
        <figure class="space-y-1.5">
          <figcaption class="text-xs text-muted-foreground">
            比較先・{{ afterFile }}・{{ formatDateTimeShort(after.timestamp) }}・{{ after.user }}
          </figcaption>
          <div class="overflow-hidden rounded border bg-white">
            <iframe
              :srcdoc="afterDoc"
              title="比較先"
              class="block w-full"
              style="height: 600px; border: 0"
              @load="fitFrame"
            />
          </div>
        </figure>
      </div>
    </div>
  </div>
</template>
