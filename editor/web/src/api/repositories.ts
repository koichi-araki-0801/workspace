import type {
  AuthRepository,
  HistoryRepository,
  PartRepository,
  TemplateRepository,
  UserRepository,
} from '@editor/shared';
import { type InjectionKey, inject } from 'vue';
import { localAuthRepo } from './local/authRepo';
import { localHistoryRepo } from './local/historyRepo';
import { localPartRepo } from './local/partRepo';
import { localTemplateRepo } from './local/templateRepo';
import { localUserRepo } from './local/userRepo';
import { restAuthRepo } from './rest/authRepo';
import { restHistoryRepo } from './rest/historyRepo';
import { restPartRepo } from './rest/partRepo';
import { restTemplateRepo } from './rest/templateRepo';
import { restUserRepo } from './rest/userRepo';

/** The per-aggregate data-access surface injected into screens/services/stores. */
export interface Repositories {
  auth: AuthRepository;
  templates: TemplateRepository;
  parts: PartRepository;
  history: HistoryRepository;
  users: UserRepository;
}

/**
 * Composition root for data access. Wires the local (fixtures + localStorage)
 * repositories; swapping this single object for REST implementations of the
 * same interfaces leaves screens/services unchanged.
 */
export const localRepositories: Repositories = {
  auth: localAuthRepo,
  templates: localTemplateRepo,
  parts: localPartRepo,
  history: localHistoryRepo,
  users: localUserRepo,
};

/**
 * Phase 2 REST wiring — same interfaces, backed by the Express/SQL Server API.
 * `main.ts` picks this when VITE_API_MODE=rest; otherwise the local set above.
 */
export const restRepositories: Repositories = {
  auth: restAuthRepo,
  templates: restTemplateRepo,
  parts: restPartRepo,
  history: restHistoryRepo,
  users: restUserRepo,
};

/** DI key. Provided in main.ts, swappable in tests. */
export const REPOS_KEY: InjectionKey<Repositories> = Symbol('Repositories');

/** Inject all repositories. Use in component/store/service setup. */
export function useRepos(): Repositories {
  const repos = inject(REPOS_KEY);
  if (!repos)
    throw new Error('Repositories が provide されていません（main.ts の provide を確認）');
  return repos;
}

export const useAuthRepo = () => useRepos().auth;
export const useTemplateRepo = () => useRepos().templates;
export const usePartRepo = () => useRepos().parts;
export const useHistoryRepo = () => useRepos().history;
export const useUserRepo = () => useRepos().users;
