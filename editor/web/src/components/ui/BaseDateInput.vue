<script setup lang="ts">
// =============================================================================
// BaseDateInput.vue — 基準日を打ち込める入力欄(候補は絞り込み表示)
// =============================================================================
// `Select.vue` と同じ props / v-model で差し替えられる。違いは、Excel で調べた日付を打つ・貼る
// 使い方に合わせ、候補に無い日付も確定できる点。確定は Enter・blur・貼り付け・候補の選択で、
// 読み方は `parseBaseDateInput` に任せる。読めないときは値を変えず、理由を欄の下に出す。
// 横に並んだ欄の高さを揃えたい親は `errorDisplay="external"` と `v-model:error` で理由を受け取り、
// 自分の置きたい場所に出す。
import { ChevronDown } from '@lucide/vue';
import { computed, ref, useId, watch } from 'vue';
import { type BaseDateParse, findBaseDateCandidate, parseBaseDateInput } from '@/lib/baseDate';
import { cn } from '@/lib/utils';
import { normalizeOptions, type UiOption } from './options';

const props = defineProps<{
  options: UiOption[];
  placeholder?: string;
  disabled?: boolean;
  class?: string;
  /** 読めない理由の出し方。`inline` は欄の下、`external` は出さずに `error` で親へ渡すだけ。 */
  errorDisplay?: 'inline' | 'external';
}>();
const model = defineModel<string | undefined>();
const error = defineModel<string>('error', { default: '' });

const FORMAT_ERROR = '日付として読めません（例: 2026/09/30）';
const INVALID_ERROR = '実在しない日付です';

const options = computed(() => normalizeOptions(props.options));
const candidates = computed(() => options.value.map((o) => o.value));

// 欄に出す文字。候補にある値は Select.vue と同じく表示名(label)で出す。
function labelOf(value: string | undefined): string {
  if (value === undefined) {
    return '';
  }
  return options.value.find((o) => o.value === value)?.label ?? value;
}

const text = ref(labelOf(model.value));
const open = ref(false);
const active = ref(-1);
const input = ref<HTMLInputElement>();
const listId = useId();

watch(model, (v) => {
  text.value = labelOf(v);
  error.value = '';
});

const digits = (s: string): string => s.replace(/\D/g, '');

// 欄が確定済みの表示のままなら全件を見せる(開いた直後に自分だけへ絞られないように)。
// 絞り込みは値の数字の前方一致で行い、表示名の部分一致でも拾う。
const shown = computed(() => {
  const raw = text.value.trim().toLowerCase();
  if (!raw || text.value === labelOf(model.value)) {
    return options.value;
  }
  const q = digits(raw);
  return options.value.filter(
    (o) => (q !== '' && digits(o.value).startsWith(q)) || o.label.toLowerCase().includes(raw),
  );
});

const activeId = computed(() =>
  open.value && active.value >= 0 && active.value < shown.value.length
    ? `${listId}-${active.value}`
    : undefined,
);

function errorText(r: Extract<BaseDateParse, { ok: false }>): string {
  return r.reason === 'format' ? FORMAT_ERROR : INVALID_ERROR;
}

function restore(): void {
  text.value = labelOf(model.value);
  error.value = '';
}

// 日付として読めない候補(ファイル名の基準日は形の検査が無い)も選べるよう、候補そのものは読まない。
function setValue(value: string): void {
  error.value = '';
  text.value = labelOf(value);
  open.value = false;
  active.value = -1;
  if (value !== model.value) {
    model.value = value;
  }
}

function commit(raw: string): void {
  const t = raw.trim();
  if (!t) {
    restore();
    return;
  }
  const exact = options.value.find((o) => o.value === t || o.label === t);
  if (exact) {
    setValue(exact.value);
    return;
  }
  const r = parseBaseDateInput(t);
  if (!r.ok) {
    error.value = errorText(r);
    return;
  }
  setValue(findBaseDateCandidate(r.value, candidates.value) ?? r.value);
}

