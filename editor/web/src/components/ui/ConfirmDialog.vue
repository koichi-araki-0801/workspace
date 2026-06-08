<script setup lang="ts">
import {
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogOverlay,
  AlertDialogPortal,
  AlertDialogRoot,
  AlertDialogTitle,
} from 'reka-ui';
import { computed } from 'vue';
import { buttonVariants } from './Button.vue';
import { confirmState, resolveConfirm } from './confirm';

const open = computed({
  get: () => confirmState.value.open,
  // reka emits update when dismissed via Esc / overlay → treat as cancel
  set: (v: boolean) => {
    if (!v) resolveConfirm(false);
  },
});
</script>

<template>
  <AlertDialogRoot v-model:open="open">
    <AlertDialogPortal>
      <AlertDialogOverlay
        class="fixed inset-0 z-[90] bg-black/40 data-[state=open]:animate-in data-[state=open]:fade-in"
      />
      <AlertDialogContent
        class="fixed left-1/2 top-1/2 z-[100] w-[calc(100%-2rem)] max-w-md -translate-x-1/2 -translate-y-1/2 rounded-xl border bg-card p-6 text-card-foreground shadow-lg focus:outline-none data-[state=open]:animate-in data-[state=open]:fade-in data-[state=open]:zoom-in-95"
      >
        <AlertDialogTitle class="text-base font-semibold">
          {{ confirmState.title }}
        </AlertDialogTitle>
        <AlertDialogDescription
          v-if="confirmState.description"
          class="mt-2 text-sm text-muted-foreground"
        >
          {{ confirmState.description }}
        </AlertDialogDescription>
        <div class="mt-6 flex justify-end gap-2">
          <AlertDialogCancel
            :class="buttonVariants({ variant: 'outline', size: 'sm' })"
            @click="resolveConfirm(false)"
          >
            {{ confirmState.cancelLabel }}
          </AlertDialogCancel>
          <AlertDialogAction
            :class="buttonVariants({ variant: confirmState.variant === 'destructive' ? 'destructive' : 'default', size: 'sm' })"
            @click="resolveConfirm(true)"
          >
            {{ confirmState.confirmLabel }}
          </AlertDialogAction>
        </div>
      </AlertDialogContent>
    </AlertDialogPortal>
  </AlertDialogRoot>
</template>
