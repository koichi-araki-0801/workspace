<script setup lang="ts">
// =============================================================================
// PasswordInitView.vue — パスワード再設定画面(初回ログイン / PW 忘れの両フロー)
// =============================================================================
import { isErr } from '@editor/shared';
import { AlertCircle, KeyRound } from '@lucide/vue';
import { computed, ref } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import Button from '@/components/ui/Button.vue';
import Card from '@/components/ui/Card.vue';
import Input from '@/components/ui/Input.vue';
import Label from '@/components/ui/Label.vue';
import ThemeToggle from '@/components/ui/ThemeToggle.vue';
import { toastError, toastSuccess } from '@/components/ui/toast';
import { useAuthService } from '@/features/auth/services/authService';
import { logError } from '@/lib/appError';
import { useAuthStore } from '@/stores/auth';

const router = useRouter();
const route = useRoute();
const auth = useAuthStore();
const authService = useAuthService();
const username = ref((route.query.username as string) ?? '');
const next = ref('');
const confirm = ref('');
const loading = ref(false);
const error = ref('');

const MIN_LENGTH = 8;

// 初回ログイン(`mustChangePassword`)は既にセッションが確立済み。「PW 忘れ」の入口は
// セッションを持たない。この差がサブタイトルと戻り先リンクの出し分けを駆動する。
const firstLogin = computed(() => auth.isAuthenticated);

async function submit() {
  if (!username.value.trim() || !next.value) {
    error.value = 'ユーザーIDと新しいパスワードを入力してください';
    return;
  }
  if (next.value.length < MIN_LENGTH) {
    error.value = `新しいパスワードは${MIN_LENGTH}文字以上で設定してください`;
    return;
  }
  if (next.value !== confirm.value) {
    error.value = '新しいパスワードが一致しません';
    return;
  }
  error.value = '';
  loading.value = true;
  const res = await authService.initPassword(username.value, next.value);
  loading.value = false;
  if (isErr(res)) {
    logError(res.error);
    error.value = res.error.message;
    toastError(res.error.message);
    return;
  }
  toastSuccess('パスワードを設定しました');
  if (auth.isAuthenticated) {
    // 初回ログインフロー: セッションは確立済み → そのままアプリへ進む。
    const redirect = (route.query.redirect as string) || '';
    router.push(redirect || { name: 'edit' });
  } else {
    // PW 忘れフロー: 新しいパスワードで再度サインインする。
    router.push({ name: 'login' });
  }
}
</script>

<template>
  <div class="relative grid min-h-screen place-items-center bg-gradient-to-br from-primary/[0.06] to-primary/[0.12] p-4">
    <ThemeToggle class="absolute right-4 top-4" />
    <Card class="w-full max-w-[380px] rounded-2xl p-8 shadow-[var(--shadow-lg)]">
      <div class="mb-6 flex flex-col items-center gap-2.5 text-center">
        <div class="grid h-12 w-12 place-items-center rounded-[14px] bg-primary text-primary-foreground">
          <KeyRound class="h-[23px] w-[23px]" />
        </div>
        <h1 class="text-[19px] font-bold">パスワード再設定</h1>
        <p class="text-sm text-muted-foreground">
          {{ firstLogin ? '初回ログインです。新しいパスワードを設定してください' : '新しいパスワードを設定してください' }}
        </p>
      </div>
      <form class="space-y-4" @submit.prevent="submit">
        <div class="space-y-1.5">
          <Label for="u">ユーザーID <span class="text-destructive">*</span></Label>
          <Input id="u" v-model="username" autocomplete="username" :aria-invalid="!!error" @input="error = ''" />
        </div>
        <div class="space-y-1.5">
          <Label for="n">新しいパスワード <span class="text-destructive">*</span></Label>
          <Input id="n" v-model="next" type="password" autocomplete="new-password" :aria-invalid="!!error" @input="error = ''" />
          <p class="text-[11.5px] text-muted-foreground">{{ MIN_LENGTH }}文字以上</p>
        </div>
        <div class="space-y-1.5">
          <Label for="cf">新しいパスワード（確認） <span class="text-destructive">*</span></Label>
          <Input id="cf" v-model="confirm" type="password" autocomplete="new-password" :aria-invalid="!!error" @input="error = ''" />
        </div>
        <p v-if="error" class="flex items-center gap-1.5 text-sm text-destructive" role="alert">
          <AlertCircle class="h-3.5 w-3.5 shrink-0" /> {{ error }}
        </p>
        <Button type="submit" class="w-full" :disabled="loading">{{ loading ? '設定中…' : '設定する' }}</Button>
      </form>
      <div class="mt-4 text-center">
        <RouterLink :to="{ name: 'login' }">
          <Button variant="link" class="h-auto p-0 text-sm font-semibold text-muted-foreground">ログイン画面に戻る</Button>
        </RouterLink>
      </div>
    </Card>
  </div>
</template>
