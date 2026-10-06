// =============================================================================
// fundAssetRepo.ts — ファンド別画像の確認の REST 実装
// =============================================================================
// 役割: `FundAssetRepository` の REST 実装。`POST /api/fund-assets/inspect` に `{ refs }` を送る。
// サーバは 1 回に `MAX_FUND_ASSET_INSPECT_REFS` 件までしか受けないので、超える分は分けて送り、
// 結果を渡した順につなぐ。
import {
  apiPaths,
  type FundAssetInspectResponse,
  type FundAssetInspectResult,
  type FundAssetRef,
  type FundAssetRepository,
  MAX_FUND_ASSET_INSPECT_REFS,
} from '@editor/shared';
import { apiFetch, attemptRest } from './http';

export const restFundAssetRepo: FundAssetRepository = {
  inspect: (refs: readonly FundAssetRef[]) =>
    attemptRest(async () => {
      const out: FundAssetInspectResult[] = [];
      for (let i = 0; i < refs.length; i += MAX_FUND_ASSET_INSPECT_REFS) {
        const chunk = refs.slice(i, i + MAX_FUND_ASSET_INSPECT_REFS);
        const res = await apiFetch<FundAssetInspectResponse>(apiPaths.fundAssetInspect, {
          method: 'POST',
          body: { refs: chunk },
        });
        out.push(...res.results);
      }
      return out;
    }),
};
