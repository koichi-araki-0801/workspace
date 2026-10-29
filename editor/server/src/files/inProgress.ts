// =============================================================================
// inProgress.ts — 作業中(下書きか pending/)のテンプレートを探す
// =============================================================================
// 作成済み(`templates/`)と承認待ちの作成申請の照合は会社コードの大文字小文字を区別しない。作業中も
// 同じ規則で探す。綴りどおりに見ると、大文字小文字を区別するファイルシステムでは綴り違いの pending が
// 並び、作り直しの確認(409「作成中」)もすり抜ける。返す id はファイルの綴りのまま(そのまま開ける)。

import { listDraftIds } from './draftFiles.js';
import { listPendingIds } from './pendingFiles.js';

interface InProgressIds {
  pending: string[];
  drafts: string[];
}

export async function findInProgressIds(templateId: string): Promise<InProgressIds> {
  return (await inProgressLookup())(templateId);
}

/**
 * pending/ と下書きの一覧を 1 度だけ取り、id ごとの照合を返す。1 回の要求で複数の版を問うとき
 * (作成タブの作成可否・生成)に、版ごとにフォルダを読み直さないため。
 */
export async function inProgressLookup(): Promise<(templateId: string) => InProgressIds> {
  const [pending, drafts] = await Promise.all([listPendingIds(), listDraftIds()]);
  return (templateId) => {
    const want = templateId.toLowerCase();
    const match = (ids: string[]) => ids.filter((id) => id.toLowerCase() === want);
    return { pending: match(pending), drafts: match(drafts) };
  };
}
