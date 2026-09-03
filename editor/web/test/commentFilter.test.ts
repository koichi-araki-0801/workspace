import type { PartNoteEntry } from '@editor/shared';
import { describe, expect, it } from 'vitest';
import {
  authorsOf,
  DEFAULT_COMMENT_FILTER,
  filterThreads,
  formatCommentAt,
  openKeysOf,
  openThreadCount,
  threadsOf,
} from '@/features/editor/comments/commentFilter';

const TPL = 'AM01_510037_20240710_交付版';
const COVER = '.page#1/cover#1';
const SUMMARY = '.page#1/.summary#1';

function entry(p: Partial<PartNoteEntry> & { id: string }): PartNoteEntry {
  return {
    templateId: TPL,
    pathKey: COVER,
    content: '',
    createdAt: '2026-09-01T00:00:00.000Z',
    createdBy: 'editor1',
    updatedAt: null,
    updatedBy: null,
    status: 'open',
    replyTo: null,
    kind: 'note',
    ...p,
  };
}

const ctx = {
  selectedKey: COVER,
  partOrder: new Map([
    [COVER, 0],
    [SUMMARY, 1],
  ]),
};

describe('threadsOf', () => {
  it('親ごとに返信を集め、親の作成順に並べる', () => {
    const list = [
      entry({ id: 'p1', createdAt: '2026-09-01T00:00:01.000Z' }),
      entry({ id: 'r1', replyTo: 'p1', createdAt: '2026-09-01T00:00:03.000Z' }),
      entry({ id: 'p2', createdAt: '2026-09-01T00:00:02.000Z', pathKey: SUMMARY }),
    ];
    const t = threadsOf(list);
    expect(t.map((x) => x.parent.id)).toEqual(['p1', 'p2']);
    expect(t[0].replies.map((r) => r.id)).toEqual(['r1']);
    expect(t[0].lastAt).toBe('2026-09-01T00:00:03.000Z');
  });

  it('親の無い返信は捨てる(表示先が無い)', () => {
    expect(threadsOf([entry({ id: 'r', replyTo: 'gone' })])).toEqual([]);
  });

  it('lastAt は本文の編集日時も見る', () => {
    const t = threadsOf([entry({ id: 'p', updatedAt: '2026-09-02T00:00:00.000Z' })]);
    expect(t[0].lastAt).toBe('2026-09-02T00:00:00.000Z');
  });
});

describe('filterThreads', () => {
  const threads = threadsOf([
    entry({
      id: 'a',
      content: '表紙の日付',
      createdBy: '山田',
      kind: 'fix-request',
      createdAt: '2026-09-01T00:00:01.000Z',
    }),
    entry({
      id: 'a-r',
      replyTo: 'a',
      content: '直しました',
      createdBy: '鈴木',
      createdAt: '2026-09-01T00:00:05.000Z',
    }),
    entry({
      id: 'b',
      content: '要約の数値',
      createdBy: '鈴木',
      pathKey: SUMMARY,
      status: 'resolved',
      kind: 'question',
      createdAt: '2026-09-01T00:00:02.000Z',
    }),
    entry({ id: 'c', content: 'ロゴ', createdBy: '山田', createdAt: '2026-09-01T00:00:03.000Z' }),
  ]);

  it('既定は未対応だけを更新日時の降順で返す', () => {
    const out = filterThreads(threads, DEFAULT_COMMENT_FILTER, ctx);
    expect(out.map((t) => t.parent.id)).toEqual(['a', 'c']);
  });

  it('検索は本文と投稿者を見て、返信の本文も対象にする', () => {
    const q = (query: string) =>
      filterThreads(threads, { ...DEFAULT_COMMENT_FILTER, status: 'all', query }, ctx).map(
        (t) => t.parent.id,
      );
    expect(q('数値')).toEqual(['b']);
    expect(q('鈴木')).toEqual(['a', 'b']);
    expect(q('直しました')).toEqual(['a']);
  });

  it('状態・種別・投稿者・選択パーツで絞り込める', () => {
    const f = DEFAULT_COMMENT_FILTER;
    expect(
      filterThreads(threads, { ...f, status: 'resolved' }, ctx).map((t) => t.parent.id),
    ).toEqual(['b']);
    expect(
      filterThreads(threads, { ...f, status: 'all', kinds: new Set(['question']) }, ctx).map(
        (t) => t.parent.id,
      ),
    ).toEqual(['b']);
    expect(
      filterThreads(threads, { ...f, status: 'all', author: '山田' }, ctx).map((t) => t.parent.id),
    ).toEqual(['a', 'c']);
    expect(
      filterThreads(threads, { ...f, status: 'all', onlySelected: true }, ctx).map(
        (t) => t.parent.id,
      ),
    ).toEqual(['a', 'c']);
  });

  it('パーツ順の並びは partOrder に従い、同じパーツ内は作成順', () => {
    const out = filterThreads(
      threads,
      { ...DEFAULT_COMMENT_FILTER, status: 'all', sort: 'part' },
      ctx,
    );
    expect(out.map((t) => t.parent.id)).toEqual(['a', 'c', 'b']);
  });

  it('partOrder に無いパーツは末尾へ回す', () => {
    const out = filterThreads(
      threads,
      { ...DEFAULT_COMMENT_FILTER, status: 'all', sort: 'part' },
      { selectedKey: null, partOrder: new Map([[SUMMARY, 0]]) },
    );
    expect(out.map((t) => t.parent.id)).toEqual(['b', 'a', 'c']);
  });
});

describe('authorsOf / openKeysOf', () => {
  it('投稿者は重複を除いて出現順', () => {
    expect(
      authorsOf([
        entry({ id: '1', createdBy: 'b' }),
        entry({ id: '2', createdBy: 'a' }),
        entry({ id: '3', createdBy: 'b' }),
      ]),
    ).toEqual(['b', 'a']);
  });

  it('未対応の親を持つパーツだけを返す(返信の状態は見ない)', () => {
    const keys = openKeysOf([
      entry({ id: 'p', status: 'resolved' }),
      entry({ id: 'q', pathKey: SUMMARY }),
      entry({ id: 'q-r', pathKey: SUMMARY, replyTo: 'q', status: 'open' }),
    ]);
    expect([...keys]).toEqual([SUMMARY]);
  });
});

describe('openThreadCount', () => {
  it('未対応の親投稿だけを数える(返信・パーツ数は数えない)', () => {
    const count = openThreadCount([
      entry({ id: 'p1', status: 'open' }),
      entry({ id: 'p1-r', replyTo: 'p1', status: 'open' }),
      entry({ id: 'p2', pathKey: SUMMARY, status: 'open' }),
      entry({ id: 'p3', status: 'resolved' }),
    ]);
    expect(count).toBe(2);
  });
});

describe('formatCommentAt', () => {
  it('ISO 日時を月/日 時:分へ整形する', () => {
    expect(formatCommentAt('2026-09-01T09:05:00.000Z')).toMatch(/^\d{2}\/\d{2} \d{2}:\d{2}$/);
  });
});
