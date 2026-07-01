import { describe, expect, it } from 'vitest';
import { ROLE_LABELS, roleLabel } from '../src/lib/labels';

describe('roleLabel', () => {
  it('maps each known role to its Japanese label', () => {
    expect(roleLabel('admin')).toBe('管理者');
    expect(roleLabel('approver')).toBe('精査者');
    expect(roleLabel('editor')).toBe('編集者');
    expect(roleLabel('viewer')).toBe('閲覧者');
  });

  it('ROLE_LABELS exposes the same mapping', () => {
    expect(ROLE_LABELS).toEqual({
      admin: '管理者',
      approver: '精査者',
      editor: '編集者',
      viewer: '閲覧者',
    });
  });

  it('falls back to the raw role for an unknown value', () => {
    // @ts-expect-error — exercising the runtime fallback for an out-of-contract value
    expect(roleLabel('superuser')).toBe('superuser');
  });
});
