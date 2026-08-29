<script setup lang="ts">
// =============================================================================
// ShortcutHelpDialog.vue — キーボードショートカット一覧のモーダル
// =============================================================================
// `?` キー / 上部バーのヘルプボタンから開く。一覧の単一情報源は
// `useEditorShortcuts.ts` の `SHORTCUT_LIST`(キー変更時はそちらを更新する)。
import { Dialog } from '@/components/ui/overlays';
import { SHORTCUT_LIST } from './useEditorShortcuts';

const open = defineModel<boolean>('open', { default: false });
</script>

<template>
  <Dialog
    v-model:open="open"
    size="sm"
    title="キーボードショートカット"
    description="テキスト編集中は元に戻す・削除などがテキスト側に効きます。"
  >
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
  </Dialog>
</template>
