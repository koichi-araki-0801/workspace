<script setup lang="ts">
// =============================================================================
// BaseDateInput.vue — 基準日を打ち込める入力欄(候補は絞り込み表示)
// =============================================================================
// `Select.vue` と同じ props / v-model で差し替えられる。違いは、Excel で調べた日付を打つ・貼る
// 使い方に合わせ、候補に無い日付も確定できる点。確定は Enter・blur・貼り付け・候補の選択で、
// 読み方は `parseBaseDateInput` に任せる。読めないときは値を変えず、理由を欄の下に出す。
import { ChevronDown } from '@lucide/vue';
import { computed, nextTick, ref, watch } from 'vue';
import { type BaseDateParse, findBaseDateCandidate, parseBaseDateInput } from '@/lib/baseDate';
import { cn } from '@/lib/utils';
import { normalizeOptions, type UiOption } from './options';

const props = defineProps<{
  options: UiOption[];
  placeholder?: string;
  disabled?: boolean;
  class?: string;
}>();
const model = defineModel<string | undefined>();

const FORMAT_ERROR = '日付として読めません（例: 2026/09/30）';
const INVALID_ERROR = '実在しない日付です';

const text = ref(model.value ?? '');
const open = ref(false);
const error = ref('');

watch(model, (v) => {
  text.value = v ?? '';
  error.value = '';
});

const candidates = computed(() => normalizeOptions(props.options).map((o) => o.value));

const digits = (s: string): string => s.replace(/\D/g, '');

// 欄が確定済みの値のままなら全件を見せる(開いた直後に自分だけへ絞られないように)。
const shown = computed(() => {
  const q = digits(text.value);
  if (!q || text.value === (model.value ?? '')) {
    return candidates.value;
  }
  return candidates.value.filter((c) => digits(c).startsWith(q));
});

function errorText(r: Extract<BaseDateParse, { ok: false }>): string {
  return r.reason === 'format' ? FORMAT_ERROR : INVALID_ERROR;
}

function restore(): void {
  text.value = model.value ?? '';
  error.value = '';
}

function commit(raw: string): void {
  if (!raw.trim()) {
    restore();
    return;
  }
  const r = parseBaseDateInput(raw);
  if (!r.ok) {
    error.value = errorText(r);
    return;
  }
  const spelling = findBaseDateCandidate(r.value, candidates.value) ?? r.value;
  error.value = '';
  text.value = spelling;
  open.value = false;
  if (spelling !== model.value) {
    model.value = spelling;
  }
}

function pick(value: string): void {
  commit(value);
}

function onFocus(): void {
  if (!props.disabled) {
    open.value = true;
  }
}

function onBlur(): void {
  open.value = false;
  if (text.value !== (model.value ?? '')) {
    commit(text.value);
  }
}

function onKeydown(e: KeyboardEvent): void {
  if (e.key === 'Enter') {
    e.preventDefault();
    commit(text.value);
  } else if (e.key === 'Escape') {
    open.value = false;
  } else if (e.key === 'ArrowDown' && !props.disabled) {
    open.value = true;
  }
}

async function onPaste(e: ClipboardEvent): Promise<void> {
  const data = e.clipboardData?.getData('text');
  if (data !== undefined) {
    e.preventDefault();
    text.value = data.trim();
    commit(data);
    return;
  }
  await nextTick();
  commit((e.target as HTMLInputElement).value);
}

function onInput(): void {
  error.value = '';
  open.value = !props.disabled;
}
</script>

<template>
  <div class="relative w-full">
    <div
      :class="
        cn(
          'flex h-9 w-full items-center justify-between rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-sm transition-colors duration-150 hover:border-ring/40 focus-within:ring-2 focus-within:ring-ring focus-within:ring-offset-1 focus-within:ring-offset-background',
          disabled && 'cursor-not-allowed opacity-50',
          error && 'border-destructive',
          $props.class,
        )
      "
    >
      <input
        v-model="text"
        type="text"
        inputmode="numeric"
        autocomplete="off"
        :placeholder="placeholder ?? '選択'"
        :disabled="disabled"
        :aria-invalid="error ? 'true' : undefined"
        class="min-w-0 flex-1 bg-transparent text-left outline-none placeholder:text-muted-foreground disabled:cursor-not-allowed"
        @focus="onFocus"
        @blur="onBlur"
        @keydown="onKeydown"
        @paste="onPaste"
        @input="onInput"
      />
      <ChevronDown class="h-4 w-4 shrink-0 opacity-50" />
    </div>
    <!-- 項目の mousedown で入力欄の blur が先に走らないよう既定動作を止める。 -->
    <div
      v-if="open && shown.length > 0"
      role="listbox"
      class="absolute z-50 mt-1 max-h-72 w-full min-w-[8rem] overflow-auto rounded-md border bg-popover p-1 text-popover-foreground shadow-md"
      @mousedown.prevent
    >
      <button
        v-for="c in shown"
        :key="c"
        type="button"
        role="option"
        :aria-selected="c === model"
        class="block w-full cursor-pointer select-none whitespace-nowrap text-left rounded-sm px-2 py-1.5 text-sm hover:bg-accent hover:text-accent-foreground"
        @click="pick(c)"
      >
        {{ c }}
      </button>
    </div>
    <p v-if="error" role="alert" class="mt-1 text-xs text-destructive">{{ error }}</p>
  </div>
</template>
