import { describe, expect, it } from 'vitest';
import { EDITION_SYNC_PAIRS, pairedTemplateId, templatePairKey } from '../src/index';

describe('pairedTemplateId', () => {
  it('交付版 の ID から 全体版 の ID を導く', () => {
    expect(pairedTemplateId('AM01_510037_20240710_交付版')).toBe('AM01_510037_20240710_全体版');
  });

  it('全体版 の ID から 交付版 の ID を導く(相互対応)', () => {
    expect(pairedTemplateId('AM01_510037_20240710_全体版')).toBe('AM01_510037_20240710_交付版');
  });

  it('ペア対象外の版種(旧 kr 等)は null', () => {
    expect(pairedTemplateId('AM01_510037_20240710_kr')).toBeNull();
    expect(pairedTemplateId('AM01_510037_20240710_確報')).toBeNull();
  });

  it('ファイル名規約外の ID は null', () => {
    expect(pairedTemplateId('AM01_510037_20240710')).toBeNull();
    expect(pairedTemplateId('')).toBeNull();
  });

  it('版種が Object.prototype の継承キーと一致しても null(プロトタイプ汚染ルックアップの防止)', () => {
    // EDITION_SYNC_PAIRS はリクエスト由来の editionType でそのまま引かれる
    // (GET /templates/:templateId/notes 経由)。プレーンなオブジェクトリテラルだと
    // `constructor`/`toString` 等が Object.prototype から継承されて解決してしまい、
    // 本来ペア対象外の版種にペアが付いてしまう。
    expect(pairedTemplateId('AM01_510037_20240710_constructor')).toBeNull();
    expect(pairedTemplateId('AM01_510037_20240710_toString')).toBeNull();
    expect(pairedTemplateId('AM01_510037_20240710_hasOwnProperty')).toBeNull();
  });
});

describe('EDITION_SYNC_PAIRS', () => {
  it('交付版⇄全体版 が相互に対応している(片方向の定義漏れを防ぐ)', () => {
    for (const [from, to] of Object.entries(EDITION_SYNC_PAIRS)) {
      expect(EDITION_SYNC_PAIRS[to]).toBe(from);
    }
  });
});

describe('templatePairKey', () => {
  it('版種を除いた 3 属性を結合し、ペアの双方で同一キーになる', () => {
    const a = { companyCode: 'AM01', fundCode: '510037', baseDate: '20240710' };
    expect(templatePairKey({ ...a, editionType: '交付版' })).toBe('AM01_510037_20240710');
    expect(templatePairKey({ ...a, editionType: '全体版' })).toBe('AM01_510037_20240710');
  });
});
