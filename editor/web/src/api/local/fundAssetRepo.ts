// =============================================================================
// fundAssetRepo.ts — ファンド別画像の確認の local 実装
// =============================================================================
// local(オフライン/デモ)にはサーバが無く、画像の配信ルートも SVG の検査も無い。理由を出せる
// 判定が無いので、どの参照も `ok`(警告を出さない)を返す。
import type { FundAssetRef, FundAssetRepository } from '@editor/shared';
import { attempt } from './attempt';

export const localFundAssetRepo: FundAssetRepository = {
  inspect: (refs: readonly FundAssetRef[]) =>
    attempt(() => refs.map(({ dir, file }) => ({ dir, file, status: 'ok' as const }))),
};
