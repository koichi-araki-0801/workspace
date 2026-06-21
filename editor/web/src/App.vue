<script setup lang="ts">
// =============================================================================
// App.vue — アプリのルートシェル(`RouterView` + グローバルオーバーレイ)
// =============================================================================
// 画面本体は `RouterView` が描画し、`Toaster`/`ConfirmDialog` は全画面共通の
// オーバーレイとして常駐させる。
import { RouterView } from 'vue-router';
import ConfirmDialog from '@/components/ui/ConfirmDialog.vue';
import Toaster from '@/components/ui/Toaster.vue';
</script>

<template>
  <RouterView />
  <Toaster />
  <ConfirmDialog />
</template>
