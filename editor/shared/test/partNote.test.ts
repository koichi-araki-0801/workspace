import { describe, expect, it } from 'vitest';
import { apiPaths, buildPath, MAX_NOTE_ENTRIES_PER_PART } from '../src/index.js';
import {
  AddNoteRequest,
  NoteKind,
  NoteStatus,
  PartNoteEntry,
  UpdateNoteRequest,
} from '../src/schemas.js';

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
      status: 'open',
      replyTo: null,
      kind: 'note',
    });
    expect(parsed.content).toBe('メモ本文');
  });
});

describe('PartNoteEntry のコメント属性', () => {
  const base = {
    id: 'e1',
    templateId: 'AM01_510037_20240710_交付版',
    pathKey: '.page#1/cover#1',
    content: '本文',
    createdAt: '2026-09-01T00:00:00.000Z',
    createdBy: 'editor1',
    updatedAt: null,
    updatedBy: null,
  };

  it('status / replyTo / kind を持つ形を受理する', () => {
    const res = PartNoteEntry.safeParse({
      ...base,
      status: 'resolved',
      replyTo: 'p1',
      kind: 'question',
    });
    expect(res.success).toBe(true);
  });

  it('3 フィールドはいずれも必須(応答はサーバが必ず補う)', () => {
    expect(PartNoteEntry.safeParse(base).success).toBe(false);
  });

  it('列挙の外の値は拒否する', () => {
    expect(NoteStatus.safeParse('closed').success).toBe(false);
    expect(NoteKind.safeParse('todo').success).toBe(false);
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

describe('AddNoteRequest の返信と種別', () => {
  it('kind を省くと note にパースされる', () => {
    const res = AddNoteRequest.parse({ pathKey: 'p', content: 'x' });
    expect(res.kind).toBe('note');
    expect(res.replyTo).toBeNull();
  });

  it('replyTo と kind を受理する', () => {
    const res = AddNoteRequest.parse({
      pathKey: 'p',
      content: 'x',
      replyTo: 'p1',
      kind: 'fix-request',
    });
    expect(res.replyTo).toBe('p1');
    expect(res.kind).toBe('fix-request');
  });

  it('replyTo の空文字は拒否する(親を指さない返信を作らない)', () => {
    expect(AddNoteRequest.safeParse({ pathKey: 'p', content: 'x', replyTo: '' }).success).toBe(
      false,
    );
  });
});

describe('UpdateNoteRequest の部分更新', () => {
  it('content だけ / status だけ / 両方 を受理する', () => {
    expect(UpdateNoteRequest.safeParse({ content: 'x' }).success).toBe(true);
    expect(UpdateNoteRequest.safeParse({ status: 'resolved' }).success).toBe(true);
    expect(UpdateNoteRequest.safeParse({ content: 'x', status: 'open' }).success).toBe(true);
  });

  it('どちらも無い本文は拒否する', () => {
    expect(UpdateNoteRequest.safeParse({}).success).toBe(false);
  });

  it('content の空文字は引き続き拒否する', () => {
    expect(UpdateNoteRequest.safeParse({ content: '', status: 'open' }).success).toBe(false);
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
