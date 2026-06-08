<script setup lang="ts">
import { isErr } from '@editor/shared';
import { ref } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import Button from '@/components/ui/Button.vue';
import Card from '@/components/ui/Card.vue';
import Input from '@/components/ui/Input.vue';
import Label from '@/components/ui/Label.vue';
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
    // First-login flow: session is already established → go straight into the app.
    const redirect = (route.query.redirect as string) || '';
    router.push(redirect || { name: 'edit' });
  } else {
    // Forgot-password flow: sign in again with the new password.
    router.push({ name: 'login' });
  }
}
</script>

<template>
  <div class="flex min-h-screen items-center justify-center bg-gradient-to-br from-primary/5 to-primary/10 p-4">
    <Card class="w-full max-w-sm p-6 sm:p-8">
      <h1 class="mb-1 text-xl font-semibold">パスワード再設定</h1>
      <p class="mb-6 text-sm text-muted-foreground">新しいパスワードを設定してください</p>
      <form class="space-y-4" @submit.prevent="submit">
        <div class="space-y-1.5">
          <Label for="u">ユーザーID <span class="text-destructive">*</span></Label>
          <Input id="u" v-model="username" autocomplete="username" :aria-invalid="!!error" @input="error = ''" />
        </div>
        <div class="space-y-1.5">
          <Label for="n">新しいパスワード <span class="text-destructive">*</span></Label>
          <Input id="n" v-model="next" type="password" autocomplete="new-password" :aria-invalid="!!error" @input="error = ''" />
          <p class="text-xs text-muted-foreground">{{ MIN_LENGTH }}文字以上</p>
        </div>
        <div class="space-y-1.5">
          <Label for="cf">新しいパスワード（確認） <span class="text-destructive">*</span></Label>
          <Input id="cf" v-model="confirm" type="password" autocomplete="new-password" :aria-invalid="!!error" @input="error = ''" />
        </div>
        <p v-if="error" class="text-sm text-destructive" role="alert">{{ error }}</p>
        <Button type="submit" class="w-full" :disabled="loading">{{ loading ? '設定中…' : '設定する' }}</Button>
      </form>
    </Card>
  </div>
</template>
