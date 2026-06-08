import { isErr, notFound, type User, type UserRepository } from '@editor/shared';
import { attempt } from './attempt';
import { delay, K, listUsersSync, read, uid, write } from './store';

export const localUserRepo: UserRepository = {
  listUsers: () => attempt(() => delay(listUsersSync())),

  createUser: (user: Omit<User, 'id'>) =>
    attempt(() => {
      const overrides = read<Record<string, Partial<User>>>(K.userOverride, {});
      const id = uid('u');
      overrides[id] = { ...user };
      write(K.userOverride, overrides);
      return delay({ id, ...user });
    }),

  updateUser: (id: string, patch: Partial<Omit<User, 'id'>>) =>
    attempt(() => {
      const overrides = read<Record<string, Partial<User>>>(K.userOverride, {});
      overrides[id] = { ...overrides[id], ...patch };
      write(K.userOverride, overrides);
      const updated = listUsersSync().find((u) => u.id === id);
      if (!updated) throw notFound(`ユーザーが見つかりません: ${id}`);
      return delay(updated);
    }),

  resetUserPassword: (id: string) =>
    attempt(async () => {
      const user = listUsersSync().find((u) => u.id === id);
      if (!user) throw notFound(`ユーザーが見つかりません: ${id}`);
      const pw = read<Record<string, string>>(K.passwords, {});
      pw[user.username] = 'init1234';
      write(K.passwords, pw);
      const updated = await localUserRepo.updateUser(id, { mustChangePassword: true });
      if (isErr(updated)) throw updated.error;
      return delay(undefined);
    }),
};
