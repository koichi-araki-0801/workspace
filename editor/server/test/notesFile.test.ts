import { describe, expect, it } from 'vitest';
import { readNotes } from '../src/files/notesFile.js';

// `fileFor` のパストラバーサル防止と、版種に非ASCII(例: 全体版)を含む templateId の許可を検証する。
// 妥当だがファイルが無い templateId は `readNotes` が {} を返す(= 検証を通過したことの証左)。
describe('notesFile templateId validation', () => {
  it('accepts a templateId whose editionType is non-ASCII', async () => {
    // 4 トークンの命名規則に一致(版種が日本語)。ファイルは無いので {} が返る。
    await expect(readNotes('AM01_510037_20240710_全体版')).resolves.toEqual({});
  });

  it('rejects path-traversal / separator-bearing ids', async () => {
    await expect(readNotes('../etc/passwd')).rejects.toMatchObject({ kind: 'validation' });
    await expect(readNotes('a/b')).rejects.toMatchObject({ kind: 'validation' });
    await expect(readNotes('a\\b')).rejects.toMatchObject({ kind: 'validation' });
  });

  it('rejects ids that are not 4-token template names', async () => {
    await expect(readNotes('notatemplate')).rejects.toMatchObject({ kind: 'validation' });
    await expect(readNotes('AM01_510037_20240710')).rejects.toMatchObject({ kind: 'validation' });
  });
});
