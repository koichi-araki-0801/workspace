<script setup lang="ts">
// =============================================================================
// UserMenu.vue — ログインユーザーのドロップダウンメニュー(管理画面/ログアウト)
// =============================================================================
import type { User } from '@editor/shared';
import { ChevronDown, LogOut, Shield } from '@lucide/vue';
import { computed } from 'vue';
import { ROLE_LABELS } from '@/lib/labels';
import { DropdownMenu, DropdownMenuItem } from './overlays';

const props = defineProps<{ user: User; isAdmin?: boolean }>();
const emit = defineEmits<{ logout: []; admin: [] }>();

const initial = computed(() => props.user.displayName.slice(0, 1));
</script>

<template>
  <DropdownMenu>
    <template #trigger>
      <button
        type="button"
        class="ring-focus flex h-9 items-center gap-2 rounded-md border border-border bg-card py-0 pl-1.5 pr-2 outline-none"
      >
        <span
          class="grid h-[26px] w-[26px] place-items-center rounded-full bg-primary-soft text-[12.5px] font-bold text-primary"
        >
          {{ initial }}
        </span>
        <span class="text-[13px] font-semibold text-foreground">{{ user.displayName }}</span>
        <ChevronDown class="h-3.5 w-3.5 text-muted-foreground" />
      </button>
    </template>
    <div class="mb-1 border-b px-2.5 pb-2.5 pt-2">
      <div class="text-[13px] font-bold">{{ user.displayName }}</div>
      <div class="mt-0.5 text-[11.5px] text-muted-foreground">
        <span class="mono">{{ user.username }}</span> ・ {{ ROLE_LABELS[user.role] }}
      </div>
    </div>
    <DropdownMenuItem v-if="isAdmin" @select="emit('admin')">
      <Shield class="h-[15px] w-[15px]" /> ユーザー管理
    </DropdownMenuItem>
    <DropdownMenuItem class="text-destructive" @select="emit('logout')">
      <LogOut class="h-[15px] w-[15px]" /> ログアウト
    </DropdownMenuItem>
  </DropdownMenu>
</template>
