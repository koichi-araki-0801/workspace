// =============================================================================
// userVm.ts — ユーザー行の表示用 view-model(role/status をラベル + badge variant へ)
// =============================================================================
import type { User } from '@editor/shared';
import { roleLabel } from '@/lib/labels';

/** ユーザー行の表示形状: role/status をラベルと badge variant で表す。 */
interface UserVm {
  id: string;
  username: string;
  displayName: string;
  roleLabel: string;
  statusLabel: string;
  statusVariant: 'success' | 'secondary';
  needsPasswordReset: boolean;
  /** 操作ハンドラ用の元エンティティ。 */
  raw: User;
}

export function toUserVm(u: User): UserVm {
  return {
    id: u.id,
    username: u.username,
    displayName: u.displayName,
    roleLabel: roleLabel(u.role),
    statusLabel: u.disabled ? '無効' : '有効',
    statusVariant: u.disabled ? 'secondary' : 'success',
    needsPasswordReset: u.mustChangePassword,
    raw: u,
  };
}
