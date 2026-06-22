<script setup lang="ts">
// =============================================================================
// Select.vue — `reka-ui` の Select プリミティブを束ねたセレクトボックス
// =============================================================================
// `options` は文字列か `{ label, value }` を受け、`normalized` で後者へ揃える。
import { Check, ChevronDown } from '@lucide/vue';
import {
  SelectContent,
  SelectIcon,
  SelectItem,
  SelectItemIndicator,
  SelectItemText,
  SelectPortal,
  SelectRoot,
  SelectTrigger,
  SelectValue,
  SelectViewport,
} from 'reka-ui';
import { computed } from 'vue';
import { cn } from '@/lib/utils';

type Option = string | { label: string; value: string };

const props = defineProps<{
  options: Option[];
  placeholder?: string;
  disabled?: boolean;
  class?: string;
}>();
const model = defineModel<string | undefined>();

const normalized = computed(() =>
  props.options.map((o) => (typeof o === 'string' ? { label: o, value: o } : o)),
);
</script>

<template>
  <SelectRoot v-model="model" :disabled="disabled">
    <SelectTrigger
      :class="
        cn(
          'flex h-9 w-full cursor-pointer items-center justify-between rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-sm transition-colors duration-150 hover:border-ring/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-background disabled:cursor-not-allowed disabled:opacity-50 data-[placeholder]:text-muted-foreground',
          $props.class,
        )
      "
    >
      <!-- 長い選択値(ファンド名等)は折り返さず 1 行のまま横スクロールで末尾まで見せる。
           `overflow-x-auto` ははみ出す時だけ細バーを出すので、短い値の見た目は不変。 -->
      <span class="min-w-0 flex-1 overflow-x-auto whitespace-nowrap text-left [scrollbar-width:thin]">
        <SelectValue :placeholder="placeholder ?? '選択'" />
      </span>
      <SelectIcon as-child><ChevronDown class="h-4 w-4 shrink-0 opacity-50" /></SelectIcon>
    </SelectTrigger>
    <SelectPortal>
      <SelectContent
        position="popper"
        :side-offset="4"
        class="z-50 max-h-72 min-w-[8rem] max-w-[calc(100vw-2rem)] overflow-auto rounded-md border bg-popover text-popover-foreground shadow-md data-[state=open]:animate-in data-[state=open]:fade-in-0 data-[state=open]:zoom-in-95 data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=closed]:zoom-out-95 data-[side=bottom]:slide-in-from-top-2 data-[side=top]:slide-in-from-bottom-2"
      >
        <SelectViewport class="p-1">
          <SelectItem
            v-for="opt in normalized"
            :key="opt.value"
            :value="opt.value"
            class="relative flex w-full cursor-pointer select-none items-center whitespace-nowrap rounded-sm py-1.5 pl-8 pr-2 text-sm outline-none data-[highlighted]:bg-accent data-[highlighted]:text-accent-foreground data-[disabled]:pointer-events-none data-[disabled]:opacity-50"
          >
            <span class="absolute left-2 flex h-3.5 w-3.5 items-center justify-center">
              <SelectItemIndicator><Check class="h-4 w-4" /></SelectItemIndicator>
            </span>
            <SelectItemText>{{ opt.label }}</SelectItemText>
          </SelectItem>
        </SelectViewport>
      </SelectContent>
    </SelectPortal>
  </SelectRoot>
</template>
