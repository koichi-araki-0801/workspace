<script setup lang="ts">
// =============================================================================
// LoginView.vue — ログイン画面(認証 + 初回ログイン時のパスワード再設定への誘導)
// =============================================================================
import { isErr } from '@editor/shared';
import { AlertCircle, FileText } from '@lucide/vue';
import { ref } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import Button from '@/components/ui/Button.vue';
import Card from '@/components/ui/Card.vue';
import Input from '@/components/ui/Input.vue';
import Label from '@/components/ui/Label.vue';
import ThemeToggle from '@/components/ui/ThemeToggle.vue';
import { toastError } from '@/components/ui/toast';
import { logError } from '@/lib/appError';
import { useAuthStore } from '@/stores/auth';

const auth = useAuthStore();
const router = useRouter();
const route = useRoute();

const username = ref('');
const password = ref('');
const loading = ref(false);
const error = ref('');
const isDev = import.meta.env.DEV;

async function submit() {
  if (!username.value.trim() || !password.value) {
    error.value = 'ユーザーIDとパスワードを入力してください';
    return;
  }
  error.value = '';
  loading.value = true;
  const res = await auth.login(username.value, password.value);
  loading.value = false;
  if (isErr(res)) {
    logError(res.error);
    error.value = res.error.message;
    toastError(res.error.message);
    return;
  }
  const redirect = (route.query.redirect as string) || '/';
  if (res.value) {
    // `mustChangePassword`: 初期化画面へ強制遷移。redirect を引き継ぎ、初期化後にアプリへ着地させる。
    router.push({ name: 'password-init', query: { username: username.value, redirect } });
    return;
  }
  router.push(redirect);
}
</script>

<template>
  <div class="relative grid min-h-screen place-items-center bg-gradient-to-br from-primary/[0.06] to-primary/[0.12] p-4">
    <ThemeToggle class="absolute right-4 top-4" />
    <Card class="w-full max-w-[380px] rounded-2xl p-8 shadow-[var(--shadow-lg)]">
      <div class="mb-6 flex flex-col items-center gap-2.5">
        <div class="grid h-12 w-12 place-items-center rounded-[14px] bg-primary text-primary-foreground">
          <FileText class="h-6 w-6" />
        </div>
        <h1 class="text-[22px] font-bold tracking-[0.12em]">RET</h1>
        <p class="text-[12.5px] tracking-[0.02em] text-muted-foreground">Report Edit Tool</p>
      </div>
      <form class="space-y-4" @submit.prevent="submit">
        <div class="space-y-1.5">
          <Label for="u">ユーザーID <span class="text-destructive">*</span></Label>
          <Input id="u" v-model="username" autocomplete="username" :aria-invalid="!!error" @input="error = ''" />
        </div>
        <div class="space-y-1.5">
          <Label for="p">パスワード <span class="text-destructive">*</span></Label>
          <Input id="p" v-model="password" type="password" autocomplete="current-password" :aria-invalid="!!error" @input="error = ''" />
        </div>
        <p v-if="error" class="flex items-center gap-1.5 text-sm text-destructive" role="alert">
          <AlertCircle class="h-3.5 w-3.5 shrink-0" /> {{ error }}
        </p>
        <Button type="submit" class="w-full" :disabled="loading">
          {{ loading ? 'ログイン中…' : 'ログイン' }}
        </Button>
      </form>
      <div class="mt-4 text-center">
        <RouterLink :to="{ name: 'password-init' }">
          <Button variant="link" class="h-auto whitespace-nowrap p-0 text-sm font-semibold">PW をお忘れの方はこちら</Button>
        </RouterLink>
      </div>
      <p v-if="isDev" class="mt-4 text-center text-[11.5px] leading-relaxed text-muted-foreground">
        デモ: <span class="mono">admin / admin</span>　または　<span class="mono">editor / editor</span>
      </p>
    </Card>
  </div>
</template>
