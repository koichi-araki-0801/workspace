<script setup lang="ts">
// =============================================================================
// StepperInput.vue — 増減ステッパー付き数値入力(幅% / 余白mm などの複合コントロール)
// =============================================================================
// 両端に ±1 のステッパーを置き、中央に値 + 単位を据える。clamp・確定(commit)・刻み幅は
// 呼び出し側の責務(blur で `commit`、ステッパー/上下キーで `step` を emit するだけ)。
// 値ミラーは文字列 model — 入力中の未確定文字列を保持し、無効値は `invalid` で赤枠警告する。
import { Minus, Plus } from '@lucide/vue';
import { Tooltip } from './overlays';

defineProps<{
  /** 値の後ろに出す単位表記(% / mm)。 */
  unit: string;
  /** 入力中の値が無効(空 / 非数値)の間だけ赤系の枠で気付かせる。 */
  invalid?: boolean;
  /** 減らす側ステッパーのヒント兼 aria-label(例: 幅を減らす)。 */
  decLabel: string;
  /** 増やす側ステッパーのヒント兼 aria-label(例: 幅を増やす)。 */
  incLabel: string;
}>();

const model = defineModel<string>({ required: true });
const emit = defineEmits<{ commit: []; step: [delta: number] }>();

function onEnter(e: KeyboardEvent) {
  (e.target as HTMLInputElement).blur();
}
</script>

<template>
  <div class="ins-num" :class="{ 'ins-num-invalid': invalid }">
    <Tooltip :text="decLabel">
      <button type="button" class="ins-step" :aria-label="decLabel" @click="emit('step', -1)">
        <Minus class="h-3 w-3" />
      </button>
    </Tooltip>
    <input
      v-model="model"
      inputmode="numeric"
      class="mono"
      @blur="emit('commit')"
      @keydown.enter="onEnter"
      @keydown.up.prevent="emit('step', 1)"
      @keydown.down.prevent="emit('step', -1)"
    />
    <span class="ins-unit">{{ unit }}</span>
    <Tooltip :text="incLabel">
      <button type="button" class="ins-step" :aria-label="incLabel" @click="emit('step', 1)">
        <Plus class="h-3 w-3" />
      </button>
    </Tooltip>
  </div>
</template>

<style scoped>
/* 数値入力(幅 / 余白)。両端に増減ステッパーを置き、中央に値 + 単位を据える */
.ins-num {
  display: inline-flex;
  height: 28px;
  align-items: center;
  gap: 1px;
  border-radius: 7px;
  background: var(--muted);
  padding: 0 2px;
}
.ins-num input {
  width: 40px;
  border: 0;
  background: transparent;
  text-align: center;
  font-size: 12.5px;
  font-weight: 600;
  color: var(--foreground);
  outline: none;
  padding: 0;
}
.ins-num input:disabled {
  opacity: 0.55;
  cursor: not-allowed;
}
/* 無効値(空 / 非数値)の間だけ赤系の枠で気付かせる。blur 時に呼び出し側が元値へ戻す。 */
.ins-num-invalid {
  background: color-mix(in oklab, var(--destructive) 12%, var(--muted));
  box-shadow: inset 0 0 0 1.5px color-mix(in oklab, var(--destructive) 70%, transparent);
}
.ins-unit {
  font-size: 10px;
  color: var(--muted-foreground);
}
/* 増減ボタン(クリック / 入力欄の上下キーと同じ刻み) */
.ins-step {
  display: inline-flex;
  height: 22px;
  width: 22px;
  flex-shrink: 0;
  align-items: center;
  justify-content: center;
  border-radius: 5px;
  color: var(--muted-foreground);
  transition:
    background-color 0.12s,
    color 0.12s;
}
.ins-step:hover {
  background: var(--accent);
  color: var(--foreground);
}
.ins-step:focus-visible {
  outline: none;
  box-shadow:
    0 0 0 2px var(--background),
    0 0 0 4px color-mix(in oklab, var(--ring) 55%, transparent);
}
/* 数値入力はステッパーと一体の複合コントロールなので、input 単体でなく枠全体にリングを出す。
   無効値の inset 枠(`.ins-num-invalid`)と重なっても両方見えるよう box-shadow は追記合成しない。 */
.ins-num:focus-within {
  box-shadow:
    0 0 0 2px var(--background),
    0 0 0 4px color-mix(in oklab, var(--ring) 55%, transparent);
}
.ins-num-invalid:focus-within {
  box-shadow:
    inset 0 0 0 1.5px color-mix(in oklab, var(--destructive) 70%, transparent),
    0 0 0 2px var(--background),
    0 0 0 4px color-mix(in oklab, var(--ring) 55%, transparent);
}
</style>
