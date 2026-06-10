<script setup lang="ts">
import { isErr } from '@editor/shared';
import { FileText } from '@lucide/vue';
import { ref } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import Button from '@/components/ui/Button.vue';
import Card from '@/components/ui/Card.vue';
import Input from '@/components/ui/Input.vue';
import Label from '@/components/ui/Label.vue';
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
    // mustChangePassword: force the init screen, carrying the redirect so init lands in the app.
    router.push({ name: 'password-init', query: { username: username.value, redirect } });
    return;
  }
  router.push(redirect);
}
</script>

<template>
  <div class="flex min-h-screen items-center justify-center bg-gradient-to-br from-primary/5 to-primary/10 p-4">
    <Card class="w-full max-w-sm p-6 sm:p-8">
      <div class="mb-6 flex flex-col items-center gap-2">
        <div class="flex h-12 w-12 items-center justify-center rounded-xl bg-primary text-primary-foreground">
          <FileText class="h-6 w-6" />
        </div>
        <h1 class="text-xl font-semibold">テンプレート編集</h1>
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
        <p v-if="error" class="text-sm text-destructive" role="alert">{{ error }}</p>
        <Button type="submit" class="w-full" :disabled="loading">
          {{ loading ? 'ログイン中…' : 'ログイン' }}
        </Button>
      </form>
      <div class="mt-4 text-center">
        <RouterLink :to="{ name: 'password-init' }">
          <Button variant="link" class="h-auto p-0 text-sm">PW をお忘れの方はこちら</Button>
        </RouterLink>
      </div>
      <p v-if="isDev" class="mt-4 text-center text-xs text-muted-foreground">
        デモ: admin / admin　または　editor / editor
      </p>
    </Card>
  </div>
</template>
