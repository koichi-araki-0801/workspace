<script setup lang="ts">
// =============================================================================
// PageMatchInput.vue — ページ対応(ずらし)の対応ページ番号入力(比較結果画面)
// =============================================================================
// この行に並べる当該側のページを直接指定する入力欄。数百ページの版では候補を列挙する
// プルダウンでは選べない(候補が数百件になり、目的のページまで辿れない)ため、番号を打って
// 飛べるようにする。値は 0 起点のページ index(`null` = 対応なし)でやり取りし、表示と入力は
// 1 起点。確定は Enter / blur のみで、打鍵ごとに再 diff が走らないようにする。
import { computed, ref, watch } from 'vue';
import { clampPage } from '@/components/pageNav';
import Button from '@/components/ui/Button.vue';
import Input from '@/components/ui/Input.vue';
import { Tooltip } from '@/components/ui/overlays';
import { parsePageIndex } from './pageMatch';

const props = defineProps<{
  /** 0 起点のページ index。`null` は対応なし(この行に当該側のページを置かない)。 */
  modelValue: number | null;
  /** 当該側の総ページ数。0 のときは指定しようがないので操作を閉じる。 */
  pageCount: number;
  /** 「比較元」「比較先」など、支援技術向けに操作対象を言い分けるための名前。 */
  label: string;
}>();

const emit = defineEmits<{ 'update:modelValue': [value: number | null] }>();

const disabled = computed(() => props.pageCount <= 0);
const isNone = computed(() => props.modelValue == null);
/** 表示用の 1 起点ページ番号(対応なしは空欄)。 */
const shown = computed(() => (props.modelValue == null ? '' : String(props.modelValue + 1)));

// 入力欄は focus 中だけローカル編集する — 1 文字打つたびに再 diff しないよう、確定
// (Enter / blur)で親へ通知する。非編集時は親の値をそのまま映す(ボタン操作等に追従)。
const editing = ref(false);
const draft = ref(shown.value);
watch(shown, (v) => {
  if (!editing.value) draft.value = v;
});

// 「対応なし」を解除したときの戻り先。直前に指していたページへ戻せると往復が軽い。
const lastValid = ref(props.modelValue ?? 0);
watch(
  () => props.modelValue,
  (v) => {
    if (v != null) lastValid.value = v;
  },
);

// 入力欄の幅は総ページ桁数に合わせる(340 なら 3 桁)。最小 2 桁 + 左右パディングぶん。
const inputWidth = computed(() => `${Math.max(2, String(props.pageCount).length) + 1.5}ch`);

/** 0 起点 index を確定する(変化があるときだけ通知し、無駄な再 diff を避ける)。 */
function commitIndex(index: number): void {
  if (index !== props.modelValue) emit('update:modelValue', index);
}

/** 入力中の値を解釈して確定する。無効(空 / 非数値)なら元の値へ戻す。 */
function commit(): void {
  editing.value = false;
  const index = parsePageIndex(draft.value, props.pageCount);
  if (index == null) {
    draft.value = shown.value;
    return;
  }
  draft.value = String(index + 1);
  commitIndex(index);
}

function onFocus(e: FocusEvent): void {
  editing.value = true;
  draft.value = shown.value;
  (e.target as HTMLInputElement).select();
}

/** 上下キー / PageUp・Down で相対移動する。対応なしからは先頭ページを起点にする。 */
function step(delta: number): void {
  if (disabled.value) return;
  const base = props.modelValue == null ? 0 : props.modelValue + delta;
  commitIndex(clampPage(base + 1, props.pageCount) - 1);
}

// コンポーネントへの `@keydown.enter` 等の多重指定は同名 prop の重複になる(TS1117)ため、
// 1 ハンドラへ集約してキー別に分岐する(`PageNav.vue` と同じ流儀)。
function onKeydown(e: KeyboardEvent): void {
  const actions: Record<string, () => void> = {
    Enter: () => (e.target as HTMLInputElement).blur(),
    ArrowUp: () => step(1),
    ArrowDown: () => step(-1),
    PageUp: () => step(10),
    PageDown: () => step(-10),
  };
  const action = actions[e.key];
  if (action) {
    e.preventDefault();
    action();
  }
}

/** 「対応なし」の切り替え。解除時は直前に指していたページへ戻す。 */
function toggleNone(): void {
  emit('update:modelValue', isNone.value ? lastValid.value : null);
}
</script>

<template>
  <div class="flex items-center gap-1">
    <div class="flex items-center gap-1 text-[12.5px] tabular-nums text-muted-foreground">
      <!-- 数値スピナの余計な幅を避けるため text + inputmode=numeric。上下キーは自前で ±1 する。 -->
      <Input
        v-model="draft"
        inputmode="numeric"
        :disabled="disabled"
        :placeholder="isNone ? '—' : ''"
        :aria-label="`${label}のページ番号(Enter で確定)`"
        class="h-8 w-auto px-1 py-0 text-center text-[12.5px] tabular-nums text-foreground"
        :style="{ width: inputWidth }"
        @focus="onFocus"
        @blur="commit"
        @keydown="onKeydown"
      />
      <span>/ {{ pageCount }}</span>
    </div>

    <Tooltip :text="isNone ? `${label}のページを指定し直す` : `この行に${label}のページを置かない`">
      <Button
        variant="outline"
        size="sm"
        class="h-8 px-2"
        :class="isNone ? 'border-primary bg-primary/10 text-primary' : ''"
        :disabled="disabled"
        :aria-pressed="isNone"
        data-testid="page-match-none"
        @click="toggleNone"
      >
        対応なし
      </Button>
    </Tooltip>
  </div>
</template>
