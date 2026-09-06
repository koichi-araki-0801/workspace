import { describe, expect, it } from 'vitest';
import { createPieLayoutConfig } from '../src/config.js';
import type { LayoutItem, LayoutItemReady, PieLayoutConfig, Placement } from '../src/types.js';
import {
  angleInBand,
  arcAngles,
  boxOverlapAmount,
  clampBendOutsideBox,
  degToRad,
  estimateTextExtent,
  estimateVerifyTextExtent,
  fitsInsideSlice,
  fitsInsideSliceExtent,
  flipTopRightX,
  getLabelLines,
  horizontalLowerLeftDropAmount,
  labelHeightUnits,
  labelOutwardClearance,
  leaderAttachTargetY,
  leaderBendPoint,
  leaderCrossesBox,
  lowerLeftDeepBoundaryY,
  normalizeAngle,
  nudgeTextAwayFromEndpoint,
  nudgeTextAwayFromPie,
  nudgeTextAwayFromSegment,
  pieHorizontalLowerLeftAnchorYBound,
  pieYAtX,
  placementBox,
  placementExtent,
  polarToCartesian,
  projectLabelPoint,
  projectLeftRingPoint,
  radialFraction,
  scaledLabelWidthUnits,
  segmentsIntersect,
  textBoxBounds,
  topAngleOffset,
  topBandUpperLeftTarget,
  topBandY,
  truncateLeaderEndpointAtBox,
  upperLeftAngleProgress,
  upperLeftBendPoint,
  upperLeftHorizontalLen,
  upperLeftTarget,
  visualCharEm,
  visualMaxEm,
  visualTextWidthUnits,
} from '../src/layout/geometry.js';

const cfg: PieLayoutConfig = createPieLayoutConfig();

