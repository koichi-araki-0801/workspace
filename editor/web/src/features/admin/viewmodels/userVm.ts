import type { User } from '@editor/shared';
import { roleLabel } from '@/lib/labels';

/** Display shape for a user row: role/status rendered as labels + badge variants. */
export interface UserVm {
  id: string;
  username: string;
  displayName: string;
  roleLabel: string;
  statusLabel: string;
  statusVariant: 'success' | 'secondary';
  needsPasswordReset: boolean;
  /** The source entity, for action handlers. */
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
