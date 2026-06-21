import { describe, expect, it } from 'vitest';
import {
  clampMarginMm,
  clampWidthPct,
  DEFAULT_GEOM,
  geomChangeLabel,
  geomFromStyle,
  geomToStyle,
  type LayoutGeom,
  MARGIN_MM_MAX,
  MARGIN_MM_MIN,
  PX_PER_MM,
  pageContentPx,
  WIDTH_PCT_MAX,
  WIDTH_PCT_MIN,
} from '@/features/editor/geom';

describe('clamp helpers', () => {
  it('clampWidthPct clamps into [MIN, MAX]', () => {
    expect(clampWidthPct(5)).toBe(WIDTH_PCT_MIN);
    expect(clampWidthPct(50)).toBe(50);
    expect(clampWidthPct(150)).toBe(WIDTH_PCT_MAX);
  });
  it('clampMarginMm clamps into [MIN, MAX]', () => {
    expect(clampMarginMm(-10)).toBe(MARGIN_MM_MIN);
    expect(clampMarginMm(20)).toBe(20);
    expect(clampMarginMm(999)).toBe(MARGIN_MM_MAX);
  });
});

describe('geomFromStyle', () => {
  it('treats an empty style as full-width / stretch', () => {
    expect(geomFromStyle({})).toMatchObject({ widthPct: 100, align: 'stretch', indent: 0 });
  });

  it('reads width and derives center from auto left+right margins', () => {
    const g = geomFromStyle({ width: '60%', 'margin-left': 'auto', 'margin-right': 'auto' });
    expect(g.widthPct).toBe(60);
    expect(g.align).toBe('center');
  });

  it('derives right alignment from auto left margin only', () => {
    expect(geomFromStyle({ width: '50%', 'margin-left': 'auto' }).align).toBe('right');
  });

  it('derives left alignment and reads indent from a fixed left margin', () => {
    const g = geomFromStyle({ width: '50%', 'margin-left': '8mm' });
    expect(g.align).toBe('left');
    expect(g.indent).toBe(8);
  });

  it('parses mm and px margins (px → mm via PX_PER_MM)', () => {
    expect(geomFromStyle({ 'margin-top': '10mm' }).marginTop).toBe(10);
    const px = geomFromStyle({ 'margin-bottom': `${PX_PER_MM * 5}px` });
    expect(px.marginBottom).toBe(5);
  });

  it('falls back to 0mm for unparseable lengths', () => {
    expect(geomFromStyle({ 'margin-top': 'oops' }).marginTop).toBe(0);
  });

  it('reads page breaks under both legacy and modern property names', () => {
    expect(geomFromStyle({ 'page-break-before': 'always' }).pageBreakBefore).toBe(true);
    expect(geomFromStyle({ 'break-before': 'page' }).pageBreakBefore).toBe(true);
    expect(geomFromStyle({ 'page-break-after': 'always' }).pageBreakAfter).toBe(true);
    expect(geomFromStyle({ 'break-inside': 'avoid' }).keepTogether).toBe(true);
    expect(geomFromStyle({ 'page-break-inside': 'avoid' }).keepTogether).toBe(true);
  });
});

describe('geomToStyle', () => {
  it('clears width and margins for the default (stretch) geometry', () => {
    const s = geomToStyle(DEFAULT_GEOM);
    expect(s.width).toBe('');
    expect(s['margin-left']).toBe('');
    expect(s['margin-right']).toBe('');
  });

  it('emits centered auto margins for a narrow centered block', () => {
    const s = geomToStyle({ ...DEFAULT_GEOM, widthPct: 50, align: 'center' });
    expect(s.width).toBe('50%');
    expect(s['margin-left']).toBe('auto');
    expect(s['margin-right']).toBe('auto');
  });

  it('emits a left indent for a left-aligned narrow block', () => {
    const s = geomToStyle({ ...DEFAULT_GEOM, widthPct: 40, align: 'left', indent: 12 });
    expect(s['margin-left']).toBe('12mm');
    expect(s['margin-right']).toBe('auto');
  });

  it('round-trips a non-trivial geometry through from→to→from', () => {
    const start: LayoutGeom = {
      widthPct: 70,
      align: 'center',
      indent: 0,
      marginTop: 5,
      marginBottom: 8,
      pageBreakBefore: true,
      pageBreakAfter: false,
      keepTogether: true,
    };
    expect(geomFromStyle(geomToStyle(start))).toEqual(start);
  });
});

describe('pageContentPx', () => {
  const mm = (n: number) => n * PX_PER_MM;

  it('falls back to the 18mm canvas padding when no @page margin is present', () => {
    // 297 - 18 - 18 = 261mm
    expect(pageContentPx('body { color: red; }')).toBeCloseTo(mm(261), 5);
  });

  it('reads symmetric @page margin (top/bottom = single value)', () => {
    // @page { margin: 20mm } → 297 - 20 - 20 = 257mm
    expect(pageContentPx('@page { size: A4; margin: 20mm; }')).toBeCloseTo(mm(257), 5);
  });

  it('reads vertical/horizontal @page margin (2 values use top for both)', () => {
    // @page { margin: 14mm 13mm } → top = bottom = 14mm → 297 - 28 = 269mm
    expect(pageContentPx('@page { margin: 14mm 13mm; }')).toBeCloseTo(mm(269), 5);
  });

  it('reads distinct top/bottom from a 4-value @page margin', () => {
    // margin: top right bottom left = 10 16 24 16 → 297 - 10 - 24 = 263mm
    expect(pageContentPx('@page { margin: 10mm 16mm 24mm 16mm; }')).toBeCloseTo(mm(263), 5);
  });
});

describe('geomChangeLabel', () => {
  it('returns null when nothing changed', () => {
    expect(geomChangeLabel(DEFAULT_GEOM, { ...DEFAULT_GEOM })).toBeNull();
  });
  it('reports the first changed field (width before align)', () => {
    const label = geomChangeLabel(DEFAULT_GEOM, { ...DEFAULT_GEOM, widthPct: 50 });
    expect(label).toContain('幅');
  });
  it('reports a margin change', () => {
    const label = geomChangeLabel(DEFAULT_GEOM, { ...DEFAULT_GEOM, marginTop: 3 });
    expect(label).toContain('上の余白');
  });
  it('reports a page-break toggle', () => {
    const label = geomChangeLabel(DEFAULT_GEOM, { ...DEFAULT_GEOM, pageBreakAfter: true });
    expect(label).toContain('後で改ページ');
  });
  it('reports a keep-together toggle', () => {
    const label = geomChangeLabel(DEFAULT_GEOM, { ...DEFAULT_GEOM, keepTogether: true });
    expect(label).toContain('分割しない');
  });
});
