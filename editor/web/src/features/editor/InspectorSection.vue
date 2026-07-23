<script setup lang="ts">
// =============================================================================
// InspectorSection.vue — Inspector 専用の折りたたみセクション(見出し + v-show 本文)
// =============================================================================
// 見出し(`sec-head`)クリックで開閉する。開閉状態は親(`Inspector.vue` の `open`)が
// editMode 連動で一括制御するため defineModel で双方向に持つ。見出し右側の Badge 等は
// `#badge` slot、本文は default slot(`bodyClass` で padding を指定)。
import { ChevronDown, ChevronRight } from '@lucide/vue';
import type { Component } from 'vue';

defineProps<{
  label: string;
  icon: Component;
  /** 本文コンテナのクラス(セクションごとの padding 差はここで吸収)。 */
  bodyClass?: string;
}>();

const open = defineModel<boolean>('open', { required: true });

// テンプレート内の `open = !open` は biome が global の `window.open` への代入と誤検知する
// (noGlobalAssign) ため、関数経由でトグルする。
function toggle() {
  open.value = !open.value;
}
</script>

<template>
  <section>
    <button type="button" class="sec-head" @click="toggle()">
      <component :is="open ? ChevronDown : ChevronRight" class="h-3.5 w-3.5 opacity-70" />
      <component :is="icon" class="h-3.5 w-3.5" /> {{ label }}
      <slot name="badge" />
    </button>
    <div v-show="open" :class="bodyClass">
      <slot />
    </div>
  </section>
</template>

<style scoped>
/* 折りたたみセクションの見出し(クリックで開閉) */
.sec-head {
  display: flex;
  width: 100%;
  align-items: center;
  gap: 6px;
  padding: 10px 16px;
  font-size: 11.5px;
  font-weight: 700;
  letter-spacing: 0.02em;
  color: var(--muted-foreground);
  transition: background-color 0.12s;
}
.sec-head:hover {
  background: var(--accent);
}
/* キーボード操作の現在地を可視化(見た目は index.css の `.ring-focus` と同一)。 */
.sec-head:focus-visible {
  outline: none;
  box-shadow:
    0 0 0 2px var(--background),
    0 0 0 4px color-mix(in oklab, var(--ring) 55%, transparent);
}
</style>