function openList(): void {
  if (!props.disabled) {
    open.value = true;
  }
}

// 欄の余白や矢印を押したときも入力欄へフォーカスして開く(Escape 後の開き直しも兼ねる)。
function onBoxClick(): void {
  if (props.disabled) {
    return;
  }
  input.value?.focus();
  openList();
}

function onBlur(): void {
  open.value = false;
  active.value = -1;
  if (text.value !== labelOf(model.value)) {
    commit(text.value);
  }
}

function move(step: 1 | -1): void {
  openList();
  const n = shown.value.length;
  if (n === 0) {
    return;
  }
  active.value = (active.value + step + n) % n;
}

function onEnter(): void {
  const opt = open.value ? shown.value[active.value] : undefined;
  if (opt) {
    setValue(opt.value);
    return;
  }
  commit(text.value);
}

function onKeydown(e: KeyboardEvent): void {
  if (e.key === 'Enter') {
    e.preventDefault();
    onEnter();
  } else if (e.key === 'Escape') {
    open.value = false;
    active.value = -1;
    restore();
  } else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
    e.preventDefault();
    move(e.key === 'ArrowDown' ? 1 : -1);
  }
}

// クリップボードを読めるときだけその場で確定する。読めない環境では、ブラウザが文字を入れたあとの
// 入力と Enter / blur に任せる(貼り付けイベントの時点では欄の値がまだ変わっていない)。
function onPaste(e: ClipboardEvent): void {
  const data = e.clipboardData?.getData('text');
  if (data === undefined) {
    return;
  }
  e.preventDefault();
  text.value = data.trim();
  commit(data);
}

function onInput(): void {
  error.value = '';
  active.value = -1;
  open.value = !props.disabled;
}
</script>

<template>
  <div class="relative w-full">
    <!-- biome-ignore lint/a11y/useKeyWithClickEvents: キー操作は内側の input が受ける -->
    <!-- biome-ignore lint/a11y/noStaticElementInteractions: キー操作は内側の input が受ける -->
    <div
      :class="
        cn(
          'flex h-9 w-full items-center justify-between rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-sm transition-colors duration-150 hover:border-ring/40 focus-within:ring-2 focus-within:ring-ring focus-within:ring-offset-1 focus-within:ring-offset-background',
          disabled && 'cursor-not-allowed opacity-50',
          error && 'border-destructive',
          $props.class,
        )
      "
      @click="onBoxClick"
    >
      <input
        ref="input"
        v-model="text"
        type="text"
        role="combobox"
        aria-autocomplete="list"
        :aria-expanded="open && shown.length > 0"
        :aria-controls="listId"
        :aria-activedescendant="activeId"
        inputmode="numeric"
        autocomplete="off"
        :placeholder="placeholder ?? '選択'"
        :disabled="disabled"
        :aria-invalid="error ? 'true' : undefined"
        class="min-w-0 flex-1 bg-transparent text-left outline-none placeholder:text-muted-foreground disabled:cursor-not-allowed"
        @focus="openList"
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
      :id="listId"
      role="listbox"
      class="absolute z-50 mt-1 max-h-72 w-full min-w-[8rem] overflow-auto rounded-md border bg-popover p-1 text-popover-foreground shadow-md"
      @mousedown.prevent
    >
      <button
        v-for="(o, i) in shown"
        :id="`${listId}-${i}`"
        :key="o.value"
        type="button"
        role="option"
        tabindex="-1"
        :aria-selected="o.value === model"
        :class="
          cn(
            'block w-full cursor-pointer select-none whitespace-nowrap rounded-sm px-2 py-1.5 text-left text-sm hover:bg-accent hover:text-accent-foreground',
            i === active && 'bg-accent text-accent-foreground',
          )
        "
        @click="setValue(o.value)"
      >
        {{ o.label }}
      </button>
    </div>
    <p v-if="error && errorDisplay !== 'external'" role="alert" class="mt-1 text-xs text-destructive">
      {{ error }}
    </p>
  </div>
</template>
