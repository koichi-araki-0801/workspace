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
import { type Component, computed, onMounted, watch } from 'vue';
import { type RouteLocationRaw, RouterLink, RouterView, useRoute, useRouter } from 'vue-router';
import Button from '@/components/ui/Button.vue';
import ThemeToggle from '@/components/ui/ThemeToggle.vue';
import UserMenu from '@/components/ui/UserMenu.vue';
import { cn } from '@/lib/utils';
import { useAuthStore } from '@/stores/auth';
import { usePendingReviewsStore } from '@/stores/pendingReviews';
import { useTabMemoryStore } from '@/stores/tabMemory';
import { type TabName, tabOf } from './tabOf';

const auth = useAuthStore();
const route = useRoute();
const router = useRouter();
const pending = usePendingReviewsStore();
const memory = useTabMemoryStore();

// タブは作業フロー順(作業系 → 承認 → 出力/参照ツール → 履歴)。`group` の境目に区切り線を
// 挟み、日常操作(編集・作成)とワークフロー(承認)・ツール類の別を一目で分ける。
const tabs: { name: TabName; label: string; icon: Component; group: number }[] = [
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

// 点灯すべきタブ(review-detail 等の特例は tabOf が持つ)。
const activeTab = computed(() => tabOf(route));

// 編集・プレビューは本文の余白を持たない(残りの高さを全部使う)。
const flush = computed(() => route.meta.flush === true);

// タブごとに「直前に見ていた画面」を覚え、タブを押したときそこへ戻す。記憶が無ければ
// タブの既定画面。`immediate` は初期表示の画面も覚えるため。
watch(() => route.fullPath, () => memory.remember(route), { immediate: true });
function tabTarget(name: TabName): RouteLocationRaw {
  return memory.pathFor(name) ?? { name };
}

async function logout() {
  await auth.logout();
  router.push({ name: 'login' });
}

function goAdmin() {
  router.push({ name: 'admin' });
}
</script>

<template>
  <!-- ヘッダ帯と本文は同じ最大幅で揃える。1760px は編集画面の要件から決まる: 左ペイン 272px +
       右ペイン 312px = 584px が固定で、内容幅がページ実体 794px + 余白を収めるには 1500px 強
       要る。1400px 枠だと canvas が 776px でページより狭く、上部バーも折り返す(実測)。
       下限は絞り込みバーの要件 1400px: 項目名つき placeholder が収まる列幅(240px)で、比較画面の
       最大構成である 5 列(240px×4 + 「比較する版」220px + 間隔 48px = 1228px)を 1 行に並べる
       のに要る幅。狭めると 5 列目が次行へ落ち、編集画面では操作ボタンだけが次行へ落ちる。 -->
  <div class="flex h-screen flex-col bg-muted/40">
    <!-- ヘッダ帯は 1 行 56px。編集・プレビューがこの帯の下に展開されるため、帯を 2 段
         (ロゴ行 + タブ行)にすると canvas の高さを 46px 余分に失う。ロゴ(副文言まで)・
         タブ群・右端(管理者/テーマ/ユーザー)を同じ行に置き、ゾーン間は `gap-8` と `ml-auto`
         で十分に空ける。1760px 枠で約 1205px を使う。それより狭い画面では行ごと横スクロール
         (要素を隠さない)。 -->
    <header class="shrink-0 border-b bg-card print:hidden">
      <div class="mx-auto flex h-14 max-w-[1760px] items-center gap-8 overflow-x-auto px-5">
        <div class="flex shrink-0 items-baseline gap-2 font-bold text-primary">
          <FileText class="h-5 w-5 self-center" />
          <span class="text-base tracking-[0.1em]">RET</span>
          <span class="whitespace-nowrap text-xs font-semibold tracking-[0.02em] text-muted-foreground">
            Report Edit Tool
          </span>
        </div>
        <nav class="flex shrink-0 items-center gap-1">
          <template v-for="(t, i) in tabs" :key="t.name">
            <!-- グループの境目に細い縦線(装飾のみ)。 -->
            <div
              v-if="i > 0 && t.group !== tabs[i - 1].group"
              class="mx-1 h-[18px] w-px shrink-0 bg-border"
              aria-hidden="true"
            />
            <RouterLink
              :to="tabTarget(t.name)"
              :aria-current="activeTab === t.name ? 'page' : undefined"
              :aria-label="
                t.name === 'reviews' && pending.count > 0
                  ? `${t.label}（未処理 ${pending.count} 件）`
                  : undefined
              "
              :class="
                cn(
                  'ring-focus flex items-center gap-1.5 whitespace-nowrap rounded-lg px-3.5 py-1.5 text-[13.5px] font-semibold transition-colors',
                  activeTab === t.name
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
        </nav>
        <div class="ml-auto flex shrink-0 items-center gap-2.5">
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
    </header>
    <!-- 本文だけがスクロールする(ヘッダ帯は常に固定)。編集・プレビュー(`flush`)は余白を
         持たず残りの高さを全部使う。`min-h-0` が無いと flex 子の最小高さが内容高になり
         はみ出す。 -->
    <main
      :class="
        cn('mx-auto min-h-0 w-full max-w-[1760px] flex-1 overflow-auto', !flush && 'px-5 pb-16 pt-6')
      "
    >
      <RouterView />
    </main>
  </div>
</template>
