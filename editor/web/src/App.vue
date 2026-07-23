<script setup lang="ts">
// =============================================================================
// App.vue — アプリのルートシェル(`RouterView` + グローバルオーバーレイ)
// =============================================================================
// 画面本体は `RouterView` が描画し、`Toaster`/`ConfirmDialog` は全画面共通の
// オーバーレイとして常駐させる。`TooltipProvider` は `ui/overlays.ts` の `Tooltip` の
// 必須祖先(無いと reka-ui が throw)なので、ルートで全画面を包む。delay 300ms は
// ツールバー操作の邪魔にならない範囲で素早くヒントを出す妥協点。
import { TooltipProvider } from 'reka-ui';
import { RouterView } from 'vue-router';
import ConfirmDialog from '@/components/ui/ConfirmDialog.vue';
import Toaster from '@/components/ui/Toaster.vue';
</script>

<template>
  <TooltipProvider :delay-duration="300">
    <RouterView />
    <Toaster />
    <ConfirmDialog />
  </TooltipProvider>
</template>
