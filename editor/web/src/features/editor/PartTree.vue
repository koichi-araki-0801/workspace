<script setup lang="ts">
import type { PartCatalogItem } from '@editor/shared';
import { Check, Lock, Wand2 } from '@lucide/vue';
import PartCatalog from './PartCatalog.vue';

const editMode = defineModel<boolean>('editMode', { default: false });
const emit = defineEmits<{ select: [PartCatalogItem]; insert: [PartCatalogItem] }>();
</script>

<template>
  <nav class="flex w-[272px] shrink-0 flex-col overflow-hidden border-r bg-card">
    <div class="flex h-[46px] shrink-0 items-center gap-2 border-b px-3.5">
      <Wand2 class="h-[15px] w-[15px] text-primary" />
      <span class="text-[12.5px] font-bold text-foreground">パーツ追加</span>
    </div>

    <!-- allow add/edit toggle -->
    <button
      type="button"
      class="flex items-start gap-2.5 border-b px-3.5 py-3 text-left transition-colors"
      :class="editMode ? 'bg-primary-soft/50' : ''"
      :aria-pressed="editMode"
      @click="editMode = !editMode"
    >
      <span
        class="mt-px grid h-[18px] w-[18px] shrink-0 place-items-center rounded-[5px] border-[1.5px] transition-colors"
        :class="editMode ? 'border-primary bg-primary text-primary-foreground' : 'border-input bg-card'"
      >
        <Check v-if="editMode" class="h-3 w-3" />
      </span>
      <span class="flex-1">
        <span class="block text-[12.5px] font-semibold text-foreground">パーツの追加・編集を許可</span>
        <span class="mt-0.5 block text-[11px] leading-snug text-muted-foreground">
          {{ editMode ? '分類から選んでパーツを挿入できます' : 'チェックを入れると追加メニューを表示' }}
        </span>
      </span>
    </button>

    <!-- OFF: locked hint -->
    <div
      v-if="!editMode"
      class="grid flex-1 place-items-center px-6 text-center text-muted-foreground"
    >
      <div>
        <Lock class="mx-auto mb-2.5 h-6 w-6 opacity-40" />
        <p class="text-[12.5px] leading-relaxed">
          パーツの追加はオフです。<br />レイアウト調整はキャンバスで、<br />パーツを選んで行えます。
        </p>
      </div>
    </div>

    <!-- ON: existing cascading catalog -->
    <div v-else class="flex-1 overflow-hidden">
      <PartCatalog @select="emit('select', $event)" @insert="emit('insert', $event)" />
    </div>
  </nav>
</template>
