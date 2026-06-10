<script setup lang="ts">
import {
  FilePlus2,
  FileText,
  GitCompare,
  History,
  LogOut,
  Moon,
  Pencil,
  Shield,
  Sun,
} from '@lucide/vue';
import { computed } from 'vue';
import { RouterLink, RouterView, useRoute, useRouter } from 'vue-router';
import Button from '@/components/ui/Button.vue';
import { theme, toggleTheme } from '@/lib/theme';
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
</script>

<template>
  <div class="min-h-screen bg-muted/30">
    <header class="border-b bg-card print:hidden">
      <div class="mx-auto flex h-14 max-w-7xl items-center gap-4 px-4">
        <div class="flex shrink-0 items-center gap-2 font-semibold text-primary">
          <FileText class="h-5 w-5" />
          <span class="hidden sm:inline">テンプレート編集</span>
        </div>
        <div class="ml-auto flex items-center gap-2">
          <RouterLink v-if="auth.isAdmin" :to="{ name: 'admin' }">
            <Button variant="outline" size="sm">
              <Shield class="h-4 w-4" /> 管理者
            </Button>
          </RouterLink>
          <Button
            variant="ghost"
            size="icon"
            :title="theme === 'dark' ? 'ライトモードに切替' : 'ダークモードに切替'"
            :aria-label="theme === 'dark' ? 'ライトモードに切替' : 'ダークモードに切替'"
            @click="toggleTheme"
          >
            <Sun v-if="theme === 'dark'" class="h-4 w-4" />
            <Moon v-else class="h-4 w-4" />
          </Button>
          <div class="ml-1 flex items-center gap-2 border-l pl-3">
            <span class="hidden text-sm font-medium sm:inline">{{ auth.user?.displayName }}</span>
            <Button variant="ghost" size="icon" title="ログアウト" aria-label="ログアウト" @click="logout">
              <LogOut class="h-4 w-4" />
            </Button>
          </div>
        </div>
      </div>
    </header>
    <nav class="border-b bg-card print:hidden">
      <div class="mx-auto flex max-w-7xl items-center gap-1 overflow-x-auto px-4 py-2">
        <RouterLink
          v-for="t in tabs"
          :key="t.name"
          :to="{ name: t.name }"
          :aria-current="activeName === t.name ? 'page' : undefined"
          :class="
            cn(
              'flex items-center gap-1.5 rounded-md px-3 py-1.5 text-sm font-medium transition-colors',
              activeName === t.name
                ? 'bg-primary/10 text-primary'
                : 'text-muted-foreground hover:bg-accent hover:text-accent-foreground',
            )
          "
        >
          <component :is="t.icon" class="h-4 w-4" />
          {{ t.label }}
        </RouterLink>
      </div>
    </nav>
    <main class="mx-auto max-w-7xl p-4">
      <RouterView />
    </main>
  </div>
</template>