function makeReady(overrides: Partial<LayoutItemReady> = {}): LayoutItemReady {
  return {
    name: 'サンプル',
    value: 30,
    midAngle: 135,
    anchorX: -0.7,
    anchorY: 0.7,
    naturalY: 0.7,
    textLines: 2,
    finalX: -1.2,
    finalY: 0.9,
    upperLeftRenderY: 0,
    percentText: '30.0%',
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// 角度ヘルパー
// ---------------------------------------------------------------------------
describe('normalizeAngle', () => {
  it('[0, 360) に正規化する', () => {
    expect(normalizeAngle(0)).toBe(0);
    expect(normalizeAngle(360)).toBe(0);
    expect(normalizeAngle(450)).toBe(90);
    expect(normalizeAngle(-90)).toBe(270);
    expect(normalizeAngle(-360)).toBe(0);
    expect(normalizeAngle(720 + 45)).toBe(45);
  });
});

describe('angleInBand', () => {
  it('帯の内側を true、外側を false にする', () => {
    expect(angleInBand(10, 0, 20)).toBe(true);
    expect(angleInBand(100, 0, 20)).toBe(false);
  });
  it('360 跨ぎを両方向で対称に扱う', () => {
    expect(angleInBand(350, 0, 20)).toBe(true); // angle>center 側の wrap
    expect(angleInBand(5, 355, 20)).toBe(true); // center>angle 側の wrap
    expect(angleInBand(370, 360, 20)).toBe(true);
    expect(angleInBand(180, 0, 20)).toBe(false); // 反対側は範囲外
  });
});

describe('topAngleOffset', () => {
  it('12時(90°)からの最小角度差を返す', () => {
    expect(topAngleOffset(90)).toBe(0);
    expect(topAngleOffset(120)).toBe(30);
    expect(topAngleOffset(60)).toBe(30);
    expect(topAngleOffset(270)).toBe(180);
  });
});

describe('degToRad / polarToCartesian', () => {
  it('度をラジアンに変換する', () => {
    expect(degToRad(180)).toBeCloseTo(Math.PI);
    expect(degToRad(90)).toBeCloseTo(Math.PI / 2);
  });
  it('極座標を直交座標に変換する', () => {
    expect(polarToCartesian(1, 0)).toEqual({ x: 1, y: 0 });
    const p = polarToCartesian(2, Math.PI / 2);
    expect(p.x).toBeCloseTo(0);
    expect(p.y).toBeCloseTo(2);
  });
});

describe('radialFraction', () => {
  it('min と (scaledRadialExitLen × factor) の大きい方を返す', () => {
    expect(radialFraction(cfg, 0.5, 1.0)).toBe(0.5);
    expect(radialFraction(cfg, 0.0, 1.0)).toBeCloseTo(cfg.scaledRadialExitLen);
  });
});

describe('arcAngles', () => {
  it('値配列から弧スパンを返す', () => {
    const spans = arcAngles([1, 1, 1, 1], cfg);
    expect(spans).toHaveLength(4);
    expect(spans[0].startAngle).toBeCloseTo(degToRad(90));
    // span 合計は 2π
    const total = spans.reduce((s, a) => s + Math.abs(a.endAngle - a.startAngle), 0);
    expect(total).toBeCloseTo(2 * Math.PI);
  });
  it('counterclock で符号が反転する', () => {
    const cw = arcAngles([1, 1], cfg);
    const ccw = arcAngles([1, 1], createPieLayoutConfig({ counterclock: true }));
    expect(Math.sign(cw[0].endAngle - cw[0].startAngle)).toBe(-1);
    expect(Math.sign(ccw[0].endAngle - ccw[0].startAngle)).toBe(1);
  });
  it('合計が 0 以下なら投げる', () => {
    expect(() => arcAngles([], cfg)).toThrow();
    expect(() => arcAngles([1, -1], cfg)).toThrow();
  });
});

describe('pieYAtX', () => {
  it('円周上の y を返し範囲外は 0 にクランプする', () => {
    expect(pieYAtX(0, cfg)).toBeCloseTo(1);
    expect(pieYAtX(1, cfg)).toBeCloseTo(0);
    expect(pieYAtX(2, cfg)).toBe(0);
    expect(pieYAtX(0.6, cfg)).toBeCloseTo(0.8);
  });
});

describe('upperLeftAngleProgress', () => {
  it('90°→180° を [0,1] に正規化しクランプする', () => {
    expect(upperLeftAngleProgress(90)).toBe(0);
    expect(upperLeftAngleProgress(135)).toBeCloseTo(0.5);
    expect(upperLeftAngleProgress(180)).toBe(1);
    expect(upperLeftAngleProgress(45)).toBe(0);
    expect(upperLeftAngleProgress(200)).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// 寸法・高さ
// ---------------------------------------------------------------------------
describe('labelHeightUnits / 境界ヘルパー', () => {
  it('行数に比例する高さ', () => {
    const h1 = labelHeightUnits(1, cfg);
    const h2 = labelHeightUnits(2, cfg);
    expect(h1).toBeGreaterThan(0);
    expect(h2).toBeCloseTo(2 * h1);
  });
  it('lower-left 境界系は符号が期待どおり', () => {
    expect(pieHorizontalLowerLeftAnchorYBound(cfg)).toBeLessThan(0);
    expect(lowerLeftDeepBoundaryY(cfg)).toBeLessThan(0);
    expect(horizontalLowerLeftDropAmount(cfg)).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// リング射影
// ---------------------------------------------------------------------------
describe('projectLabelPoint', () => {
  it('ラベルリング半径上へ射影する', () => {
    const target = projectLabelPoint(0.3, 0.4, cfg);
    const r = Math.hypot(target.x, target.y);
    const r2 = Math.hypot(projectLabelPoint(1, 0, cfg).x, projectLabelPoint(1, 0, cfg).y);
    expect(r).toBeCloseTo(r2); // 全点が同一半径
  });
  it('原点は (targetRadius, 0) を返す', () => {
    const p = projectLabelPoint(0, 0, cfg);
    expect(p.y).toBe(0);
    expect(p.x).toBeGreaterThan(0);
  });
});

describe('projectLeftRingPoint', () => {
  it('常に左側 (x<=0) のリング点を返す', () => {
    expect(projectLeftRingPoint(0.2, cfg).x).toBeLessThanOrEqual(0);
    expect(projectLeftRingPoint(0.2, cfg, 0.1).x).toBeLessThanOrEqual(0);
    expect(projectLeftRingPoint(0.2, cfg, 0.1, -2).x).toBeLessThanOrEqual(0);
  });
});

// ---------------------------------------------------------------------------
// トップバンド / flip
// ---------------------------------------------------------------------------
describe('topBandY', () => {
  it('anchor から最低限持ち上げる', () => {
    const y = topBandY(0.5, 0.4, 90, cfg, false);
    expect(y).toBeGreaterThanOrEqual(0.5 + cfg.scaledRadialExitLen);
  });
  it('isUpperLeft は displayY も尊重する', () => {
    const y = topBandY(0.2, 5, 120, cfg, true);
    expect(y).toBe(5);
  });
});

describe('flipTopRightX', () => {
  it('anchor から右へ最低限離す', () => {
    expect(flipTopRightX(0, 0, cfg)).toBeGreaterThan(0);
    expect(flipTopRightX(0, 10, cfg)).toBe(10);
  });
});

describe('upperLeftHorizontalLen / upperLeftBendPoint', () => {
  it('水平区間長は正', () => {
    expect(upperLeftHorizontalLen(135, cfg)).toBeGreaterThan(0);
  });
  it('屈曲点は anchor の左・同じ y', () => {
    const bend = upperLeftBendPoint(-0.7, 0.7, 135, cfg, {} as LayoutItem);
    expect(bend.x).toBeLessThan(-0.7);
    expect(bend.y).toBe(0.7);
  });
  it('smallDense 経路でも左・同 y', () => {
    const item = { upperLeftSmallDense: true, upperLeftCount: 3, upperLeftRank: 1 } as LayoutItem;
    const bend = upperLeftBendPoint(-0.7, 0.7, 150, cfg, item);
    expect(bend.x).toBeLessThan(-0.7);
    expect(bend.y).toBe(0.7);
  });
});

// ---------------------------------------------------------------------------
// 引出線屈曲・切り詰め
// ---------------------------------------------------------------------------
describe('leaderBendPoint', () => {
  it('bend.y は anchorY に等しい', () => {
    const bend = leaderBendPoint(1, 0.5, 0.2, 1.0, -1, 135, cfg);
    expect(bend.y).toBe(0.5);
  });
  it('bendDir>0 でも y は保たれ labelBox でクランプされる', () => {
    const box = { left: 0, right: 0.6, bottom: 0, top: 0.4 };
    const bend = leaderBendPoint(1, 0.2, -0.5, 0.8, 1, 45, cfg, box);
    expect(bend.y).toBe(0.2);
    expect(Number.isFinite(bend.x)).toBe(true);
  });
});

describe('clampBendOutsideBox', () => {
  it('右側 anchor: box を貫く bend を縁へ引き戻す', () => {
    const box = { left: 0, right: 3, bottom: -1, top: 1 };
    const out = clampBendOutsideBox({ x: -1, y: 0 }, 5, 2, box);
    expect(out.x).toBeCloseTo(3);
  });
  it('左側 anchor: 鏡像で縁へ引き戻す', () => {
    const box = { left: 0, right: 3, bottom: -1, top: 1 };
    // finalX(1) が box 内なら左縁 (left=0) まで引き戻す
    const out = clampBendOutsideBox({ x: 4, y: 0 }, -5, 1, box);
    expect(out.x).toBeCloseTo(0);
  });
  it('貫通しなければそのまま返す', () => {
    const box = { left: 0, right: 3, bottom: -1, top: 1 };
    const bend = { x: 4.5, y: 0 };
    expect(clampBendOutsideBox(bend, 5, 4.4, box)).toEqual(bend);
  });
});

describe('truncateLeaderEndpointAtBox', () => {
  const box = { left: 4, right: 6, bottom: -1, top: 1 };
  it('box 手前で gap だけ手前に切り詰める', () => {
    const t = truncateLeaderEndpointAtBox({ x: 0, y: 0 }, { x: 10, y: 0 }, box, 0.5);
    // 進入点 x=4, len=10, backoff=min(0.05,0.4)=0.05 → x=3.5
    expect(t.x).toBeCloseTo(3.5);
    expect(t.y).toBeCloseTo(0);
  });
  it('交差しなければ endpoint をそのまま返す', () => {
    const ep = { x: 10, y: 5 };
    expect(truncateLeaderEndpointAtBox({ x: 0, y: 5 }, ep, box, 0.5)).toEqual(ep);
  });
  it('長さ 0 の線分は endpoint を返す', () => {
    const ep = { x: 1, y: 1 };
    expect(truncateLeaderEndpointAtBox(ep, ep, box, 0.5)).toEqual(ep);
  });
});

describe('leaderAttachTargetY', () => {
  const box = { left: 0, right: 2, bottom: 0, top: 1 };
  it('1 行は box 縦中央', () => {
    expect(leaderAttachTargetY(box, { x: 5, y: 0.5 }, 1, 0.5)).toBeCloseTo(0.5);
  });
  it('2 行・横優位は box 縦中央', () => {
    expect(leaderAttachTargetY(box, { x: 5, y: 0.5 }, 2, 0.5)).toBeCloseTo(0.5);
  });
  it('2 行・下から来る線は下行中央', () => {
    // anchor を box より下 (y 小) に置き縦優位にする
    const y = leaderAttachTargetY(box, { x: 1, y: -5 }, 2, 0.4);
    expect(y).toBeCloseTo(box.bottom + 0.2);
  });
  it('2 行・上から来る線は上行中央', () => {
    const y = leaderAttachTargetY(box, { x: 1, y: 5 }, 2, 0.4);
    expect(y).toBeCloseTo(box.top - 0.2);
  });
});

describe('labelOutwardClearance', () => {
  it('名前長と行数で余白を増やす', () => {
    const short = { name: 'ABCDEF', textLines: 2 } as LayoutItem;
    const long = { name: 'ABCDEFGHIJ', textLines: 2 } as LayoutItem;
    const tall = { name: 'ABCDEF', textLines: 3 } as LayoutItem;
    expect(labelOutwardClearance(short, 0.1)).toBeCloseTo(0.1);
    expect(labelOutwardClearance(long, 0.1)).toBeGreaterThan(0.1);
    expect(labelOutwardClearance(tall, 0.1)).toBeCloseTo(0.14);
  });
});

// ---------------------------------------------------------------------------
// テキスト幅・行・bbox
// ---------------------------------------------------------------------------
describe('visualCharEm / visualMaxEm / visualTextWidthUnits', () => {
  it('テーブル収録 ASCII は実 advance', () => {
    expect(visualCharEm('0', cfg)).toBeCloseTo(0.7598);
  });
  it('漢字 / △ は全角幅、プロポーショナルかなは実 advance', () => {
    // 漢字・△ はテーブル非収録 → 全角 heuristic (1.0)
    expect(visualCharEm('漢', cfg)).toBe(cfg.visualFullwidthEm);
    expect(visualCharEm('△', cfg)).toBe(cfg.visualFullwidthEm);
    // BIZ UDPGothic はかながプロポーショナル: 既定 400(Regular) の実測値を引く
    // (ひらがな「あ」0.98 / カタカナ「ア」0.8901。いずれも 1.0em 未満)
    expect(visualCharEm('あ', cfg)).toBeCloseTo(0.98);
    expect(visualCharEm('ア', cfg)).toBeCloseTo(0.8901);
  });
  it('未収録・非全角は半角幅にフォールバック', () => {
    // ヘブライ文字 א はフォント cmap になくテーブル非収録 → 半角 heuristic に落ちる
    expect(visualCharEm('א', cfg)).toBe(cfg.visualHalfwidthEm);
  });
  it('最大行幅とユニット幅は正', () => {
    expect(visualMaxEm(['AB', 'ABCD'], cfg)).toBeGreaterThan(0);
    expect(visualTextWidthUnits(['AB', 'ABCD'], cfg)).toBeGreaterThan(0);
  });
});

describe('scaledLabelWidthUnits', () => {
  it('2 行は max(名前, %)、長体で名前幅が縮む', () => {
    const full = scaledLabelWidthUnits('ながいなまえ', '30.0%', 2, 1, cfg);
    const condensed = scaledLabelWidthUnits('ながいなまえ', '30.0%', 2, 0.7, cfg);
    expect(full).toBeGreaterThan(0);
    expect(condensed).toBeLessThanOrEqual(full);
  });
  it('1 行は名前 + % を加算', () => {
    expect(scaledLabelWidthUnits('AB', '30.0%', 1, 1, cfg)).toBeGreaterThan(0);
  });
});

describe('getLabelLines', () => {
  it('通常は 2 行', () => {
    const r = getLabelLines({ name: 'AB', percentText: '50%' } as LayoutItem, cfg);
    expect(r.isCompact).toBe(false);
    expect(r.lines).toEqual(['AB', '50%']);
    expect(r.longestUnits).toBeGreaterThanOrEqual(1);
  });
  it('compactLabel は 1 行に結合', () => {
    const r = getLabelLines(
      { name: 'AB', percentText: '50%', compactLabel: true } as LayoutItem,
      cfg,
    );
    expect(r.isCompact).toBe(true);
    expect(r.lines).toEqual(['AB 50%']);
  });
});

describe('estimateVerifyTextExtent / estimateTextExtent', () => {
  it('正の幅・高さを返す', () => {
    const e = estimateVerifyTextExtent({ name: 'AB', percentText: '50%' } as LayoutItem, cfg, 2);
    expect(e.width).toBeGreaterThan(0);
    expect(e.height).toBeGreaterThan(0);
  });
  it('compact は 1 行高', () => {
    const e = estimateTextExtent(
      { name: 'AB', percentText: '50%', compactLabel: true } as LayoutItem,
      cfg,
    );
    expect(e.height).toBeCloseTo(labelHeightUnits(1, cfg));
  });
});

describe('textBoxBounds', () => {
  const m = { width: 2, height: 1 };
  it('start / bottom', () => {
    expect(textBoxBounds(0, 0, m, 'start', 'bottom')).toEqual({
      left: 0,
      right: 2,
      bottom: -1,
      top: 0,
    });
  });
  it('end / top', () => {
    expect(textBoxBounds(0, 0, m, 'end', 'top')).toEqual({
      left: -2,
      right: 0,
      bottom: 0,
      top: 1,
    });
  });
  it('middle / middle', () => {
    expect(textBoxBounds(0, 0, m, 'middle', 'middle')).toEqual({
      left: -1,
      right: 1,
      bottom: -0.5,
      top: 0.5,
    });
  });
});

// ---------------------------------------------------------------------------
// スライス内判定
// ---------------------------------------------------------------------------
describe('fitsInsideSliceExtent / fitsInsideSlice', () => {
  it('退化スパン・非正 bbox は fits=false', () => {
    expect(fitsInsideSliceExtent(0, 0, 0.1, 0.1, cfg).fits).toBe(false);
    expect(fitsInsideSliceExtent(0, Math.PI, 0, 0.1, cfg).fits).toBe(false);
  });
  it('大きなスライスに小さな bbox は収まり中心を返す', () => {
    const fit = fitsInsideSliceExtent(0, Math.PI, 0.05, 0.05, cfg);
    expect(fit.fits).toBe(true);
    expect(typeof fit.centerX).toBe('number');
    expect(typeof fit.centerY).toBe('number');
  });
  it('大きすぎる bbox は収まらない', () => {
    expect(fitsInsideSliceExtent(0, Math.PI, 5, 5, cfg).fits).toBe(false);
  });
  it('fitsInsideSlice は item 経由で委譲する', () => {
    const r = fitsInsideSlice(0, Math.PI, { name: 'A', percentText: '9%' } as LayoutItem, 2, cfg);
    expect(typeof r.fits).toBe('boolean');
  });
});

describe('placementExtent / placementBox', () => {
  function makePlacement(over: Partial<Placement> = {}): Placement {
    return {
      x: 0,
      y: 0,
      anchor: 'middle',
      baseline: 'middle',
      lines: ['AB', '50%'],
      item: { name: 'AB', value: 1, percentText: '50%' },
      leaderAnchor: { x: 0, y: 0 },
      leaderBend: { x: 0, y: 0 },
      leaderEndpoint: { x: 0, y: 0 },
      leaderBendFollowsEndpointY: false,
      leaderBendFollowsEndpointX: false,
      origTextX: 0,
      origTextY: 0,
      upperLeftHairpinCheck: false,
      skipLeader: false,
      insideSlice: false,
      ...over,
    };
  }
  it('extent は正、box は extent と整合', () => {
    const p = makePlacement();
    const ext = placementExtent(p, cfg);
    expect(ext.width).toBeGreaterThan(0);
    expect(ext.height).toBeGreaterThan(0);
    const box = placementBox(p, cfg);
    expect(box.right - box.left).toBeCloseTo(ext.width);
    expect(box.top - box.bottom).toBeCloseTo(ext.height);
  });
  it('1 行 placement も扱える', () => {
    const ext = placementExtent(makePlacement({ lines: ['AB 50%'] }), cfg);
    expect(ext.height).toBeCloseTo(labelHeightUnits(1, cfg));
  });

  // メモ (`EXTENT_MEMO`) の無効化契約: 参照一致で再利用してよい条件と、してはいけない条件を
  // 固定する。無効化条件を緩めると古い extent を返し続け、逆に強めると毎回再計算になり
  // メモの意味が無くなる。
  it('lines を新しい配列へ差し替えると別内容の extent を返す', () => {
    // nameSplit: true で lines[0]/[1] 自体が幅の元になる形にする (通常の 2 行は
    // item.name/percentText から幅を作るため、lines の文字数を変えても幅は動かない)。
    const p = makePlacement({ nameSplit: true, lines: ['AB', '50%'] });
    const before = placementExtent(p, cfg);
    p.lines = ['非常に長い名前です', '50%'];
    const after = placementExtent(p, cfg);
    expect(after.width).not.toBeCloseTo(before.width);
  });

  it('文字寸法を変えた浅いコピー cfg では別の extent を返す', () => {
    const p = makePlacement();
    const before = placementExtent(p, cfg);
    const widerCfg = { ...cfg, charWidthFactor: cfg.charWidthFactor * 2 };
    const after = placementExtent(p, widerCfg);
    expect(after.width).not.toBeCloseTo(before.width);
  });

  it('返した Extent を書き換えても次回呼び出しには影響しない', () => {
    const p = makePlacement();
    const ext = placementExtent(p, cfg);
    const originalWidth = ext.width;
    ext.width = 0;
    const again = placementExtent(p, cfg);
    expect(again.width).toBeCloseTo(originalWidth);
  });
});

// ---------------------------------------------------------------------------
// 交差・重なり
// ---------------------------------------------------------------------------
describe('segmentsIntersect', () => {
  it('交差する線分', () => {
    expect(
      segmentsIntersect({ x: 0, y: 0 }, { x: 10, y: 10 }, { x: 0, y: 10 }, { x: 10, y: 0 }),
    ).toBe(true);
  });
  it('交差しない線分', () => {
    expect(segmentsIntersect({ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 0, y: 5 }, { x: 1, y: 5 })).toBe(
      false,
    );
  });
  it('端点が辺に乗る場合は非交差扱い (tolerance)', () => {
    expect(
      segmentsIntersect({ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 5, y: 0 }, { x: 5, y: 10 }),
    ).toBe(false);
  });
});

describe('leaderCrossesBox', () => {
  const box = { left: 0, right: 10, top: 0, bottom: 10 };
  it('貫通する折れ線は true', () => {
    expect(
      leaderCrossesBox(
        [
          { x: -5, y: 5 },
          { x: 15, y: 5 },
        ],
        box,
      ),
    ).toBe(true);
  });
  it('外側だけの折れ線は false', () => {
    expect(
      leaderCrossesBox(
        [
          { x: -5, y: -5 },
          { x: -1, y: -5 },
        ],
        box,
      ),
    ).toBe(false);
  });
  it('両端とも box 内は貫通とみなさない', () => {
    expect(
      leaderCrossesBox(
        [
          { x: 4, y: 4 },
          { x: 6, y: 6 },
        ],
        box,
      ),
    ).toBe(false);
  });
  it('退化 box は false', () => {
    expect(
      leaderCrossesBox(
        [
          { x: -5, y: 5 },
          { x: 15, y: 5 },
        ],
        { left: 0, right: 2, top: 0, bottom: 2 },
      ),
    ).toBe(false);
  });
});

describe('boxOverlapAmount', () => {
  it('重なりは正の量', () => {
    const o = boxOverlapAmount(
      { left: 0, right: 10, bottom: 0, top: 10 },
      { left: 5, right: 15, bottom: 5, top: 15 },
    );
    expect(o.x).toBeCloseTo(5);
    expect(o.y).toBeCloseTo(5);
  });
  it('非重なりは 0 以下', () => {
    const o = boxOverlapAmount(
      { left: 0, right: 1, bottom: 0, top: 1 },
      { left: 5, right: 6, bottom: 5, top: 6 },
    );
    expect(o.x).toBeLessThan(0);
    expect(o.y).toBeLessThan(0);
  });
});

// ---------------------------------------------------------------------------
// nudge 系
// ---------------------------------------------------------------------------
describe('nudgeTextAwayFromEndpoint', () => {
  const m = { width: 2, height: 1 };
  it('端点に被ると押し出す', () => {
    const out = nudgeTextAwayFromEndpoint(0, 0, 'start', 'bottom', 1, -0.5, m, cfg);
    expect(out.x).toBeGreaterThan(0);
  });
  it('離れていれば不変', () => {
    const out = nudgeTextAwayFromEndpoint(0, 0, 'start', 'bottom', 100, 100, m, cfg);
    expect(out).toEqual({ x: 0, y: 0 });
  });
  it('end / top / middle 経路も実行できる', () => {
    expect(nudgeTextAwayFromEndpoint(0, 0, 'end', 'top', -1, 0.5, m, cfg).x).toBeLessThanOrEqual(0);
    expect(
      Number.isFinite(nudgeTextAwayFromEndpoint(0, 0, 'middle', 'middle', 0, 0.1, m, cfg).y),
    ).toBe(true);
  });
});

describe('nudgeTextAwayFromPie', () => {
  const m = { width: 0.4, height: 0.4 };
  it('円に食い込むと半径方向へ逃がす', () => {
    const out = nudgeTextAwayFromPie(0.5, 0, 'middle', 'middle', m, cfg);
    expect(out.x).toBeGreaterThan(0.5);
  });
  it('十分外側なら不変', () => {
    const out = nudgeTextAwayFromPie(5, 5, 'middle', 'middle', m, cfg);
    expect(out).toEqual({ x: 5, y: 5 });
  });
  it('押し出し後は bbox と円の距離が pieLabelClearance 以上', () => {
    const cases: Array<[number, number, string, string]> = [
      [-1.0, 0, 'end', 'middle'],
      [1.0, 0, 'start', 'middle'],
      [-0.7, 0.7, 'end', 'bottom'],
      [0, -1.0, 'middle', 'top'],
    ];
    for (const [x, y, anchor, baseline] of cases) {
      const out = nudgeTextAwayFromPie(x, y, anchor, baseline, m, cfg);
      const b = textBoxBounds(out.x, out.y, m, anchor, baseline);
      const closestX = Math.max(b.left, Math.min(0, b.right));
      const closestY = Math.max(b.bottom, Math.min(0, b.top));
      const dist = Math.hypot(closestX, closestY);
      expect(dist).toBeGreaterThanOrEqual(cfg.pieRadius + cfg.pieLabelClearance - 1e-6);
    }
  });
});

describe('nudgeTextAwayFromSegment', () => {
  const m = { width: 0.4, height: 0.4 };
  it('水平線分に被ると Y 方向へ逃がす', () => {
    const out = nudgeTextAwayFromSegment(
      0,
      0,
      'middle',
      'middle',
      { x: -5, y: 0 },
      { x: 5, y: 0 },
      m,
      cfg,
    );
    expect(out.y).not.toBe(0);
  });
  it('垂直線分・start/end でも実行できる', () => {
    const out = nudgeTextAwayFromSegment(
      0,
      0,
      'start',
      'bottom',
      { x: 0, y: -5 },
      { x: 0, y: 5 },
      m,
      cfg,
    );
    expect(Number.isFinite(out.x)).toBe(true);
  });
  it('離れていれば不変', () => {
    const out = nudgeTextAwayFromSegment(
      10,
      10,
      'middle',
      'middle',
      { x: -5, y: 0 },
      { x: 5, y: 0 },
      m,
      cfg,
    );
    expect(out).toEqual({ x: 10, y: 10 });
  });
});

// ---------------------------------------------------------------------------
// 左上ターゲット (分岐多数)
// ---------------------------------------------------------------------------
describe('topBandUpperLeftTarget', () => {
  const measured = { width: 0.6, height: 0.3 };
  it('左側のリング点を返す', () => {
    const p = topBandUpperLeftTarget(makeReady(), -0.7, 0.9, 135, cfg, measured);
    expect(p.x).toBeLessThanOrEqual(0);
    expect(Number.isFinite(p.y)).toBe(true);
  });
  it('3 行・dense・long の分岐を通る', () => {
    const item = makeReady({
      textLines: 3,
      isLong: true,
      upperLeftLongDense: true,
      upperLeftSmallDense: true,
      upperLeftCount: 3,
      upperLeftRank: 2,
      upperLeftRenderY: 0.5,
    });
    const p = topBandUpperLeftTarget(item, -0.8, 1.0, 170, cfg, measured);
    expect(p.x).toBeLessThanOrEqual(0);
  });
});

describe('upperLeftTarget', () => {
  const measured = { width: 0.6, height: 0.3 };
  it('左側のリング点を返す', () => {
    const p = upperLeftTarget(makeReady(), 0.7, 0.8, 135, cfg, 0.1, measured);
    expect(p.x).toBeLessThanOrEqual(0);
  });
  it('smallDense / renderY なし経路', () => {
    const item = makeReady({
      upperLeftSmallDense: true,
      upperLeftCount: 3,
      upperLeftRank: 0,
      upperLeftRenderY: 0,
    });
    const p = upperLeftTarget(item, 0.6, 0.7, 120, cfg, 0.1, measured);
    expect(p.x).toBeLessThanOrEqual(0);
  });
  it('longDense / isLong / 大角度経路', () => {
    const item = makeReady({ isLong: true, upperLeftLongDense: true, upperLeftRenderY: 0.5 });
    const p = upperLeftTarget(item, 0.6, 0.7, 165, cfg, 0.1, measured);
    expect(p.x).toBeLessThanOrEqual(0);
  });
});
