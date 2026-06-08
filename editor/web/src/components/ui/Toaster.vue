<script setup lang="ts">
import { X } from 'lucide-vue-next';
import { cn } from '@/lib/utils';
import { dismissToast, toasts } from './toast';
</script>

<template>
  <div
    class="pointer-events-none fixed bottom-4 right-4 z-[120] flex w-[min(92vw,22rem)] flex-col gap-2"
    aria-live="polite"
    aria-atomic="false"
  >
    <TransitionGroup
      enter-active-class="transition duration-200 ease-out"
      enter-from-class="translate-y-2 opacity-0"
      enter-to-class="translate-y-0 opacity-100"
      leave-active-class="transition duration-150 ease-in absolute"
      leave-from-class="opacity-100"
      leave-to-class="opacity-0"
    >
      <div
        v-for="t in toasts"
        :key="t.id"
        :role="t.variant === 'error' ? 'alert' : 'status'"
        :class="
          cn(
            'pointer-events-auto flex items-start gap-2 rounded-md border px-4 py-3 text-sm shadow-lg',
            t.variant === 'success' && 'border-success/30 bg-success text-success-foreground',
            t.variant === 'error' && 'border-destructive/30 bg-destructive text-destructive-foreground',
            t.variant === 'default' && 'bg-card text-card-foreground',
          )
        "
      >
        <span class="flex-1">{{ t.message }}</span>
        <button
          type="button"
          class="-mr-1 mt-0.5 shrink-0 rounded opacity-70 transition-opacity hover:opacity-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-current"
          aria-label="閉じる"
          @click="dismissToast(t.id)"
        >
          <X class="h-3.5 w-3.5" />
        </button>
      </div>
    </TransitionGroup>
  </div>
</template>
