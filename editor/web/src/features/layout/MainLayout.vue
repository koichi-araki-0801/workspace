<script setup lang="ts">
// =============================================================================
// MainLayout.vue — アプリ共通シェル(ヘッダ/タブナビ/`RouterView`)
// =============================================================================
import { FilePlus2, FileText, GitCompare, History, Pencil, Shield } from '@lucide/vue';
import { computed } from 'vue';
import { RouterLink, RouterView, useRoute, useRouter } from 'vue-router';
import Button from '@/components/ui/Button.vue';
import ThemeToggle from '@/components/ui/ThemeToggle.vue';
import UserMenu from '@/components/ui/UserMenu.vue';
import { cn } from '@/lib/utils';
import { useAuthStore } from '@/stores/auth';

const auth = useAuthStore();
const route = useRoute();
const router = useRouter();

const tabs = [
  { name: 'edit', label: '編集', icon: Pencil },
  { name: 'create', label: 'テンプレート作成', icon: FilePlus2 },
  { name: 'compare', label: '比較', icon: GitCompare },
  { name: 'history', label: '履歴', icon: History },
];

const activeName = computed(() => route.name);

async function logout() {
  await auth.logout();
  router.push({ name: 'login' });
}

function goAdmin() {
  router.push({ name: 'admin' });
}
</script>

<template>
  <div class="min-h-screen bg-muted/40">
    <header class="border-b bg-card print:hidden">
      <div class="mx-auto flex h-14 max-w-[1180px] items-center gap-4 px-5">
        <div class="flex shrink-0 items-baseline gap-2 font-bold text-primary">
          <FileText class="h-5 w-5 self-center" />
          <span class="text-base tracking-[0.1em]">RET</span>
          <span class="whitespace-nowrap text-xs font-semibold tracking-[0.02em] text-muted-foreground">
            Report Edit Tool
          </span>
        </div>
        <div class="ml-auto flex items-center gap-2.5">
          <RouterLink v-if="auth.isAdmin" :to="{ name: 'admin' }">
            <Button variant="outline" size="sm">
              <Shield class="h-4 w-4" /> 管理者
            </Button>
          </RouterLink>
          <ThemeToggle />
          <UserMenu
            v-if="auth.user"
            :user="auth.user"
            :is-admin="auth.isAdmin"
            @admin="goAdmin"
            @logout="logout"
          />
        </div>
      </div>
      <nav class="border-t">
        <div class="mx-auto flex max-w-[1180px] items-center gap-1 overflow-x-auto px-5 py-2">
          <RouterLink
            v-for="t in tabs"
            :key="t.name"
            :to="{ name: t.name }"
            :aria-current="activeName === t.name ? 'page' : undefined"
            :class="
              cn(
                'ring-focus flex items-center gap-1.5 whitespace-nowrap rounded-lg px-3.5 py-1.5 text-[13.5px] font-semibold transition-colors',
                activeName === t.name
                  ? 'bg-primary-soft text-primary'
                  : 'text-muted-foreground hover:bg-accent hover:text-accent-foreground',
              )
            "
          >
            <component :is="t.icon" class="h-4 w-4" />
            {{ t.label }}
          </RouterLink>
        </div>
      </nav>
    </header>
    <main class="mx-auto max-w-[1180px] px-5 pb-16 pt-6">
      <RouterView />
    </main>
  </div>
</template>
