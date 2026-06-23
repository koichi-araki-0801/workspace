// =============================================================================
// auth.ts — 認証セッションの Pinia ストア
// =============================================================================
import { isAdmin as isAdminUser, isOk, map, type Result, type User } from '@editor/shared';
import { defineStore } from 'pinia';
import { computed, ref } from 'vue';
import { useAuthService } from '@/features/auth/services/authService';
import { currentAppEpoch, restartEnded } from '@/lib/appEpoch';
import { logError } from '@/lib/appError';

/** メッセージ判定専用マーカー(認証強制は repo epoch / REST 全失効が担う。これは表示用)。 */
const AUTH_EPOCH_KEY = 'editor:authEpoch';

/**
 * セッション状態。現在の `user` + 準備状態(`ready`)を保持する。全認証ユースケースは
 * `authService.ts` の `useAuthService` を経由する(repository を直接叩かない)。業務
 * ルール(例 admin 判定)は共有ドメインに置く。
 */
export const useAuthStore = defineStore('auth', () => {
  const auth = useAuthService();
  const user = ref<User | null>(null);
  const ready = ref(false);
  // 未認証で login へ送る理由。'restart' のときログイン画面がバナーを出す(§5)。
  const sessionEndedReason = ref<'restart' | null>(null);

  async function bootstrap(): Promise<void> {
    const res = await auth.me();
    if (isOk(res)) user.value = res.value;
    else logError(res.error);
    // 認証済みならマーカーを現 epoch へ更新。未認証かつ epoch が変わっていれば再起動切断。
    const prev = localStorage.getItem(AUTH_EPOCH_KEY);
    if (user.value) {
      localStorage.setItem(AUTH_EPOCH_KEY, currentAppEpoch());
    } else {
      if (restartEnded(prev, currentAppEpoch(), false)) sessionEndedReason.value = 'restart';
      localStorage.removeItem(AUTH_EPOCH_KEY);
    }
    ready.value = true;
  }

  /** 成功時は ok(mustChangePassword), 失敗時は err(AppError) へ解決する。 */
  async function login(username: string, password: string): Promise<Result<boolean>> {
    const res = await auth.login(username, password);
    if (isOk(res)) {
      user.value = res.value.user;
      localStorage.setItem(AUTH_EPOCH_KEY, currentAppEpoch());
      sessionEndedReason.value = null;
    }
    return map(res, (r) => r.mustChangePassword);
  }

  async function logout(): Promise<void> {
    const res = await auth.logout();
    if (!isOk(res)) logError(res.error);
    user.value = null;
    // 手動ログアウトは「再起動切断」ではない。マーカーと理由を消す。
    localStorage.removeItem(AUTH_EPOCH_KEY);
    sessionEndedReason.value = null;
  }

  const isAuthenticated = computed(() => user.value !== null);
  const isAdmin = computed(() => isAdminUser(user.value));

  return {
    user,
    ready,
    sessionEndedReason,
    bootstrap,
    login,
    logout,
    isAuthenticated,
    isAdmin,
  };
});
