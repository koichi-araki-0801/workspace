import { describe, expect, it } from 'vitest';
import { DbStageError, InterruptedError, errorMessage } from '../src/input/dbStage.js';
import {
  DEFAULT_SPROC_NAME,
  MAX_SPROC_TEXT_CHARS,
  formatBaseDateIso,
  hasSprocArgs,
  normalizeBaseDate,
  normalizeSprocArgs,
  resolveSprocName,
} from '../src/input/sprocArgs.js';

describe('DbStageError', () => {
  it('段階とメッセージを持つ', () => {
    const e = new DbStageError('verify', 'hash mismatch');
    expect(e).toBeInstanceOf(Error);
    expect(e.stage).toBe('verify');
    expect(e.message).toBe('hash mismatch');
    expect(e.name).toBe('DbStageError');
  });
  it('InterruptedError は Error の一種', () => {
    expect(new InterruptedError()).toBeInstanceOf(Error);
  });
  it('errorMessage は Error 以外も文字列にする', () => {
    expect(errorMessage(new Error('x'))).toBe('x');
    expect(errorMessage('y')).toBe('y');
  });
});

describe('normalizeBaseDate', () => {
  it('YYYY-MM-DD と YYYYMMDD を YYYYMMDD にそろえる', () => {
    expect(normalizeBaseDate('2026-09-30')).toBe('20260930');
    expect(normalizeBaseDate('20260930')).toBe('20260930');
    expect(normalizeBaseDate(' 2026-09-30 ')).toBe('20260930');
  });
  it('うるう年の 2/29 は通し、平年の 2/29 と 2/30 は拒否する', () => {
    expect(normalizeBaseDate('2028-02-29')).toBe('20280229');
    expect(() => normalizeBaseDate('2026-02-29')).toThrow(/not a real date/);
    expect(() => normalizeBaseDate('2026-02-30')).toThrow(/not a real date/);
    expect(() => normalizeBaseDate('2026-13-01')).toThrow(/not a real date/);
  });
  it('書式が違えば拒否する（区切りの混在・スラッシュ・桁不足）', () => {
    for (const bad of ['2026-0930', '2026/09/30', '2026-9-30', '260930', '']) {
      expect(() => normalizeBaseDate(bad)).toThrow(/YYYY-MM-DD or YYYYMMDD/);
    }
  });
});

describe('formatBaseDateIso', () => {
  it('YYYYMMDD を YYYY-MM-DD にする', () => {
    expect(formatBaseDateIso('20260930')).toBe('2026-09-30');
  });
});

describe('normalizeSprocArgs', () => {
  it('3 つそろっていれば正規化して返す', () => {
    expect(
      normalizeSprocArgs({ fund: ' 0331A ', baseDate: '2026-09-30', chartType: '資産配分' }),
    ).toEqual({ fund: '0331A', baseDate: '20260930', chartType: '資産配分' });
  });
  it('欠けているフラグを列挙して投げる', () => {
    expect(() => normalizeSprocArgs({ fund: 'A' })).toThrow(/missing: --base-date, --chart-type/);
  });
  it('空白だけ・制御文字・上限超えを拒否する', () => {
    const base = { baseDate: '20260930', chartType: 'x' };
    expect(() => normalizeSprocArgs({ ...base, fund: '   ' })).toThrow(/--fund is empty/);
    expect(() => normalizeSprocArgs({ ...base, fund: 'a\tb' })).toThrow(/control character/);
    const max = 'あ'.repeat(MAX_SPROC_TEXT_CHARS);
    expect(normalizeSprocArgs({ ...base, fund: max }).fund).toBe(max);
    expect(() => normalizeSprocArgs({ ...base, fund: `${max}あ` })).toThrow(/limit 64/);
  });
  it('値の文字種は制限しない（バインドで渡すため）', () => {
    const args = normalizeSprocArgs({ fund: "a';--", baseDate: '20260930', chartType: '[x]' });
    expect(args.fund).toBe("a';--");
    expect(args.chartType).toBe('[x]');
  });
});

describe('hasSprocArgs', () => {
  it('どれか 1 つでも指定されていれば true', () => {
    expect(hasSprocArgs({})).toBe(false);
    expect(hasSprocArgs({ chartType: 'x' })).toBe(true);
  });
});

describe('resolveSprocName', () => {
  it('未指定・空白なら既定値', () => {
    expect(resolveSprocName(undefined)).toBe(DEFAULT_SPROC_NAME);
    expect(resolveSprocName('  ')).toBe(DEFAULT_SPROC_NAME);
  });
  it('schema.name と name を受け付ける（日本語を含む）', () => {
    expect(resolveSprocName('dbo.グラフ取得')).toBe('dbo.グラフ取得');
    expect(resolveSprocName('usp_items')).toBe('usp_items');
  });
  it('文へ埋め込むので、角括弧・空白・; ・3 部構成は拒否する', () => {
    for (const bad of ['[dbo].[x]', 'dbo.x; DROP', 'a b', 'db.dbo.x', '1x', 'dbo.']) {
      expect(() => resolveSprocName(bad)).toThrow(/PIE_DB_PROC/);
    }
  });
});
