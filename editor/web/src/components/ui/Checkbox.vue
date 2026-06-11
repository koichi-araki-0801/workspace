<script setup lang="ts">
import { Check } from '@lucide/vue';
import { CheckboxIndicator, CheckboxRoot } from 'reka-ui';
import { cn } from '@/lib/utils';

defineProps<{ class?: string; id?: string; disabled?: boolean }>();
const model = defineModel<boolean>();
</script>

<template>
  <CheckboxRoot
    :id="id"
    v-model="model"
    :disabled="disabled"
    :class="
      cn(
        'peer h-4 w-4 shrink-0 cursor-pointer rounded-sm border border-input shadow-sm transition-colors duration-150 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-background disabled:cursor-not-allowed disabled:opacity-50 data-[state=checked]:border-primary data-[state=checked]:bg-primary data-[state=checked]:text-primary-foreground',
        $props.class,
      )
    "
  >
    <CheckboxIndicator class="flex items-center justify-center text-current">
      <Check class="h-3.5 w-3.5" />
    </CheckboxIndicator>
  </CheckboxRoot>
</template>
