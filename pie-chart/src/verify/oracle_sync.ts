// =============================================================================
// verify/oracle_sync.ts — verify_svg の複製定数/文字幅分類の drift ガード
// =============================================================================
// `verify/svg.ts` は検証 *ロジック* を本体から import せず独立オラクルとして複製するが、
// そこで複製する *数値定数* と *文字幅分類* だけは本体 (`config.ts` の既定値 /
// `svg_geom.visualCharEm`) と一致していなければならない。ここに定数と照合関数 `assertOracleSync`
// を集約し、`verify/svg.ts`(CLI)は import して起動時に呼ぶ。テスト(`test/oracle_sync.test.ts`)
// からも同関数を直接叩けるよう、乖離時は `process.exit` ではなく `Error` を throw する
// (CLI 側で捕捉して従来どおり exit(1) する)。SVG 出力経路 (`cli.ts` / render) には無関係。
import { createPieLayoutConfig } from '../config.js';
import {
  TOP_BAND_HALF_WIDTH_DEG as bodyTopBandHalfWidthDeg,
  TOP_BAND_SONOHOKA_LEFT_EXT_HALF_WIDTH_DEG as bodySonohokaLeftExtHalfWidthDeg,
} from '../layout/placement.js';
import { visualCharEm as bodyVisualCharEm } from '../layout/geometry.js';

// 描画器(config.ts)の bbox 推定係数と同期すべき定数。verify は独立オラクルとして検証
// *ロジック* は本体から import せず複製するが、ここで複製する *数値* は起動時に
// assertOracleSync() が本体 (config.ts の既定値 / svg_geom.visualCharEm の判定域) と一致するか
// 自動照合し、乖離があれば FAIL する。よって手動同期忘れによる false PASS/FAIL は防がれる
// (定数を変えたら verify を一度走らせれば drift を検知できる)。
// 幅は実描画 em (全角=1.0 / 半角・ASCII=0.5) × fontSizeUnits で数える (= 本体の
// visualTextWidthUnits)。charWidthFactor は安全マージン用ノブで既定 1.0。
export const CHAR_WIDTH_FACTOR = 1.0; // = config.charWidthFactor
export const LINE_HEIGHT_FACTOR = 1.1; // = config.lineHeightFactor (= lineSpacing)
export const VISUAL_FULLWIDTH_EM = 1.0; // = config.visualFullwidthEm
export const VISUAL_HALFWIDTH_EM = 0.5; // = config.visualHalfwidthEm
export const NAME_CONDENSE_STEPS = [0.7]; // = config.nameCondenseSteps (名前長体の試行段)
export const TOP_BAND_HALF_WIDTH_DEG = 18; // = label_placement.TOP_BAND_HALF_WIDTH_DEG (その他逃がし帯)
// = label_placement.TOP_BAND_SONOHOKA_LEFT_EXT_HALF_WIDTH_DEG (その他 真上垂直配置の左拡張帯)
export const SONOHOKA_LEFT_EXT_HALF_WIDTH_DEG = 32;

/**
 * verify のローカル複製定数/文字幅分類が本体 (config.ts / svg_geom.visualCharEm) と
 * 一致するかを照合する drift ガード。一致時は無出力で return。不一致時はズレを列挙した
 * `Error` を throw する(CLI は捕捉して `process.exit(1)`、テストは `not.toThrow` で検証)。
 */
export function assertOracleSync(): void {
  const cfg = createPieLayoutConfig();
  const mismatches: string[] = [];
  const checkConst = (name: string, body: number, oracle: number) => {
    if (body !== oracle) mismatches.push(`${name}: body=${body} oracle=${oracle}`);
  };
  checkConst('charWidthFactor', cfg.charWidthFactor, CHAR_WIDTH_FACTOR);
  checkConst('lineHeightFactor', cfg.lineHeightFactor, LINE_HEIGHT_FACTOR);
  checkConst('visualFullwidthEm', cfg.visualFullwidthEm, VISUAL_FULLWIDTH_EM);
  checkConst('visualHalfwidthEm', cfg.visualHalfwidthEm, VISUAL_HALFWIDTH_EM);
  checkConst('topBandHalfWidthDeg', bodyTopBandHalfWidthDeg, TOP_BAND_HALF_WIDTH_DEG);
  checkConst(
    'sonohokaLeftExtHalfWidthDeg',
    bodySonohokaLeftExtHalfWidthDeg,
    SONOHOKA_LEFT_EXT_HALF_WIDTH_DEG,
  );
  const steps = cfg.nameCondenseSteps;
  if (
    steps.length !== NAME_CONDENSE_STEPS.length ||
    steps.some((v, i) => v !== NAME_CONDENSE_STEPS[i])
  ) {
    mismatches.push(`nameCondenseSteps: body=[${steps}] oracle=[${NAME_CONDENSE_STEPS}]`);
  }

  // 実 glyph advance テーブル (src/glyph_advance/weight_{400,700}.ts) が確かに読み込まれ本体 visualCharEm に
  // 効いているかを代表コードポイントで検査する。テーブル未生成/未適用なら旧 heuristic の
  // 0.5/1.0 に落ちて以下の実測値と乖離し FAIL する。値は既定ウェイト (400=Regular) の実測。
  // 漢字は既定 1.0、BIZ UDPGothic のプロポーショナルかな ('ア') と全角幅 ASCII ('%') はテーブル収録値。
  // '.' と 'ア' は 400/700 で異なるので、ウェイト別テーブルが正しく引かれているかも兼ねて検査する。
  const widthProbes: [string, number][] = [
    ['0', 0.7598],
    ['8', 0.7598],
    ['.', 0.3101],
    ['%', 1.0],
    [' ', 0.3335],
    ['株', 1.0],
    ['ア', 0.8901],
  ];
  for (const [ch, expect] of widthProbes) {
    const body = bodyVisualCharEm(ch, cfg);
    if (Math.abs(body - expect) > 1e-4) {
      mismatches.push(
        `visualCharEm("${ch}"): body=${body} expected≈${expect} (glyph_advance テーブル未適用?)`,
      );
    }
  }
  // 700 (Bold) 側も代表値を検査し、ウェイト切替でテーブルが切り替わることを担保する。
  const cfg700 = createPieLayoutConfig({ fontWeight: '700' });
  for (const [ch, expect] of [
    ['.', 0.3301],
    ['ア', 0.9102],
  ] as [string, number][]) {
    const body = bodyVisualCharEm(ch, cfg700);
    if (Math.abs(body - expect) > 1e-4) {
      mismatches.push(
        `visualCharEm("${ch}" @700): body=${body} expected≈${expect} (ウェイト別テーブル未適用?)`,
      );
    }
  }

  if (mismatches.length > 0) {
    const detail = mismatches.map((m) => `    - ${m}`).join('\n');
    throw new Error(
      `verify_svg のメトリクス定数/文字幅が本体と乖離しています:\n${detail}\n` +
        '  → 定数は verify/oracle_sync.ts を config.ts に合わせ、幅は `npm run gen:widths` で' +
        ' src/glyph_advance/ を再生成してください。',
    );
  }
}
