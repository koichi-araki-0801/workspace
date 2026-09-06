// =============================================================================
// deps.ts — ルートへ配る集約の実体(sproc 注入の受け皿)
// =============================================================================
// `buildApp` が 1 回だけ組み立て、`register(routes, { prefix, deps })` で各ルートへ渡す。
// 集約どうしの依存(注記マスタ・ペア同期がパーツカタログを引く/承認が両者を呼ぶ)は
// ここで結線し、ルートは自分が使う面だけを `Pick` で受け取る。
import type { SessionStore } from './auth/session.js';
import type { SprocClient } from './db/sproc.js';
import { type AuthRepo, createAuthRepo } from './repositories/authRepo.js';
import { createPartRepo, type PartRepo } from './repositories/partRepo.js';
import { createReviewRepo, type ReviewRepo } from './repositories/reviewRepo.js';
import { createTemplateRepo, type TemplateRepo } from './repositories/templateRepo.js';
import { createUserRepo, type UserRepo } from './repositories/userRepo.js';
import { createNoteMasterService, type NoteMasterService } from './sync/noteMasterService.js';
import { createPairSyncService, type PairSyncService } from './sync/pairSyncService.js';

export interface Deps {
  auth: AuthRepo;
  users: UserRepo;
  templates: TemplateRepo;
  parts: PartRepo;
  reviews: ReviewRepo;
  pairSync: PairSyncService;
  noteMaster: NoteMasterService;
}

export function createDeps(sproc: SprocClient, sessionStore: SessionStore): Deps {
  const parts = createPartRepo(sproc);
  const noteMaster = createNoteMasterService({ sproc, parts });
  const pairSync = createPairSyncService(parts);
  return {
    auth: createAuthRepo({ sproc, sessionStore }),
    users: createUserRepo(sproc),
    templates: createTemplateRepo(sproc),
    parts,
    reviews: createReviewRepo({ noteMaster, pairSync }),
    pairSync,
    noteMaster,
  };
}
