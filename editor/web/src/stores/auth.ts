import { isAdmin as isAdminUser, isOk, map, type Result, type User } from '@editor/shared';
import { defineStore } from 'pinia';
import { computed, ref } from 'vue';
import { useAuthService } from '@/features/auth/services/authService';
import { logError } from '@/lib/appError';

/**
 * Session state. Holds the current user + readiness; all auth use-cases go
 * through {@link useAuthService} (never the repository directly). Business rules
 * (e.g. admin check) live in the shared domain.
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

  /** Resolves to ok(mustChangePassword) on success, or err(AppError) on failure. */
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
