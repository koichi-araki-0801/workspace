<script setup lang="ts">
import { watch } from 'vue';
import { useFundNames } from '@/lib/useFundNames';

/**
 * ファンドコード(等幅)＋解決済みのファンド名(淡色)を並べて表示する共有表示部品。
 * 名前は {@link useFundNames}(モジュールキャッシュ)で best-effort 解決し、未収録なら
 * コードのみ表示する。一覧の各セルで使っても重複 fetch は起きない。
 */
const props = defineProps<{ code: string }>();
const { resolve, nameOf } = useFundNames();
watch(() => props.code, (c) => resolve([c]), { immediate: true });
</script>

<template>
  <span class="mono font-medium">{{ code }}</span>
  <span v-if="nameOf(code)" class="ml-2 text-sm text-muted-foreground">{{ nameOf(code) }}</span>
</template>
