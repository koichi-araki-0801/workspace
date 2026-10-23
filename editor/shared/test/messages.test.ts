import { describe, expect, it } from 'vitest';
import {
  countAtCapacity,
  EXTERNAL_REF_MESSAGE,
  entriesCapacityMessage,
  MAX_REPORTED_REFS,
  notesCapacityMessage,
} from '../src/domain/messages';

describe('EXTERNAL_REF_MESSAGE', () => {
  it('今の配置規約(../css ../js ../images)で案内する', () => {
    expect(EXTERNAL_REF_MESSAGE).toContain('../css/… ../js/… ../images/…');
    expect(EXTERNAL_REF_MESSAGE).toContain('PDFを作成できません。');
    expect(EXTERNAL_REF_MESSAGE).not.toContain('css/fonts/');
  });

  it('報告件数の上限は 5', () => {
    expect(MAX_REPORTED_REFS).toBe(5);
  });
});

describe('メモ上限', () => {
  it('件数が上限以上で達したとみなす', () => {
    expect(countAtCapacity(999, 1000)).toBe(false);
    expect(countAtCapacity(1000, 1000)).toBe(true);
    expect(countAtCapacity(1001, 1000)).toBe(true);
  });

  it('文言は「メモ」で件数を含む', () => {
    expect(notesCapacityMessage(1000)).toBe('このテンプレートのメモは上限(1000 件)に達しています');
    expect(entriesCapacityMessage(200)).toBe(
      'このパーツのメモは上限(200 件)に達しています。不要なメモを削除してください。',
    );
  });
});
