<script setup lang="ts">
import { RouterView } from 'vue-router';
import ConfirmDialog from '@/components/ui/ConfirmDialog.vue';
import Toaster from '@/components/ui/Toaster.vue';
</script>

<template>
  <RouterView />
  <Toaster />
  <ConfirmDialog />
</template>
