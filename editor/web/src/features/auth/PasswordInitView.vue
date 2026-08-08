<script setup lang="ts">
// =============================================================================
// PasswordInitView.vue — パスワード変更画面(本人・現行パスワードによる所有証明が必要)
// =============================================================================
// 「PW を忘れた人が自分で再設定する」フローはここには無い。現行パスワードを示さずに任意
// アカウントのパスワードを書き換えられる経路は、そのまま `admin` 乗っ取りになるため
// (サーバ側も `requireAuth` + 本人一致 + 現行パスワード検証で三重に施錠している)。
// 忘れた場合の復旧は管理者によるリセット(管理画面)だけが経路。
import { isErr, PASSWORD_MIN_LENGTH } from '@editor/shared';
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
const current = ref('');
const next = ref('');
const confirm = ref('');
const loading = ref(false);
const error = ref('');

const MIN_LENGTH = PASSWORD_MIN_LENGTH;

// 対象は常にログイン中の本人。query の `username` は表示のヒントにも使わない(他人の id を
// 差し込める見た目を残さないため)。未ログインで来た場合はフォーム自体を出さない。
const username = computed(() => auth.user?.username ?? '');
// 初回ログイン(`mustChangePassword`)かどうかは説明文の出し分けにだけ使う。
const firstLogin = computed(() => auth.mustChangePassword);

async function submit() {
  if (!current.value || !next.value) {
    error.value = '現在のパスワードと新しいパスワードを入力してください';
    return;
  }
  // 空白のみ(=実質空)のパスワードを弾くため trim 後の長さで判定する。
  if (next.value.trim().length < MIN_LENGTH) {
    error.value = `新しいパスワードは${MIN_LENGTH}文字以上で設定してください`;
    return;
  }
  if (next.value !== confirm.value) {
    error.value = '新しいパスワードが一致しません';
    return;
  }
  if (next.value === current.value) {
    error.value = '現在のパスワードと同じものは設定できません';
    return;
  }
  error.value = '';
  loading.value = true;
  const res = await authService.initPassword(username.value, current.value, next.value);
  loading.value = false;
  if (isErr(res)) {
    logError(res.error);
    error.value = res.error.message;
    toastError(res.error.message);
    return;
  }
  toastSuccess('パスワードを変更しました');
  // セッションは確立済みなのでそのままアプリへ進む(`mustChangePassword` は再取得で下りる)。
  await auth.bootstrap();
  const redirect = (route.query.redirect as string) || '';
  router.push(redirect || { name: 'edit' });
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
        <h1 class="text-[19px] font-bold">パスワード変更</h1>
        <p class="text-sm text-muted-foreground">
          {{ firstLogin ? '初回ログインです。新しいパスワードを設定してください' : '新しいパスワードを設定してください' }}
        </p>
      </div>

      <!-- 未ログインで直接来た場合。自己申告のユーザーIDで再設定させる導線は置かない。 -->
      <div v-if="!auth.isAuthenticated" class="space-y-4">
        <p class="flex items-start gap-1.5 rounded-md bg-muted/50 px-3 py-2 text-[12.5px] leading-relaxed" role="status">
          <AlertCircle class="mt-0.5 h-3.5 w-3.5 shrink-0 text-primary" />
          <span>パスワードの変更にはログインが必要です。<br />現在のパスワードが分からない場合は、管理者にリセットを依頼してください。</span>
        </p>
        <RouterLink :to="{ name: 'login' }">
          <Button class="w-full">ログイン画面へ</Button>
        </RouterLink>
      </div>

      <form v-else class="space-y-4" @submit.prevent="submit">
        <div class="space-y-1.5">
          <Label for="u">ユーザーID</Label>
          <Input id="u" :model-value="username" autocomplete="username" readonly disabled />
        </div>
        <div class="space-y-1.5">
          <Label for="c">現在のパスワード <span class="text-destructive">*</span></Label>
          <Input id="c" v-model="current" type="password" autocomplete="current-password" :aria-invalid="!!error" @input="error = ''" />
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
      <div v-if="auth.isAuthenticated" class="mt-4 text-center">
        <RouterLink :to="{ name: 'login' }">
          <Button variant="link" class="h-auto p-0 text-sm font-semibold text-muted-foreground">ログイン画面に戻る</Button>
        </RouterLink>
      </div>
    </Card>
  </div>
</template>
