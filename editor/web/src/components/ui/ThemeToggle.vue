<script setup lang="ts">
import { Moon, Sun } from '@lucide/vue';
import { theme, toggleTheme } from '@/lib/theme';
</script>

<template>
  <button
    type="button"
    class="ring-focus grid h-9 w-9 place-items-center rounded-[9px] border border-border bg-card text-muted-foreground transition-colors hover:bg-accent"
    aria-label="テーマを切替"
    :title="theme === 'dark' ? 'ライトモードに切替' : 'ダークモードに切替'"
    @click="toggleTheme"
  >
    <Sun v-if="theme === 'dark'" class="h-[17px] w-[17px]" />
    <Moon v-else class="h-[17px] w-[17px]" />
  </button>
</template>
