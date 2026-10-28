// =============================================================================
// repositories.ts — REST リポジトリの DI 合成ルート
// =============================================================================
import type {
  AuthRepository,
  FundAssetRepository,
  HistoryRepository,
  NoteRepository,
  PartRepository,
  ReviewRepository,
  TemplateRepository,
  UserRepository,
} from '@editor/shared';
import { type InjectionKey, inject } from 'vue';
import { restAuthRepo } from './rest/authRepo';
import { restFundAssetRepo } from './rest/fundAssetRepo';
import { restHistoryRepo } from './rest/historyRepo';
import { restNoteRepo } from './rest/noteRepo';
import { restPartRepo } from './rest/partRepo';
import { restReviewRepo } from './rest/reviewRepo';
import { restTemplateRepo } from './rest/templateRepo';
import { restUserRepo } from './rest/userRepo';

/** 画面/サービス/ストアへ inject する集約単位のデータアクセス面。 */
export interface Repositories {
  auth: AuthRepository;
  templates: TemplateRepository;
  parts: PartRepository;
  history: HistoryRepository;
  notes: NoteRepository;
  reviews: ReviewRepository;
  users: UserRepository;
  /** ファンド別画像が配信されるかの確認(警告欄に理由を出すため)。 */
  fundAssets: FundAssetRepository;
}

/**
 * データアクセスの合成ルート。実体は SQL Server backend の API。テストは同じ形の偽物を
 * provide して差し替える。
 */
export const restRepositories: Repositories = {
  auth: restAuthRepo,
  templates: restTemplateRepo,
  parts: restPartRepo,
  history: restHistoryRepo,
  notes: restNoteRepo,
  reviews: restReviewRepo,
  users: restUserRepo,
  fundAssets: restFundAssetRepo,
};

/** DI キー。`main.ts` で provide し、テストでは差し替え可能。 */
export const REPOS_KEY: InjectionKey<Repositories> = Symbol('Repositories');

/** 全リポジトリを inject する。コンポーネント/ストア/サービスの setup で使う。 */
function useRepos(): Repositories {
  const repos = inject(REPOS_KEY);
  if (!repos)
    throw new Error('Repositories が provide されていません（main.ts の provide を確認）');
  return repos;
}

export const useAuthRepo = () => useRepos().auth;
export const useTemplateRepo = () => useRepos().templates;
export const usePartRepo = () => useRepos().parts;
export const useHistoryRepo = () => useRepos().history;
export const useNoteRepo = () => useRepos().notes;
export const useReviewRepo = () => useRepos().reviews;
export const useUserRepo = () => useRepos().users;
export const useFundAssetRepo = () => useRepos().fundAssets;
