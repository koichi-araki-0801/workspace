<script setup lang="ts">
// =============================================================================
// ShortcutHelpDialog.vue — キーボードショートカット一覧のモーダル
// =============================================================================
// `?` キー / 上部バーのヘルプボタンから開く。一覧の単一情報源は
// `useEditorShortcuts.ts` の `SHORTCUT_LIST`(キー変更時はそちらを更新する)。
import { X } from '@lucide/vue';
import {
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogOverlay,
  DialogPortal,
  DialogRoot,
  DialogTitle,
} from 'reka-ui';
import { SHORTCUT_LIST } from './useEditorShortcuts';

const open = defineModel<boolean>('open', { default: false });
</script>

<template>
  <DialogRoot v-model:open="open">
    <DialogPortal>
      <DialogOverlay
        class="fixed inset-0 z-[90] bg-black/50 data-[state=open]:animate-in data-[state=open]:fade-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0"
      />
      <DialogContent
        class="fixed left-1/2 top-1/2 z-[100] w-[calc(100%-2rem)] max-w-sm -translate-x-1/2 -translate-y-1/2 rounded-xl border bg-card p-6 text-card-foreground shadow-lg duration-200 focus:outline-none data-[state=open]:animate-in data-[state=open]:fade-in data-[state=open]:zoom-in-95 data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=closed]:zoom-out-95"
      >
        <DialogTitle class="text-base font-semibold">キーボードショートカット</DialogTitle>
        <DialogDescription class="mt-1 text-xs text-muted-foreground">
          テキスト編集中は元に戻す・削除などがテキスト側に効きます。
        </DialogDescription>
        <ul class="mt-4 space-y-2.5">
          <li
            v-for="s in SHORTCUT_LIST"
            :key="s.label"
            class="flex items-center justify-between gap-4 text-sm"
          >
            <span>
              {{ s.label }}
              <span v-if="s.note" class="ml-1 text-[11px] text-muted-foreground">（{{ s.note }}）</span>
            </span>
            <span class="flex shrink-0 items-center gap-1">
              <kbd
                v-for="k in s.keys"
                :key="k"
                class="rounded border border-border bg-muted px-1.5 py-0.5 text-[11px] font-medium text-foreground shadow-sm"
              >{{ k }}</kbd>
            </span>
          </li>
        </ul>
        <DialogClose
          class="absolute right-4 top-4 rounded text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          aria-label="閉じる"
        >
          <X class="h-4 w-4" />
        </DialogClose>
      </DialogContent>
    </DialogPortal>
  </DialogRoot>
</template>
