// =============================================================================
// repositories.ts — リポジトリの DI 合成ルート(local/REST 実装の切替点)
// =============================================================================
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

/** 画面/サービス/ストアへ inject する集約単位のデータアクセス面。 */
export interface Repositories {
  auth: AuthRepository;
  templates: TemplateRepository;
  parts: PartRepository;
  history: HistoryRepository;
  users: UserRepository;
}

/**
 * データアクセスの合成ルート。local(fixtures + localStorage)実装を束ねる。
 * 同一インタフェースの REST 実装へこの 1 オブジェクトを差し替えるだけで、
 * 画面/サービス側は無改修で済む。
 */
export const localRepositories: Repositories = {
  auth: localAuthRepo,
  templates: localTemplateRepo,
  parts: localPartRepo,
  history: localHistoryRepo,
  users: localUserRepo,
};

/**
 * フェーズ 2 の REST 配線。インタフェースは同一で、実体は Express/SQL Server API。
 * `main.ts` が VITE_API_MODE=rest のとき本セットを採用する(既定は上の local セット)。
 */
export const restRepositories: Repositories = {
  auth: restAuthRepo,
  templates: restTemplateRepo,
  parts: restPartRepo,
  history: restHistoryRepo,
  users: restUserRepo,
};

/** DI キー。`main.ts` で provide し、テストでは差し替え可能。 */
export const REPOS_KEY: InjectionKey<Repositories> = Symbol('Repositories');

/** 全リポジトリを inject する。コンポーネント/ストア/サービスの setup で使う。 */
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
