import { describe, expect, it } from 'vitest';
import { createPieLayoutConfig } from '../src/config.js';
import {
  leaderPath,
  buildOutsideRimDraft,
  topBandSonohokaZone,
  type LabelForm,
} from '../src/layout/placement.js';
import type { LayoutItemReady, Scale } from '../src/types.js';

const cfg = createPieLayoutConfig();
// 論理→ピクセルの単純な恒等寄りスケール (テスト用)。
const xScale: Scale = (v) => 100 + v * 50;
const yScale: Scale = (v) => 100 - v * 50;

describe('leaderPath', () => {
  it('点列を M/L コマンドの SVG path 要素に変換する', () => {
    const svg = leaderPath(
      xScale,
      yScale,
      [
        { x: 0, y: 0 },
        { x: 1, y: 1 },
      ],
      cfg,
    );
    expect(svg).toContain('<path');
    expect(svg).toContain('fill="none"');
    expect(svg).toContain(`stroke="${cfg.lineColor}"`);
    // 1 点目は M、以降は L
    expect(svg).toMatch(/d="M100,100 L150,50"/);
  });

  it('stroke-width に leaderStrokeUnits を反映する', () => {
    const svg = leaderPath(xScale, yScale, [{ x: 0, y: 0 }], cfg);
    expect(svg).toContain(`stroke-width="${cfg.leaderStrokeUnits}"`);
  });
});

describe('topBandSonohokaZone', () => {
  const zone = (name: string, midAngle: number) => topBandSonohokaZone({ name, midAngle });

  it("コア帯 (90°±18°) は 'core'", () => {
    expect(zone('その他', 72)).toBe('core');
    expect(zone('その他', 90)).toBe('core');
    expect(zone('その他', 108)).toBe('core');
  });

  it("左拡張帯 (108°,122°] は 'leftExt'", () => {
    expect(zone('その他', 108.1)).toBe('leftExt');
    expect(zone('その他', 115.2)).toBe('leftExt'); // fidelity_foreign_bond_country の実角
    expect(zone('その他', 122)).toBe('leftExt');
  });

  it('帯外は null', () => {
    expect(zone('その他', 122.1)).toBe(null);
    expect(zone('その他', 71.9)).toBe(null);
    expect(zone('その他', 129.5)).toBe(null); // world_bond_idx_country は対象外のまま
    expect(zone('その他', 270)).toBe(null);
  });

  it('名前が「その他」前方一致でなければ角度に依らず null', () => {
    expect(zone('アメリカ', 90)).toBe(null);
    expect(zone('その他資産', 115)).toBe('leftExt'); // 前方一致は対象
  });
});

describe('buildOutsideRimDraft: 上部その他の帯ルーティング', () => {
  const makeForm = (): LabelForm => ({
    rank: 2,
    lineCount: 2,
    nameScaleX: 1,
    inside: false,
    name: 'その他',
    percent: '14.0%',
    lines: ['その他', '14.0%'],
    condenseNamePortionOnly: false,
    width: 0.5,
    height: 0.35,
  });
  const makeItem = (midAngle: number, extra: Partial<LayoutItemReady> = {}): LayoutItemReady => {
    const rad = (midAngle * Math.PI) / 180;
    return {
      name: 'その他',
      midAngle,
      anchorX: Math.cos(rad) * cfg.pieRadius,
      anchorY: Math.sin(rad) * cfg.pieRadius,
      ...extra,
    } as LayoutItemReady;
  };

  it('左拡張帯 (115.2°) は真上垂直 center 配置 (textX=anchorX・垂直 leader)', () => {
    const item = makeItem(115.2);
    const draft = buildOutsideRimDraft(item, cfg, makeForm());
    expect(draft.anchor).toBe('middle');
    expect(draft.textX).toBe(item.anchorX);
    expect(draft.lineStart.x).toBe(draft.lineEnd.x); // 垂直 leader
    expect(draft.forceTopRight).toBeFalsy();
  });

  it('帯外 (122.1°) は汎用 rim 配置 (anchor=end・rim 上の textY)', () => {
    const item = makeItem(122.1);
    const draft = buildOutsideRimDraft(item, cfg, makeForm());
    expect(draft.anchor).toBe('end'); // cos(122.1°) < -閾値 → 左側 rim
    expect(draft.textX).toBeLessThan(0);
    // 真上 center 配置 (textY=viewBox 上端寄り) ではなく rim 上 (sin*r)。
    expect(draft.textY).toBeCloseTo(Math.sin((122.1 * Math.PI) / 180) * cfg.pieRadius, 6);
  });

  it('コア帯 (108°) は従来どおり右上逃がし (forceTopRight)', () => {
    const item = makeItem(108);
    const draft = buildOutsideRimDraft(item, cfg, makeForm());
    expect(draft.forceTopRight).toBe(true);
    expect(draft.anchor).toBe('start');
    expect(draft.textX).toBeGreaterThan(0);
  });

  it('コア帯 (108°) + topRightRejected は真上垂直 center 配置', () => {
    const item = makeItem(108, { topRightRejected: true });
    const draft = buildOutsideRimDraft(item, cfg, makeForm());
    expect(draft.anchor).toBe('middle');
    expect(draft.textX).toBe(item.anchorX);
    expect(draft.lineStart.x).toBe(draft.lineEnd.x);
  });
});
