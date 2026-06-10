<script lang="ts">
import { cva, type VariantProps } from 'class-variance-authority';

export const badgeVariants = cva(
  'inline-flex items-center rounded-md border px-2.5 py-0.5 text-xs font-semibold transition-colors',
  {
    variants: {
      variant: {
        default: 'border-transparent bg-primary text-primary-foreground',
        secondary: 'border-secondary-foreground/20 bg-secondary text-secondary-foreground',
        destructive: 'border-transparent bg-destructive text-destructive-foreground',
        success: 'border-transparent bg-success text-success-foreground',
        warning: 'border-transparent bg-warning text-warning-foreground',
        outline: 'text-foreground',
      },
    },
    defaultVariants: { variant: 'default' },
  },
);
export type BadgeVariants = VariantProps<typeof badgeVariants>;
</script>

<script setup lang="ts">
import { cn } from '@/lib/utils';

defineProps<{ variant?: BadgeVariants['variant']; class?: string }>();
</script>

<template>
  <span :class="cn(badgeVariants({ variant }), $props.class)"><slot /></span>
</template>
