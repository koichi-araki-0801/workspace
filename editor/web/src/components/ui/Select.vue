<script setup lang="ts">
import { Check, ChevronDown } from 'lucide-vue-next';
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
          'flex h-9 w-full cursor-pointer items-center justify-between rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-sm focus:outline-none focus:ring-2 focus:ring-ring disabled:cursor-not-allowed disabled:opacity-50',
          $props.class,
        )
      "
    >
      <SelectValue :placeholder="placeholder ?? '選択'" />
      <SelectIcon as-child><ChevronDown class="h-4 w-4 opacity-50" /></SelectIcon>
    </SelectTrigger>
    <SelectPortal>
      <SelectContent
        position="popper"
        :side-offset="4"
        class="z-50 max-h-72 min-w-[8rem] overflow-hidden rounded-md border bg-popover text-popover-foreground shadow-md"
      >
        <SelectViewport class="p-1">
          <SelectItem
            v-for="opt in normalized"
            :key="opt.value"
            :value="opt.value"
            class="relative flex w-full cursor-pointer select-none items-center rounded-sm py-1.5 pl-8 pr-2 text-sm outline-none data-[highlighted]:bg-accent data-[highlighted]:text-accent-foreground"
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
