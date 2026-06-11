<script setup lang="ts">
import { CircleAlert, CircleCheck, X } from '@lucide/vue';
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
            'pointer-events-auto flex w-full items-start gap-3 rounded-md border border-l-4 bg-card px-4 py-3 text-sm text-card-foreground shadow-lg',
            t.variant === 'success' && 'border-l-success',
            t.variant === 'error' && 'border-l-destructive',
            t.variant === 'default' && 'border-l-primary',
          )
        "
      >
        <CircleCheck v-if="t.variant === 'success'" class="mt-0.5 h-4 w-4 shrink-0 text-success" />
        <CircleAlert v-else-if="t.variant === 'error'" class="mt-0.5 h-4 w-4 shrink-0 text-destructive" />
        <span class="flex-1">{{ t.message }}</span>
        <button
          type="button"
          class="-mr-1 mt-0.5 shrink-0 rounded text-muted-foreground transition-colors duration-150 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          aria-label="閉じる"
          @click="dismissToast(t.id)"
        >
          <X class="h-3.5 w-3.5" />
        </button>
      </div>
    </TransitionGroup>
  </div>
</template>
