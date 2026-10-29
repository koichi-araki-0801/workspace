// =============================================================================
// storageKeys.ts — localStorage キー定数
// =============================================================================

// ── Undo/Redo 永続ミラーのキー ──
// 値は `Record<templateId, {past, future}>`。クライアント編集の関心事で揮発性が高い。
// キーにはユーザーを含める — 共有端末では前の利用者の Undo スタックが次の利用者の画面へ
// 復元されうるため。スコープはログイン ID。

const UNDO_STACKS_PREFIX = 'editor:session:undo:v2';
// 下書きの所属セッション。値は `Record<templateId, sessionToken>`(`lib/draftOwner.ts`)。
// 編集セッションはブラウザタブの寿命で、別タブが残した下書きは次回オープン時に破棄する。
// Undo ミラーと同じ理由でユーザー別に分ける。
const DRAFT_OWNER_PREFIX = 'editor:draft:owner';
const ANONYMOUS_UNDO_SCOPE = 'anonymous';

let undoLoginId: string | null = null;

/**
 * Undo ミラーと下書き所属のユーザースコープを設定する。`stores/auth.ts` が bootstrap /
 * login / logout で呼ぶ(ストアを跨いで参照し合わないための受け渡し点)。
 */
export function setUndoUserScope(loginId: string | null): void {
  undoLoginId = loginId;
}

/** 現在のユーザーのスコープ。ログイン前は匿名の固定値。 */
function userScope(): string {
  return undoLoginId ?? ANONYMOUS_UNDO_SCOPE;
}

/** 現在のユーザー向け Undo ミラーキー。 */
export function undoStacksKey(): string {
  return `${UNDO_STACKS_PREFIX}:${userScope()}`;
}

/** 現在のユーザー向け下書き所属キー。 */
export function draftOwnerKey(): string {
  return `${DRAFT_OWNER_PREFIX}:${userScope()}`;
}

const CONFIRMED_CANONICAL_PREFIX = 'editor:confirmed:v1';
/** 確定版正規形キャッシュのキー(ユーザー別。`lib/confirmedCanonical.ts`)。 */
export function confirmedCanonicalKey(): string {
  return `${CONFIRMED_CANONICAL_PREFIX}:${userScope()}`;
}

const UI_STATE_PREFIX = 'editor:session:ui';
/** 編集画面 UI 状態(倍率・表示系)永続ミラーのキー(ユーザー別。`stores/editorSession.ts`)。 */
export function editorUiKey(): string {
  return `${UI_STATE_PREFIX}:${userScope()}`;
}

const CSS_BASELINE_PREFIX = 'editor:session:css-baseline:v1';
/**
 * 確定版の CSS を編集画面が読み込んだ直後の形(申請の `cssBaseline`)の sessionStorage キー
 * (ユーザー別・テンプレ別。`stores/editorSession.ts`)。
 */
export function cssBaselineKey(templateId: string): string {
  return `${CSS_BASELINE_PREFIX}:${userScope()}:${templateId}`;
}
