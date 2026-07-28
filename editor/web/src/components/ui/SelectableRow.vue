<script lang="ts">
import { cva } from 'class-variance-authority';

// チェック ON/OFF で行の背景と、左の角丸チェックマークの塗りを切り替える。元の
// `PartTree` の 2 トグルが持っていた `checked` 分岐 (行 `bg-primary-soft/50` とマークの
// 塗り) を `cva` へ畳み込む。px 値・flex 構造はズーム堅牢性に直結するため厳密に温存する。
const selectableRowVariants = cva(
  'flex items-start gap-2.5 border-b px-3.5 py-3 text-left transition-colors',
  {
    variants: { checked: { true: 'bg-primary-soft/50', false: '' } },
    defaultVariants: { checked: false },
  },
);

// 左端の角丸チェックマーク (18px 角)。ON で primary 塗り、OFF で枠のみ。
const selectableRowMark = cva(
  'mt-px grid h-[18px] w-[18px] shrink-0 place-items-center rounded-[5px] border-[1.5px] transition-colors',
  {
    variants: { checked: { true: 'border-primary bg-primary text-primary-foreground', false: 'border-input bg-card' } },
    defaultVariants: { checked: false },
  },
);
</script>

<script setup lang="ts">
// =============================================================================
// SelectableRow.vue — チェックマーク + タイトル + 説明文のトグル行 (`button`)
// =============================================================================
// `PartTree` の「編集を許可 / パーツを追加」など、行全体がトグルになる項目を集約する。
// `title` は見出し、既定 slot に説明文 (ON/OFF で文言が変わる動的テキスト) を渡す。
import { Check } from '@lucide/vue';
import { cn } from '@/lib/utils';

defineProps<{ checked?: boolean; title: string; class?: string }>();
defineEmits<{ toggle: [] }>();
</script>

<template>
  <button
    type="button"
    :class="cn(selectableRowVariants({ checked }), $props.class)"
    :aria-pressed="checked"
    @click="$emit('toggle')"
  >
    <span :class="selectableRowMark({ checked })">
      <Check v-if="checked" class="h-3 w-3" />
    </span>
    <span class="flex-1">
      <span class="block text-[12.5px] font-semibold text-foreground">{{ title }}</span>
      <span class="mt-0.5 block text-[11px] leading-snug text-muted-foreground">
        <slot />
      </span>
    </span>
  </button>
</template>
