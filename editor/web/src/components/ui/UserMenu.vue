<script setup lang="ts">
import type { User } from '@editor/shared';
import { ChevronDown, LogOut, Shield } from '@lucide/vue';
import {
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuPortal,
  DropdownMenuRoot,
  DropdownMenuTrigger,
} from 'reka-ui';
import { computed } from 'vue';
import { ROLE_LABELS } from '@/lib/labels';

const props = defineProps<{ user: User; isAdmin?: boolean }>();
const emit = defineEmits<{ logout: []; admin: [] }>();

const initial = computed(() => props.user.displayName.slice(0, 1));
</script>

<template>
  <DropdownMenuRoot>
    <DropdownMenuTrigger
      class="ring-focus flex h-9 items-center gap-2 rounded-md border border-border bg-card py-0 pl-1.5 pr-2 outline-none"
    >
      <span
        class="grid h-[26px] w-[26px] place-items-center rounded-full bg-primary-soft text-[12.5px] font-bold text-primary"
      >
        {{ initial }}
      </span>
      <span class="text-[13px] font-semibold text-foreground">{{ user.displayName }}</span>
      <ChevronDown class="h-3.5 w-3.5 text-muted-foreground" />
    </DropdownMenuTrigger>
    <DropdownMenuPortal>
      <DropdownMenuContent
        align="end"
        :side-offset="6"
        class="z-50 w-[200px] rounded-[11px] border bg-card p-1.5 text-card-foreground shadow-[var(--shadow-lg)] data-[state=open]:animate-in data-[state=open]:fade-in-0 data-[state=open]:zoom-in-95 data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=closed]:zoom-out-95"
      >
        <div class="mb-1 border-b px-2.5 pb-2.5 pt-2">
          <div class="text-[13px] font-bold">{{ user.displayName }}</div>
          <div class="mt-0.5 text-[11.5px] text-muted-foreground">
            <span class="mono">{{ user.username }}</span> ・ {{ ROLE_LABELS[user.role] }}
          </div>
        </div>
        <DropdownMenuItem
          v-if="isAdmin"
          class="flex cursor-pointer select-none items-center gap-2.5 rounded-[7px] px-2.5 py-2 text-[13px] font-medium outline-none data-[highlighted]:bg-accent"
          @select="emit('admin')"
        >
          <Shield class="h-[15px] w-[15px]" /> ユーザー管理
        </DropdownMenuItem>
        <DropdownMenuItem
          class="flex cursor-pointer select-none items-center gap-2.5 rounded-[7px] px-2.5 py-2 text-[13px] font-medium text-destructive outline-none data-[highlighted]:bg-accent"
          @select="emit('logout')"
        >
          <LogOut class="h-[15px] w-[15px]" /> ログアウト
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenuPortal>
  </DropdownMenuRoot>
</template>
