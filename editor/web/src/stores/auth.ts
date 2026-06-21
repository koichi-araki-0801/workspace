// =============================================================================
// auth.ts — 認証セッションの Pinia ストア
// =============================================================================
import { isAdmin as isAdminUser, isOk, map, type Result, type User } from '@editor/shared';
import { defineStore } from 'pinia';
import { computed, ref } from 'vue';
import { useAuthService } from '@/features/auth/services/authService';
import { logError } from '@/lib/appError';

/**
 * セッション状態。現在の `user` + 準備状態(`ready`)を保持する。全認証ユースケースは
 * `authService.ts` の `useAuthService` を経由する(repository を直接叩かない)。業務
 * ルール(例 admin 判定)は共有ドメインに置く。
 */
export const useAuthStore = defineStore('auth', () => {
  const auth = useAuthService();
  const user = ref<User | null>(null);
  const ready = ref(false);

  async function bootstrap(): Promise<void> {
    const res = await auth.me();
    if (isOk(res)) user.value = res.value;
    else logError(res.error);
    ready.value = true;
  }

  /** 成功時は ok(mustChangePassword), 失敗時は err(AppError) へ解決する。 */
  async function login(username: string, password: string): Promise<Result<boolean>> {
    const res = await auth.login(username, password);
    if (isOk(res)) user.value = res.value.user;
    return map(res, (r) => r.mustChangePassword);
  }

  async function logout(): Promise<void> {
    const res = await auth.logout();
    if (!isOk(res)) logError(res.error);
    user.value = null;
  }

  const isAuthenticated = computed(() => user.value !== null);
  const isAdmin = computed(() => isAdminUser(user.value));

  return { user, ready, bootstrap, login, logout, isAuthenticated, isAdmin };
});
