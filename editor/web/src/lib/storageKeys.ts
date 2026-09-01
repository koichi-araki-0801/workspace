// =============================================================================
// storageKeys.ts — localStorage キー定数(モード非依存)
// =============================================================================
// `api/local/store.ts` から切り出した。local 専用でないコード(例: `stores/editorSession.ts`
// の Undo/Redo 永続化)が localStorage キーだけを必要とするのに `api/local/**`(fixtures +
// `users.json` の平文パスワードを含む local グラフ一式)を import する足がかりを作らないため
// — rest ビルドでも local グラフが引き込まれる経路になっていた。

export const K = {
  drafts: 'editor:drafts',
  htmlOverride: 'editor:html',
  cssOverride: 'editor:css',
  editHist: 'editor:hist:edit',
  pdfHist: 'editor:hist:pdf',
  createHist: 'editor:hist:create',
  partHist: 'editor:hist:part',
  snapshots: 'editor:snapshots',
  instances: 'editor:instances',
  session: 'editor:session',
  sessionEpoch: 'editor:session:epoch',
  userOverride: 'editor:users',
  passwords: 'editor:pw',
  // パーツ単位メモ(追記型スレッド)。`Record<templateId, Record<pathKey, PartNoteEntry[]>>`。
  // 交付版⇄全体版で 1 本のスレッドを共有し、基準日をまたぐ繰り越しはしない。版(構造)に
  // 依存する working-state なので `WORKING_KEYS` に含め、スキーマ bump で破棄する。
  // `:v2` はスレッド化での形式変更(旧 `editor:notes` は 1 パーツ 1 件だった)。
  notes: 'editor:notes:v2',
  // 確定保存の承認待ち申請(オフラインデモ用ミラー)。`Record<reqId, ReviewRequest>`。
  // 版(構造)依存の working-state なので bump で破棄してよい。
  reviews: 'editor:reviews',
} as const;

/**
 * `:v2` 形式化(スレッド化)より前の旧メモキー。`WORKING_KEYS`(`api/local/store.ts`)には
 * 現行の `K.notes` しか無く、`:v2` へ改称した際にこの旧キーが一覧から漏れたため、既存の
 * ブラウザではスキーマ bump を経ても `editor:notes` の古い 1 パーツ 1 件形式の値が消えずに
 * 残る(内容を読む経路が無いだけの孤立データ)。`LEGACY_UNDO_STACKS_KEY` と同じ扱いで、
 * 後片付け(スキーマ bump)でのみ参照する。
 */
export const LEGACY_NOTES_KEY = 'editor:notes';

// ── Undo/Redo 永続ミラーのキー ──
// 値は `Record<templateId, {past, future}>`。クライアント編集の関心事で揮発性が高く、
// `WORKING_KEYS` に含めて bump で破棄してよい。キーにはユーザーを含める — 共有端末では
// 前の利用者の Undo スタックが次の利用者の画面へ復元されうるため。rest はログイン ID、
// local は単一利用者前提の固定スコープを使う。

const UNDO_STACKS_PREFIX = 'editor:session:undo';
const LOCAL_UNDO_SCOPE = 'local';
const ANONYMOUS_UNDO_SCOPE = 'anonymous';

/** ユーザー非分離だった旧形式キー。後片付け(logout / スキーマ bump)でのみ参照する。 */
export const LEGACY_UNDO_STACKS_KEY = UNDO_STACKS_PREFIX;

let undoLoginId: string | null = null;

/**
 * Undo ミラーのユーザースコープを設定する。`stores/auth.ts` が bootstrap / login /
 * logout で呼ぶ(ストアを跨いで参照し合わないための受け渡し点)。
 */
export function setUndoUserScope(loginId: string | null): void {
  undoLoginId = loginId;
}

/** 現在のユーザー向け Undo ミラーキー。 */
export function undoStacksKey(): string {
  const scope =
    import.meta.env.VITE_API_MODE === 'rest'
      ? (undoLoginId ?? ANONYMOUS_UNDO_SCOPE)
      : LOCAL_UNDO_SCOPE;
  return `${UNDO_STACKS_PREFIX}:${scope}`;
}
