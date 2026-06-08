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

/** The per-aggregate data-access surface injected into screens/services/stores. */
export interface Repositories {
  auth: AuthRepository;
  templates: TemplateRepository;
  parts: PartRepository;
  history: HistoryRepository;
  users: UserRepository;
}

/**
 * Composition root for data access. Phase 1 wires the local (fixtures +
 * localStorage) repositories; phase 2 swaps this single object for REST
 * implementations of the same interfaces — screens/services never change.
 */
export const localRepositories: Repositories = {
  auth: localAuthRepo,
  templates: localTemplateRepo,
  parts: localPartRepo,
  history: localHistoryRepo,
  users: localUserRepo,
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
