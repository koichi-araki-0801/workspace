import type { ChangedPart, ReviewPartDecision } from '@editor/shared';
import { describe, expect, it } from 'vitest';
import {
  decisionCounts,
  decisionOf,
  describePartKeys,
  finalizeHint,
  mergeSavedDecisions,
  nextPendingNo,
  rejectedSignature,
} from '@/features/reviews/reviewDecisionState';

const part = (no: number): ChangedPart => ({ no, partKey: `k#${no}` }) as ChangedPart;
const changes = [part(1), part(2), part(3), part(4)];
const dec = (no: number, status: 'approved' | 'rejected' | 'pending'): ReviewPartDecision =>
  ({ partKey: `k#${no}`, status }) as ReviewPartDecision;

describe('reviewDecisionState', () => {
  it('decisionOf は登録が無ければ pending', () => {
    expect(decisionOf([dec(1, 'approved')], 'k#1')).toBe('approved');
    expect(decisionOf([], 'k#1')).toBe('pending');
  });

  it('decisionCounts は取り消しの pending も未判定に数える', () => {
    const c = decisionCounts(changes, [dec(1, 'approved'), dec(2, 'rejected'), dec(3, 'pending')]);
    expect(c).toEqual({ total: 4, approved: 1, rejected: 1, pending: 2 });
  });

  it('nextPendingNo は次の未判定を返し、末尾なら先頭へ回る', () => {
    const ds = [dec(1, 'approved'), dec(2, 'approved')];
    expect(nextPendingNo(changes, ds, 2)).toBe(3);
    expect(nextPendingNo(changes, ds, 4)).toBe(3);
    expect(nextPendingNo(changes, ds, null)).toBe(3);
    expect(
      nextPendingNo(
        changes,
        changes.map((c) => dec(c.no, 'approved')),
        1,
      ),
    ).toBeNull();
  });

  it('mergeSavedDecisions は同じキーを置き換え、無いキーを足す', () => {
    const merged = mergeSavedDecisions(
      [dec(1, 'approved'), dec(2, 'approved')],
      [dec(2, 'pending'), dec(3, 'rejected')],
    );
    expect(merged.map((d) => [d.partKey, d.status])).toEqual([
      ['k#1', 'approved'],
      ['k#2', 'pending'],
      ['k#3', 'rejected'],
    ]);
  });

  it('rejectedSignature は承認の増減で変わらず、却下の増減で変わる', () => {
    const base = rejectedSignature([dec(1, 'rejected')]);
    expect(rejectedSignature([dec(1, 'rejected'), dec(2, 'approved')])).toBe(base);
    expect(rejectedSignature([dec(1, 'rejected'), dec(2, 'rejected')])).not.toBe(base);
  });

  it('finalizeHint は未判定があるときと無いときで文言が違う', () => {
    expect(finalizeHint({ total: 4, approved: 1, rejected: 1, pending: 2 })).toBe(
      '未判定が 2 件あります。すべて判定すると押せます',
    );
    expect(finalizeHint({ total: 4, approved: 3, rejected: 1, pending: 0 })).toBe(
      '承認 3 件を反映し、却下 1 件は現行版のまま残します',
    );
  });
});

describe('describePartKeys', () => {
  const named = (no: number, partKey: string, name: string) =>
    ({ ...part(no), partKey, name }) as ChangedPart & { name: string };
  it('右欄にあるキーだけを「変更 N「名前」」に読み替え、似たキーを取り違えない', () => {
    const rows = [named(1, 'p#1', '表紙'), named(10, 'p#10', '注記'), named(3, '.a#2', '費用')];
    expect(describePartKeys('判定があります: p#10, p#1, .a#2, zz#9 ほか2件。', rows)).toBe(
      '判定があります: 変更 10「注記」, 変更 1「表紙」, 変更 3「費用」, zz#9 ほか2件。',
    );
    expect(describePartKeys('キーの無い文言', rows)).toBe('キーの無い文言');
  });
});
