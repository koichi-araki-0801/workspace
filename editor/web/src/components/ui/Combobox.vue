<script setup lang="ts">
// =============================================================================
// Combobox.vue — 入力で前方一致フィルタする `reka-ui` Combobox のセレクトボックス
// =============================================================================
// `Select.vue` と同じ props / v-model を持つ差し替え互換の入力欄。違いは値を
// タイプでき, 入力文字 (`value` = コードへの前方一致) で候補を絞り込む点。候補は
// `filtered` に限定して描画するため, リスト外の値は確定できない (絞り込み専用)。
// 既定の部分一致フィルタは `ignore-filter` で切り, 前方一致のみを自前で行う。
import { Check, ChevronDown } from '@lucide/vue';
import {
  ComboboxAnchor,
  ComboboxContent,
  ComboboxEmpty,
  ComboboxInput,
  ComboboxItem,
  ComboboxItemIndicator,
  ComboboxPortal,
  ComboboxRoot,
  ComboboxTrigger,
  ComboboxViewport,
} from 'reka-ui';
import { computed, ref } from 'vue';
import { cn } from '@/lib/utils';

type Option = string | { label: string; value: string };

const props = defineProps<{
  options: Option[];
  placeholder?: string;
  disabled?: boolean;
  class?: string;
}>();
const model = defineModel<string | undefined>();

// 入力中の検索文字。`ComboboxInput` の v-model に束縛し, 前方一致の照合に使う。
const search = ref('');

const normalized = computed(() =>
  props.options.map((o) => (typeof o === 'string' ? { label: o, value: o } : o)),
);

// `value` (コード) への前方一致のみ。`label` (ファンド名等) では照合しない。空入力は全件。
const filtered = computed(() => {
  const q = search.value.trim().toLowerCase();
  if (!q) return normalized.value;
  return normalized.value.filter((o) => o.value.toLowerCase().startsWith(q));
});

// blur 後の表示。選択中 value をその `label` に解決し, 未確定の検索文字を現選択へ戻す
// (`resetSearchTermOnBlur` 既定 true との合わせ技)。未収録なら value をそのまま見せる。
function displayValue(value: unknown): string {
  if (value == null || value === '') return '';
  return normalized.value.find((o) => o.value === value)?.label ?? String(value);
}
</script>

<template>
  <!-- `open-on-focus`/`open-on-click`: `Select` と同じく入力欄クリックで全候補を開く
       (Combobox 既定は false で, タイプかトグル押下まで開かない)。`ignore-filter` で reka
       既定の部分一致を切り, `filtered` の前方一致だけを描画する。 -->
  <ComboboxRoot
    v-model="model"
    :disabled="disabled"
    :ignore-filter="true"
    :open-on-focus="true"
    :open-on-click="true"
  >
    <ComboboxAnchor
      :class="
        cn(
          'flex h-9 w-full items-center justify-between rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-sm transition-colors duration-150 hover:border-ring/40 focus-within:outline-none focus-within:ring-2 focus-within:ring-ring focus-within:ring-offset-1 focus-within:ring-offset-background data-[disabled]:cursor-not-allowed data-[disabled]:opacity-50',
          $props.class,
        )
      "
    >
      <!-- 長い選択値(ファンド名等)は折り返さず 1 行で表示。入力欄なので横スクロールは
           ブラウザ既定に任せ、`Select.vue` 同様プレースホルダは淡色にする。 -->
      <ComboboxInput
        v-model="search"
        :placeholder="placeholder ?? '選択'"
        :display-value="displayValue"
        :disabled="disabled"
        class="min-w-0 flex-1 bg-transparent text-left outline-none placeholder:text-muted-foreground disabled:cursor-not-allowed"
      />
      <ComboboxTrigger class="shrink-0" :disabled="disabled">
        <ChevronDown class="h-4 w-4 opacity-50" />
      </ComboboxTrigger>
    </ComboboxAnchor>
    <ComboboxPortal>
      <ComboboxContent
        position="popper"
        :side-offset="4"
        class="z-50 max-h-72 min-w-[8rem] max-w-[calc(100vw-2rem)] overflow-auto rounded-md border bg-popover text-popover-foreground shadow-md data-[state=open]:animate-in data-[state=open]:fade-in-0 data-[state=open]:zoom-in-95 data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=closed]:zoom-out-95 data-[side=bottom]:slide-in-from-top-2 data-[side=top]:slide-in-from-bottom-2"
      >
        <ComboboxViewport class="p-1">
          <ComboboxItem
            v-for="opt in filtered"
            :key="opt.value"
            :value="opt.value"
            class="relative flex w-full cursor-pointer select-none items-center whitespace-nowrap rounded-sm py-1.5 pl-8 pr-2 text-sm outline-none data-[highlighted]:bg-accent data-[highlighted]:text-accent-foreground data-[disabled]:pointer-events-none data-[disabled]:opacity-50"
          >
            <span class="absolute left-2 flex h-3.5 w-3.5 items-center justify-center">
              <ComboboxItemIndicator><Check class="h-4 w-4" /></ComboboxItemIndicator>
            </span>
            {{ opt.label }}
          </ComboboxItem>
          <ComboboxEmpty class="py-2 text-center text-sm text-muted-foreground">
            該当なし
          </ComboboxEmpty>
        </ComboboxViewport>
      </ComboboxContent>
    </ComboboxPortal>
  </ComboboxRoot>
</template>
