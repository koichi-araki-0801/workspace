<script setup lang="ts">
import { ArrowLeft } from 'lucide-vue-next';
import { type RouteLocationRaw, useRouter } from 'vue-router';
import Button from './Button.vue';

const props = defineProps<{
  /** Destination when there is no in-app history to go back to (logical parent / home). */
  fallback: RouteLocationRaw;
  /** Optional visible label shown next to the icon. */
  label?: string;
  /** Accessibility label; required when no visible label is given. */
  ariaLabel?: string;
}>();

const router = useRouter();

function goBack() {
  // createWebHistory keeps the previous entry in window.history.state.back.
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
