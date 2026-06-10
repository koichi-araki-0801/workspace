<script setup lang="ts">
import { AlertCircle, CheckCircle2, Eye, Loader2, Lock, RotateCcw, Save } from '@lucide/vue';
import { computed } from 'vue';
import { useRouter } from 'vue-router';
import BackButton from '@/components/ui/BackButton.vue';
import Button from '@/components/ui/Button.vue';
import { formatDateTime } from '@/lib/format';
import AttributeBar from './AttributeBar.vue';
import PartCatalog from './PartCatalog.vue';
import PartProperties from './PartProperties.vue';
import { useTemplateEditor } from './useTemplateEditor';

const props = defineProps<{ id: string }>();
const router = useRouter();

const {
  g,
  template,
  partHistory,
  selectedPart,
  autosave,
  canvasEl,
  layersEl,
  onPartSelect,
  onPartInsert,
} = useTemplateEditor(props.id);

async function goPreview() {
  await autosave.flush();
  router.push({ name: 'preview', params: { id: props.id } });
}

/** Autosave status line shown in the top bar; includes the last saved time when known. */
const statusText = computed(() => {
  const at = autosave.lastSavedAt.value;
  const savedAt = at ? `${at.toLocaleTimeString('ja-JP', { hour: '2-digit', minute: '2-digit' })} に自動保存` : null;
  switch (autosave.state.value) {
    case 'saving':
      return '保存中…';
    case 'error':
      return '保存に失敗しました';
    case 'saved':
      return savedAt ?? '保存しました';
    default:
      return savedAt ?? '自動保存';
  }
});
</script>

<template>
  <div class="flex h-screen flex-col bg-muted/30">
    <!-- top bar -->
    <div class="flex items-center gap-3 border-b bg-card px-4 py-2 print:hidden">
      <BackButton :fallback="{ name: 'edit' }" aria-label="ホームに戻る" />
      <AttributeBar v-if="template" :attributes="template.meta.attributes" class="flex-1" />
      <div class="flex items-center gap-2 sm:gap-3">
        <span
          class="flex items-center gap-1.5 text-xs"
          :class="autosave.state.value === 'error' ? 'text-destructive' : 'text-muted-foreground'"
          role="status"
          aria-live="polite"
        >
          <Loader2 v-if="autosave.state.value === 'saving'" class="h-3.5 w-3.5 animate-spin" />
          <CheckCircle2 v-else-if="autosave.state.value === 'saved'" class="h-3.5 w-3.5 text-success" />
          <AlertCircle v-else-if="autosave.state.value === 'error'" class="h-3.5 w-3.5" />
          <Save v-else class="h-3.5 w-3.5" />
          <span class="hidden sm:inline">{{ statusText }}</span>
        </span>
        <Button
          v-if="autosave.state.value === 'error'"
          size="sm"
          variant="outline"
          class="text-destructive hover:text-destructive"
          @click="autosave.flush()"
        >
          <RotateCcw class="h-4 w-4" /> 再試行
        </Button>
        <Button
          variant="outline"
          :disabled="autosave.state.value === 'saving'"
          title="今すぐ保存"
          @click="autosave.flush()"
        >
          <Save class="h-4 w-4" /> 保存
        </Button>
        <Button @click="goPreview"><Eye class="h-4 w-4" /> プレビュー</Button>
      </div>
    </div>

    <!-- 3-pane editor -->
    <div class="flex flex-1 overflow-hidden">
      <!-- left: parts + layers -->
      <aside class="hidden w-52 flex-col border-r bg-card md:flex lg:w-60">
        <div class="border-b px-3 py-2 text-xs font-semibold text-muted-foreground">パーツ一覧</div>
        <div class="flex-1 overflow-hidden">
          <PartCatalog @select="onPartSelect" @insert="onPartInsert" />
        </div>
        <div class="border-t px-3 py-2 text-xs font-semibold text-muted-foreground">レイヤー</div>
        <div ref="layersEl" class="max-h-48 overflow-auto"></div>
      </aside>

      <!-- center: canvas -->
      <main class="relative flex-1 overflow-hidden">
        <div ref="canvasEl" class="h-full"></div>
      </main>

      <!-- right: properties + part history -->
      <aside class="hidden w-64 flex-col border-l bg-card md:flex lg:w-72">
        <div class="border-b px-3 py-2 text-xs font-semibold text-muted-foreground">プロパティ</div>
        <div
          v-if="g.selected.value?.isJinja"
          class="flex items-start gap-2 border-b border-warning/30 bg-warning/10 px-3 py-2 text-xs text-warning"
        >
          <Lock class="mt-0.5 h-3.5 w-3.5 shrink-0" />
          <span>自動で値が入る項目のため、内容は編集できません。</span>
        </div>
        <div class="flex-1 overflow-auto">
          <PartProperties :part="selectedPart" />
        </div>
        <div class="border-t px-3 py-2 text-xs font-semibold text-muted-foreground">
          パーツの修正履歴
          <span v-if="g.selected.value" class="ml-1 font-mono font-normal text-foreground/60">#{{ g.selected.value.id }}</span>
        </div>
        <div class="max-h-56 overflow-auto px-3 py-2 text-xs">
          <p v-if="!g.selected.value" class="text-muted-foreground">パーツを選択してください</p>
          <p v-else-if="partHistory.length === 0" class="text-muted-foreground">履歴はありません</p>
          <ul v-else class="space-y-2">
            <li v-for="h in partHistory" :key="h.id" class="border-l-2 border-primary/40 pl-2">
              <div class="text-foreground">{{ h.change }}</div>
              <div class="text-muted-foreground">{{ formatDateTime(h.timestamp) }} · {{ h.user }}</div>
            </li>
          </ul>
        </div>
      </aside>
    </div>
  </div>
</template>
