<script setup lang="ts">
// =============================================================================
// ConfirmDialog.vue — `confirm.ts` の `confirmState` を描画する単一の確認ダイアログ
// =============================================================================
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
  // `reka-ui` は Esc / overlay クリックでの dismiss 時に update を emit する → キャンセル扱い。
  set: (v: boolean) => {
    if (!v) resolveConfirm(false);
  },
});
</script>

<template>
  <AlertDialogRoot v-model:open="open">
    <AlertDialogPortal>
      <AlertDialogOverlay
        class="fixed inset-0 z-[90] bg-black/50 data-[state=open]:animate-in data-[state=open]:fade-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0"
      />
      <AlertDialogContent
        class="fixed left-1/2 top-1/2 z-[100] w-[calc(100%-2rem)] max-w-md -translate-x-1/2 -translate-y-1/2 rounded-xl border bg-card p-6 text-card-foreground shadow-lg duration-200 focus:outline-none data-[state=open]:animate-in data-[state=open]:fade-in data-[state=open]:zoom-in-95 data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=closed]:zoom-out-95"
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
          <!-- capture フェーズで解決する: `reka-ui` はボタンの click 後に `update:open`(=false)
               を bubble で出し、それが下の `open` setter 経由で resolveConfirm(false) を先に
               走らせてしまう。capture で先に確定値を resolve しておけば、後続の close は
               resolve 済み(no-op)となり、確定ボタンが常に false になる不具合を防ぐ。 -->
          <AlertDialogCancel
            :class="buttonVariants({ variant: 'outline', size: 'sm' })"
            @click.capture="resolveConfirm(false)"
          >
            {{ confirmState.cancelLabel }}
          </AlertDialogCancel>
          <AlertDialogAction
            :class="buttonVariants({ variant: confirmState.variant === 'destructive' ? 'destructive' : 'default', size: 'sm' })"
            @click.capture="resolveConfirm(true)"
          >
            {{ confirmState.confirmLabel }}
          </AlertDialogAction>
        </div>
      </AlertDialogContent>
    </AlertDialogPortal>
  </AlertDialogRoot>
</template>
