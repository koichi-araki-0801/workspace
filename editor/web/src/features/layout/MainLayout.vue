<script setup lang="ts">
// =============================================================================
// MainLayout.vue — アプリ共通シェル(ヘッダ/タブナビ/`RouterView`)
// =============================================================================
import {
  ClipboardCheck,
  FilePlus2,
  FileStack,
  FileText,
  GitCompare,
  History,
  Pencil,
  Shield,
} from '@lucide/vue';
import { computed, onMounted, watch } from 'vue';
import { RouterLink, RouterView, useRoute, useRouter } from 'vue-router';
import Button from '@/components/ui/Button.vue';
import ThemeToggle from '@/components/ui/ThemeToggle.vue';
import UserMenu from '@/components/ui/UserMenu.vue';
import { cn } from '@/lib/utils';
import { useAuthStore } from '@/stores/auth';
import { usePendingReviewsStore } from '@/stores/pendingReviews';

const auth = useAuthStore();
const route = useRoute();
const router = useRouter();
const pending = usePendingReviewsStore();

// タブは作業フロー順(作業系 → 承認 → 出力/参照ツール → 履歴)。`group` の境目に区切り線を
// 挟み、日常操作(編集・作成)とワークフロー(承認)・ツール類の別を一目で分ける。
const tabs = [
  { name: 'edit', label: '編集', icon: Pencil, group: 1 },
  { name: 'create', label: 'テンプレート作成', icon: FilePlus2, group: 1 },
  { name: 'reviews', label: auth.isApprover ? '承認' : '申請状況', icon: ClipboardCheck, group: 2 },
  { name: 'merge', label: '結合PDF', icon: FileStack, group: 3 },
  { name: 'compare', label: '比較', icon: GitCompare, group: 3 },
  { name: 'history', label: '履歴', icon: History, group: 4 },
];

// 承認待ち件数バッジの更新契機。ポーリングせず、初回表示とタブ切替(route 変化)で取り直す —
// 申請/承認/却下の完了はいずれも画面遷移を伴うので、これで追随できる(軽量 GET 1 本)。
onMounted(() => void pending.refresh());
watch(
  () => route.name,
  () => void pending.refresh(),
);

// 承認待ち画面はサブ詳細(`review-detail`)でもタブを点灯させる。
const activeName = computed(() =>
  route.name === 'review-detail' ? 'reviews' : route.name,
);

async function logout() {
  await auth.logout();
  router.push({ name: 'login' });
}

function goAdmin() {
  router.push({ name: 'admin' });
}
</script>

<template>
  <!-- ヘッダ・タブ・本文の 3 か所は同じ最大幅で揃える。1320px は絞り込みバーの要件から
       決まる: 項目名つき placeholder が収まる列幅(240px)で、比較画面の最大構成である
       5 列(240px×4 + 「比較する版」220px + 間隔 48px = 1228px)を 1 行に並べるのに要る幅。
       狭めると 5 列目が次行へ落ち、編集画面では操作ボタンだけが次行へ落ちる。 -->
  <div class="min-h-screen bg-muted/40">
    <header class="border-b bg-card print:hidden">
      <div class="mx-auto flex h-14 max-w-[1400px] items-center gap-4 px-5">
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
        <div class="mx-auto flex max-w-[1400px] items-center gap-1 overflow-x-auto px-5 py-2">
          <template v-for="(t, i) in tabs" :key="t.name">
            <!-- グループの境目に細い縦線(装飾のみ)。 -->
            <div
              v-if="i > 0 && t.group !== tabs[i - 1].group"
              class="mx-1 h-[18px] w-px shrink-0 bg-border"
              aria-hidden="true"
            />
            <RouterLink
              :to="{ name: t.name }"
              :aria-current="activeName === t.name ? 'page' : undefined"
              :aria-label="
                t.name === 'reviews' && pending.count > 0
                  ? `${t.label}（未処理 ${pending.count} 件）`
                  : undefined
              "
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
              <!-- 承認待ちの未処理件数。0 件のときは出さない(平常時のノイズを避ける)。 -->
              <span
                v-if="t.name === 'reviews' && pending.count > 0"
                class="rounded-full border border-warning/30 bg-warning/15 px-1.5 text-[11px] font-bold tabular-nums text-warning-foreground"
              >
                {{ pending.count }}
              </span>
            </RouterLink>
          </template>
        </div>
      </nav>
    </header>
    <main class="mx-auto max-w-[1400px] px-5 pb-16 pt-6">
      <RouterView />
    </main>
  </div>
</template>
