// =============================================================================
// FundAssetRepository.ts — ファンド別画像(images/)が配信されるかの確認
// =============================================================================
// 役割: 画像を配信ルートと同じ判定(置き場の解決 → 読み込み → SVG の検査)にかけ、配信されない
// 理由を返す契約。配信ルートは理由を出さずに 404 にするので、編集画面とプレビューはこれで理由を
// 知り、警告欄に出す。ファイルの中身は返さない。
import type { FundAssetInspectResult, FundAssetRef } from '../index.js';
import type { Result } from '../result.js';

export interface FundAssetRepository {
  /** 参照ごとの判定(渡した順)。参照が無ければ空配列。 */
  inspect(refs: readonly FundAssetRef[]): Promise<Result<FundAssetInspectResult[]>>;
}
