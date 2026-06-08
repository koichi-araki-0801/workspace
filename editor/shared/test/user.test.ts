import { describe, expect, it } from 'vitest';
import { hasErrors, isAdmin, validateNewUser } from '../src/domain/user';
import type { User } from '../src/index';

const make = (role: User['role']): User => ({
  id: 'u1',
  username: 'u',
  displayName: 'U',
  role,
  disabled: false,
  mustChangePassword: false,
});

describe('isAdmin', () => {
  it('is true only for the admin role', () => {
    expect(isAdmin(make('admin'))).toBe(true);
    expect(isAdmin(make('editor'))).toBe(false);
    expect(isAdmin(make('viewer'))).toBe(false);
  });

  it('is false for null/undefined', () => {
    expect(isAdmin(null)).toBe(false);
    expect(isAdmin(undefined)).toBe(false);
  });
});

describe('validateNewUser / hasErrors', () => {
  it('reports both fields when blank', () => {
    const e = validateNewUser({ username: '  ', displayName: '' });
    expect(e.username).toBeTruthy();
    expect(e.displayName).toBeTruthy();
    expect(hasErrors(e)).toBe(true);
  });

  it('is clean for a valid form', () => {
    const e = validateNewUser({ username: 'taro', displayName: '太郎' });
    expect(e).toEqual({});
    expect(hasErrors(e)).toBe(false);
  });
});
