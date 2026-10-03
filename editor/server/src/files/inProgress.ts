// =============================================================================
// inProgress.ts — 作業中(下書きか pending/)のテンプレートを探す
// =============================================================================
// 作成済み(`templates/`)と承認待ちの作成申請の照合は会社コードの大文字小文字を区別しない。作業中も
// 同じ規則で探す。綴りどおりに見ると、大文字小文字を区別するファイルシステムでは綴り違いの pending が
// 並び、作り直しの確認(409「作成中」)もすり抜ける。返す id はファイルの綴りのまま(そのまま開ける)。

import { listDraftIds } from './draftFiles.js';
import { listPendingIds } from './pendingFiles.js';

export interface InProgressIds {
  pending: string[];
  drafts: string[];
}

export async function findInProgressIds(templateId: string): Promise<InProgressIds> {
  const want = templateId.toLowerCase();
  const match = (ids: string[]) => ids.filter((id) => id.toLowerCase() === want);
  const [pending, drafts] = await Promise.all([listPendingIds(), listDraftIds()]);
  return { pending: match(pending), drafts: match(drafts) };
}
