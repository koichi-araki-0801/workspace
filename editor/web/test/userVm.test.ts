import type { User } from '@editor/shared';
import { describe, expect, it } from 'vitest';
import { toUserVm } from '@/features/admin/viewmodels/userVm';

const user = (over: Partial<User>): User => ({
  id: 'u1',
  username: 'taro',
  displayName: '山田太郎',
  role: 'editor',
  disabled: false,
  mustChangePassword: false,
  ...over,
});

describe('toUserVm', () => {
  it('maps an active user', () => {
    const vm = toUserVm(user({}));
    expect(vm.roleLabel).toBe('編集者');
    expect(vm.statusLabel).toBe('有効');
    expect(vm.statusVariant).toBe('success');
    expect(vm.needsPasswordReset).toBe(false);
  });

  it('maps a disabled user needing a password reset', () => {
    const vm = toUserVm(user({ disabled: true, mustChangePassword: true, role: 'admin' }));
    expect(vm.roleLabel).toBe('管理者');
    expect(vm.statusLabel).toBe('無効');
    expect(vm.statusVariant).toBe('secondary');
    expect(vm.needsPasswordReset).toBe(true);
  });
});
