<script setup lang="ts">
// =============================================================================
// PageNav.vue — ページ番号ジャンプ入力 + 前後ボタン(編集 / プレビュー / 比較で共用)
// =============================================================================
// 本番運営の 400 ページ規模では前後送りだけのページャは実用に耐えない。現在ページ番号を直接
// 入力して任意ページへ飛べる共通 UI にする。表示も入力も 1 起点。確定値は親へ `go`(1 起点)で
// 渡し、実際のページ移動(`goToPage` / vivliostyle `navigateToPage` / 比較の `currentPage`)は
// 各画面側に委ねる(本コンポーネントは presentational)。
import { ChevronLeft, ChevronRight } from '@lucide/vue';
import { computed, ref, watch } from 'vue';
import type { ButtonVariants } from '@/components/ui/Button.vue';
import Button from '@/components/ui/Button.vue';
import Input from '@/components/ui/Input.vue';
import { Tooltip } from '@/components/ui/overlays';
import { clampPage } from './pageNav';

const props = withDefaults(
  defineProps<{
    /** 1 起点で表示する現在ページ番号。 */
    currentPage: number;
    pageCount: number;
    /** 前後ボタンの見た目(各ツールバーの慣習に合わせる)。 */
    variant?: ButtonVariants['variant'];
    /** 高さを詰めた小型ボタン(h-7)にするか(プレビュー上部バー用)。 */
    dense?: boolean;
  }>(),
  { variant: 'outline', dense: false },
);

const emit = defineEmits<{ go: [page: number] }>();

// 入力欄は focus 中だけローカル編集する — 1 文字打つたびにジャンプしないよう、確定(Enter/blur)で
// 親へ通知する。非編集時は親の `currentPage` をそのまま映す(レール操作等の外部更新に追従)。
const editing = ref(false);
const draft = ref(String(props.currentPage));
watch(
  () => props.currentPage,
  (v) => {
    if (!editing.value) draft.value = String(v);
  },
);

// 入力欄の幅は総ページ桁数に合わせる(400 なら 3 桁)。最小 2 桁 + 左右パディングぶん。
const inputWidth = computed(() => `${Math.max(2, String(props.pageCount).length) + 1.5}ch`);
const denseBtn = computed(() => (props.dense ? 'h-7 w-7' : ''));

/** 入力中の値を clamp して確定し、変化があれば親へ通知する。 */
function commit(): void {
  editing.value = false;
  const n = clampPage(Number(draft.value), props.pageCount);
  draft.value = String(n);
  if (n !== props.currentPage) emit('go', n);
}
function onFocus(e: FocusEvent): void {
  editing.value = true;
  draft.value = String(props.currentPage);
  (e.target as HTMLInputElement).select();
}
/** 前後ボタン / 上下キーで現在ページから相対移動する(端は clamp で止まる)。 */
function step(delta: number): void {
  emit('go', clampPage(props.currentPage + delta, props.pageCount));
}

// コンポーネントへの `@keydown.enter` 等の多重指定は同名 prop の重複になる(TS1117)ため、
// 1 ハンドラへ集約してキー別に分岐する。挙動は従来の modifier 版と同一。
function onInputKeydown(e: KeyboardEvent): void {
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
</script>

<template>
  <div class="flex shrink-0 items-center gap-1.5">
    <Tooltip text="前のページ">
      <Button
        :variant="variant"
        size="icon"
        :class="denseBtn"
        aria-label="前のページ"
        :disabled="currentPage <= 1"
        @click="step(-1)"
      >
        <ChevronLeft class="h-4 w-4" />
      </Button>
    </Tooltip>

    <div class="flex items-center gap-1 text-[12.5px] tabular-nums text-muted-foreground">
      <!-- 数値スピナの余計な幅を避けるため text + inputmode=numeric。上下キーは自前で ±1 する。 -->
      <Input
        v-model="draft"
        inputmode="numeric"
        aria-label="ページ番号(Enter でジャンプ)"
        class="h-7 w-auto rounded bg-background px-1 py-0 text-center text-[12.5px] tabular-nums text-foreground shadow-none"
        :style="{ width: inputWidth }"
        @focus="onFocus"
        @blur="commit"
        @keydown="onInputKeydown"
      />
      <span>/ {{ pageCount }}</span>
    </div>

    <Tooltip text="次のページ">
      <Button
        :variant="variant"
        size="icon"
        :class="denseBtn"
        aria-label="次のページ"
        :disabled="currentPage >= pageCount"
        @click="step(1)"
      >
        <ChevronRight class="h-4 w-4" />
      </Button>
    </Tooltip>
  </div>
</template>
