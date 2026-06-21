// =============================================================================
// labels.ts — `UserRole` の表示ラベル
// =============================================================================
import type { UserRole } from '@editor/shared';

/** `UserRole` の表示ラベル — 全日本語 UI の一貫性を保つ。 */
export const ROLE_LABELS: Record<UserRole, string> = {
  admin: '管理者',
  editor: '編集者',
  viewer: '閲覧者',
};

export function roleLabel(role: UserRole): string {
  return ROLE_LABELS[role] ?? role;
}
