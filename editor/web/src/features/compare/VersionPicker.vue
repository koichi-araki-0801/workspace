<script setup lang="ts">
import type { TemplateVersionMeta } from '@editor/shared';
import { ArrowLeftRight, GitCompare } from '@lucide/vue';
import { computed, ref, watch } from 'vue';
import Badge from '@/components/ui/Badge.vue';
import Button from '@/components/ui/Button.vue';
import Checkbox from '@/components/ui/Checkbox.vue';
import { formatDateTimeShort } from '@/lib/format';

const props = defineProps<{ versions: TemplateVersionMeta[] }>();
// a = 前回（古い方）, b = 今回（新しい方）
const emit = defineEmits<{ compare: [{ a: string; b: string }] }>();

const selected = ref<string[]>([]);

// 版が変わったら新しい2件を既定選択（参考デザインどおり）。
watch(
  () => props.versions,
  (vs) => {
    selected.value = vs.slice(0, 2).map((v) => v.historyId);
  },
  { immediate: true },
);

const atMax = computed(() => selected.value.length >= 2);
const isChecked = (id: string) => selected.value.includes(id);

function toggle(id: string) {
  if (isChecked(id)) {
    selected.value = selected.value.filter((s) => s !== id);
    return;
  }
  if (atMax.value) return; // 2件まで。外してから選び直す。
  // 版の並び（新しい順）を保ったまま追加する。
  const next = new Set([...selected.value, id]);
  selected.value = props.versions.filter((v) => next.has(v.historyId)).map((v) => v.historyId);
}

// 選択2件のうち新しい方=今回(b)、古い方=前回(a)。versions は新しい順。
const pair = computed(() => {
  if (selected.value.length !== 2) return null;
  const chosen = props.versions.filter((v) => selected.value.includes(v.historyId));
  return { a: chosen[1], b: chosen[0] };
});

const roleBadge = (v: TemplateVersionMeta): '今回' | '前回' | null => {
  if (!pair.value) return null;
  if (v.historyId === pair.value.b.historyId) return '今回';
  if (v.historyId === pair.value.a.historyId) return '前回';
  return null;
};
</script>

<template>
  <div v-if="versions.length" class="space-y-3">
    <p class="text-[13px] text-muted-foreground">
      保存履歴から版を2つ選んでください。新しい方が自動で「今回」になります。
    </p>

    <div class="space-y-2">
      <label
        v-for="(v, i) in versions"
        :key="v.historyId"
        class="flex items-center gap-3 rounded-xl border-[1.5px] px-4 py-3 transition-all duration-150"
        :class="
          isChecked(v.historyId)
            ? 'cursor-pointer border-primary bg-primary-soft ring-[3px] ring-primary/15'
            : atMax
              ? 'cursor-not-allowed border-border bg-card opacity-55'
              : 'cursor-pointer border-border bg-card hover:bg-accent/40'
        "
      >
        <Checkbox
          :model-value="isChecked(v.historyId)"
          :disabled="atMax && !isChecked(v.historyId)"
          @update:model-value="() => toggle(v.historyId)"
        />
        <div class="min-w-0">
          <div class="flex items-center gap-2">
            <span class="font-bold">{{ formatDateTimeShort(v.timestamp) }}</span>
            <Badge v-if="i === 0" variant="secondary" class="font-medium">最新</Badge>
          </div>
          <div class="mt-0.5 text-[13px] text-muted-foreground">{{ v.summary }} ・ {{ v.user }}</div>
        </div>
        <div class="ml-auto">
          <Badge v-if="roleBadge(v)" variant="outline">{{ roleBadge(v) }}</Badge>
        </div>
      </label>
    </div>

    <!-- summary bar -->
    <div
      v-if="pair"
      class="flex flex-wrap items-center gap-2 rounded-lg border bg-muted/40 px-3 py-2 text-[13px]"
    >
      <Badge variant="outline">前回</Badge>
      <span class="text-muted-foreground">
        {{ formatDateTimeShort(pair.a.timestamp) }}・{{ pair.a.user }}
      </span>
      <ArrowLeftRight class="h-4 w-4 text-muted-foreground" />
      <Badge variant="outline">今回</Badge>
      <span class="text-muted-foreground">
        {{ formatDateTimeShort(pair.b.timestamp) }}・{{ pair.b.user }}
      </span>
    </div>

    <Button
      :disabled="!pair"
      @click="pair && emit('compare', { a: pair.a.historyId, b: pair.b.historyId })"
    >
      <GitCompare class="h-4 w-4" /> 比較する
    </Button>
  </div>

  <p v-else class="text-[13px] text-muted-foreground">
    ステップ1でテンプレートを選択してください。
  </p>
</template>
