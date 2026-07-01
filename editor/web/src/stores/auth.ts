// =============================================================================
// auth.ts — 認証セッションの Pinia ストア
// =============================================================================
import {
  isAdmin as isAdminUser,
  isApprover as isApproverUser,
  isOk,
  map,
  type Result,
  type User,
} from '@editor/shared';
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
  // 確定保存の承認権限(approver|admin)。承認画面/導線の出し分けに使う。
  const isApprover = computed(() => isApproverUser(user.value));
  // 初回パスワード変更が未了か。navigation guard が password-init へ強制するのに使う
  // (直 URL で初期化画面を回避して他画面へ入れてしまう抜け道を塞ぐ)。
  const mustChangePassword = computed(() => user.value?.mustChangePassword ?? false);

  return {
    user,
    ready,
    sessionEndedReason,
    bootstrap,
    login,
    logout,
    isAuthenticated,
    isAdmin,
    isApprover,
    mustChangePassword,
  };
});
