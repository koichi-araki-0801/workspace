import type { PartHistoryEntry } from '@editor/shared';
import { describe, expect, it } from 'vitest';
import { groupHistoryByPart, type RejectedReason } from '@/features/editor/historyGroups';
import type { ChangeNumbers } from '@/features/editor/useChangeNumbers';

const h = (id: string, partKey: string): PartHistoryEntry => ({
  id,
  partKey,
  change: `変更${id}`,
  timestamp: '2026-10-28T00:00:00Z',
  user: 'u',
});
const names: Record<string, string> = { a: 'A', b: 'B', c: 'C', d: 'D' };
const nameOf = (k: string) => names[k] ?? '';
const numbers = (
  byKey: [string, number][],
  removed: ChangeNumbers['removed'] = [],
): ChangeNumbers => ({
  byKey: new Map(byKey),
  removed,
});

describe('groupHistoryByPart', () => {
  it('番号順 → 番号なし(紙面順) → 紙面に無い の順に並べる', () => {
    const groups = groupHistoryByPart({
      entries: [h('1', 'x'), h('2', 'd'), h('3', 'b'), h('4', 'a')],
      numbers: numbers([
        ['c', 2],
        ['a', 1],
      ]),
      partOrder: ['a', 'b', 'c', 'd'],
      nameOf,
    });
    expect(groups.map((g) => [g.key, g.no, g.offCanvas])).toEqual([
      ['a', 1, false],
      ['c', 2, false],
      ['b', null, false],
      ['d', null, false],
      ['x', null, true],
    ]);
    expect(groups[0].entries.map((e) => e.id)).toEqual(['4']);
    expect(groups[4].name).toBe('削除済みパーツ');
  });

  it('番号ありは履歴 0 件でも見出しを作り、番号なしで履歴も理由も無いパーツは出さない', () => {
    const groups = groupHistoryByPart({
      entries: [],
      numbers: numbers([['a', 1]]),
      partOrder: ['a', 'b'],
      nameOf,
    });
    expect(groups).toHaveLength(1);
    expect(groups[0].entries).toEqual([]);
  });

  it('削除パーツは removed と「（削除）」を持ち、確定版側のキーで履歴を引く', () => {
    const groups = groupHistoryByPart({
      entries: [h('1', 'gone'), h('2', 'a')],
      numbers: numbers([['a', 2]], [{ no: 1, key: 'gone', name: '旧' }]),
      partOrder: ['a'],
      nameOf,
    });
    expect(groups.map((g) => g.no)).toEqual([1, 2]);
    expect(groups[0]).toMatchObject({ removed: true, name: '旧（削除）', offCanvas: false });
    expect(groups[0].entries.map((e) => e.id)).toEqual(['1']);
  });

  it('削除パーツのキーが紙面にもあれば履歴は紙面側だけに出す', () => {
    const groups = groupHistoryByPart({
      entries: [h('1', 'a')],
      numbers: numbers([['a', 2]], [{ no: 1, key: 'a', name: '旧' }]),
      partOrder: ['a'],
      nameOf,
    });
    expect(groups[0].entries).toEqual([]);
    expect(groups[1].entries).toHaveLength(1);
  });

  it('却下の理由は番号なし・紙面外のキーにも付き、理由だけでも見出しを作る', () => {
    const r: RejectedReason = { by: 'x', at: '2026-10-28T00:00:00Z', reason: '理由' };
    const groups = groupHistoryByPart({
      entries: [],
      numbers: numbers([['a', 1]], [{ no: 2, key: 'gone', name: '旧' }]),
      partOrder: ['a', 'b'],
      nameOf,
      rejected: new Map([
        ['a', r],
        ['b', r],
        ['gone', r],
        ['zz', r],
      ]),
    });
    expect(groups.map((g) => [g.key, g.rejected === r])).toEqual([
      ['a', true],
      ['gone', true],
      ['b', true],
      ['zz', true],
    ]);
  });

  it('紙面外のキーの名前は offCanvasNameOf を最優先で使う', () => {
    const groups = groupHistoryByPart({
      entries: [h('1', 'x')],
      numbers: numbers([]),
      partOrder: [],
      nameOf,
      offCanvasNameOf: (k) => (k === 'x' ? '申請の本文の名前' : undefined),
    });
    expect(groups[0].name).toBe('申請の本文の名前');
  });
});
