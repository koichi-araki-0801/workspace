// =============================================================================
// pairSyncText.test.ts — ペア同期の競合バナーと承認直後の通知の文言
// =============================================================================
import type { PairSyncStatus, PairSyncSummary } from '@editor/shared';
import { describe, expect, it } from 'vitest';
import { cssRuleLabel, pairSyncConflictText, pairSyncResultText } from '@/lib/pairSyncText';

const k = (...parts: Array<string | number>): string => JSON.stringify(parts);

const status = (over: Partial<PairSyncStatus>): PairSyncStatus => ({
  pairTemplateId: 'AM01_510037_20240710_全体版',
  pairExists: true,
  conflicts: [],
  cssConflicts: [],
  ...over,
});
const summary = (over: Partial<PairSyncSummary>): PairSyncSummary => ({
  pairTemplateId: 'AM01_510037_20240710_全体版',
  applied: [],
  skipped: [],
  css: null,
  error: null,
  ...over,
});

describe('pairSyncConflictText', () => {
  it('競合が無ければ null', () => {
    expect(pairSyncConflictText(null)).toBeNull();
    expect(pairSyncConflictText(status({}))).toBeNull();
  });

  it('パーツだけの競合は今の文言のまま', () => {
    expect(
      pairSyncConflictText(
        status({ conflicts: [{ partKey: 'p#1', kind: '両側変更', detectedAt: 't' }] }),
      ),
    ).toBe(
      'ペア（AM01_510037_20240710_全体版）と 1 件のパーツが競合しています（自動同期停止中）: p#1〔両側変更〕',
    );
  });

  it('CSS の競合も同じバナーに出す', () => {
    expect(
      pairSyncConflictText(
        status({
          conflicts: [{ partKey: 'p#1', kind: '初期差分', detectedAt: 't' }],
          cssConflicts: [{ ruleKey: k('.a'), detectedAt: 't' }],
        }),
      ),
    ).toBe(
      'ペア（AM01_510037_20240710_全体版）と 1 件のパーツと書式の規則 1 件が競合しています（自動同期停止中）: p#1〔初期差分〕、書式 .a',
    );
    expect(
      pairSyncConflictText(status({ cssConflicts: [{ ruleKey: k('.a'), detectedAt: 't' }] })),
    ).toBe(
      'ペア（AM01_510037_20240710_全体版）と 書式の規則 1 件が競合しています（自動同期停止中）: 書式 .a',
    );
  });

  it('削除の競合は削除した版種で書く', () => {
    const text = pairSyncConflictText(
      status({
        conflicts: [
          { partKey: 'p#1', kind: 'ペア側削除', detectedAt: 't', deletedIn: '全体版' },
          { partKey: 'q#1', kind: 'ペア側削除・ソース変更', detectedAt: 't', deletedIn: '全体版' },
          { partKey: 'r#1', kind: 'ペア側削除・ソース変更', detectedAt: 't', deletedIn: '交付版' },
        ],
      }),
    );
    expect(text).toContain('p#1〔全体版で削除〕');
    expect(text).toContain('q#1〔全体版で削除・交付版で変更〕');
    expect(text).toContain('r#1〔交付版で削除・全体版で変更〕');
  });

  it('deletedIn の無い削除の記録は種類名で出す', () => {
    const text = pairSyncConflictText(
      status({ conflicts: [{ partKey: 'p#1', kind: 'ペア側削除', detectedAt: 't' }] }),
    );
    expect(text).toContain('p#1〔ペア側削除〕');
  });

  it('照合不可の書式は印を付け、1 件でもあれば説明の 1 文を末尾に足す', () => {
    const text = pairSyncConflictText(
      status({
        cssConflicts: [
          { ruleKey: k('.a'), detectedAt: 't', kind: '照合不可' },
          { ruleKey: k('.b'), detectedAt: 't' },
        ],
      }),
    );
    expect(text).toContain('書式 .a〔照合不可〕');
    expect(text).toContain('書式 .b');
    expect(text?.endsWith('次から照合できます。')).toBe(true);
    expect(
      pairSyncConflictText(status({ cssConflicts: [{ ruleKey: k('.b'), detectedAt: 't' }] })),
    ).not.toContain('照合不可');
  });
});

describe('cssRuleLabel', () => {
  it('規則のキー(JSON 配列)を前置きとセレクタを空白でつないだ形にし、出現番号を添える', () => {
    expect(cssRuleLabel(k('.a'))).toBe('.a');
    expect(cssRuleLabel(k('@media print', '.a .b'))).toBe('@media print .a .b');
    expect(cssRuleLabel(k('.a', 2))).toBe('.a（2 番目）');
  });

  it('長い識別子(@font-face{…} など)は 40 文字で切る', () => {
    const label = cssRuleLabel(
      k(`@font-face{font-family:A;src:url(fonts/${'x'.repeat(60)}.woff2)}`),
    );
    expect(label.length).toBe(41);
    expect(label.endsWith('…')).toBe(true);
  });

  it('形の違うキーはそのまま出す', () => {
    expect(cssRuleLabel('not json')).toBe('not json');
    expect(cssRuleLabel('{"a":1}')).toBe('{"a":1}');
  });
});

describe('pairSyncResultText', () => {
  it('同期なし・何も起きなければ null', () => {
    expect(pairSyncResultText(null)).toBeNull();
    expect(pairSyncResultText(summary({}))).toBeNull();
  });

  it('失敗は error', () => {
    expect(pairSyncResultText(summary({ error: '読めない' }))).toEqual({
      text: 'ペア(AM01_510037_20240710_全体版)への自動同期に失敗しました: 読めない',
      variant: 'error',
    });
  });

  it('パーツだけなら今の文言のまま、CSS を写したら規則数を添える', () => {
    expect(pairSyncResultText(summary({ applied: ['p#1'] }))?.text).toBe(
      'ペア AM01_510037_20240710_全体版 へ 1 パーツを自動同期しました',
    );
    expect(
      pairSyncResultText(
        summary({ applied: ['p#1'], css: { applied: ['.a', '.b'], conflicts: ['.c'] } }),
      )?.text,
    ).toBe(
      'ペア AM01_510037_20240710_全体版 へ 1 パーツ・書式 2 規則を自動同期しました・スキップ 1 件(要確認)',
    );
  });
});
