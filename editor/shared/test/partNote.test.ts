import { describe, expect, it } from 'vitest';
import {
  AddNoteRequest,
  apiPaths,
  buildPath,
  MAX_NOTE_ENTRIES_PER_PART,
  PartNoteEntry,
  UpdateNoteRequest,
} from '../src/index.js';

describe('PartNoteEntry', () => {
  it('投稿 1 件の形を受理する(未編集は updatedAt/updatedBy が null)', () => {
    const parsed = PartNoteEntry.parse({
      id: '2f1c9a52-0f3e-4a1b-9d5c-8e7a6b5c4d3e',
      templateId: 'AM01_510037_20240710_交付版',
      pathKey: '.page#1/cover#1',
      content: 'メモ本文',
      createdAt: '2026-09-01T00:00:00.000Z',
      createdBy: 'editor1',
      updatedAt: null,
      updatedBy: null,
    });
    expect(parsed.content).toBe('メモ本文');
  });
});

describe('AddNoteRequest / UpdateNoteRequest', () => {
  it('空文字の本文は拒否する(削除は DELETE で明示する)', () => {
    expect(AddNoteRequest.safeParse({ pathKey: 'p', content: '' }).success).toBe(false);
    expect(UpdateNoteRequest.safeParse({ content: '' }).success).toBe(false);
  });

  it('本文の長さ上限を強制する', () => {
    const tooLong = 'あ'.repeat(64 * 1024 + 1);
    expect(AddNoteRequest.safeParse({ pathKey: 'p', content: tooLong }).success).toBe(false);
  });
});

describe('apiPaths.noteEntry', () => {
  it('templateId と entryId を埋め込める', () => {
    expect(
      buildPath(apiPaths.noteEntry, { templateId: 'AM01_510037_20240710_交付版', entryId: 'e1' }),
    ).toBe('/templates/AM01_510037_20240710_%E4%BA%A4%E4%BB%98%E7%89%88/notes/e1');
  });
});

describe('MAX_NOTE_ENTRIES_PER_PART', () => {
  it('1 パーツあたりの投稿数上限を持つ', () => {
    expect(MAX_NOTE_ENTRIES_PER_PART).toBe(200);
  });
});
