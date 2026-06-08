import type { UserRole } from '@editor/shared';

/** Display labels for user roles — keeps the all-Japanese UI consistent. */
export const ROLE_LABELS: Record<UserRole, string> = {
  admin: '管理者',
  editor: '編集者',
  viewer: '閲覧者',
};

export function roleLabel(role: UserRole): string {
  return ROLE_LABELS[role] ?? role;
}
