<script setup lang="ts">
// =============================================================================
// BackButton.vue — アプリ内履歴を辿る戻るボタン(履歴が無ければ fallback へ)
// =============================================================================
import { ArrowLeft } from '@lucide/vue';
import { type RouteLocationRaw, useRouter } from 'vue-router';
import Button from './Button.vue';

const props = defineProps<{
  /** アプリ内履歴が無い時の遷移先(論理的な親 / ホーム)。 */
  fallback: RouteLocationRaw;
  /** アイコン横に表示する可視ラベル(任意)。 */
  label?: string;
  /** アクセシビリティ用ラベル。可視ラベルが無い場合は必須。 */
  ariaLabel?: string;
}>();

const router = useRouter();

function goBack() {
  // `createWebHistory` は直前のエントリを `window.history.state.back` に保持する。
  if (window.history.state?.back != null) router.back();
  else router.push(props.fallback);
}
</script>

<template>
  <Button
    variant="ghost"
    :size="label ? 'sm' : 'icon'"
    :aria-label="ariaLabel ?? label"
    @click="goBack"
  >
    <ArrowLeft class="h-4 w-4" />
    <span v-if="label">{{ label }}</span>
  </Button>
</template>
