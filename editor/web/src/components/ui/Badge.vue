<script lang="ts">
import { cva, type VariantProps } from 'class-variance-authority';

const badgeVariants = cva(
  'inline-flex items-center rounded-md border px-2.5 py-0.5 text-xs font-semibold transition-colors',
  {
    variants: {
      variant: {
        default: 'border-transparent bg-primary text-primary-foreground',
        secondary: 'border-secondary-foreground/20 bg-secondary text-secondary-foreground',
        destructive: 'border-transparent bg-destructive text-destructive-foreground',
        success: 'border-transparent bg-success text-success-foreground',
        warning: 'border-warning/30 bg-warning/15 text-warning-foreground',
        outline: 'text-foreground',
      },
    },
    defaultVariants: { variant: 'default' },
  },
);
</script>

<script setup lang="ts">
// =============================================================================
// Badge.vue — `cva` variant(default/secondary/destructive/success/warning/outline)
//             でスタイル分けする小型バッジ
// =============================================================================
import { cn } from '@/lib/utils';

type BadgeVariants = VariantProps<typeof badgeVariants>;

defineProps<{ variant?: BadgeVariants['variant']; class?: string }>();
</script>

<template>
  <span :class="cn(badgeVariants({ variant }), $props.class)"><slot /></span>
</template>
