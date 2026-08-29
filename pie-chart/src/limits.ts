// =============================================================================
// limits.ts — 資源上限の一元管理
// =============================================================================
// pie-chart はオペレータが手元で回す CLI で、ネットワークサービスではない。実害は
// 「`--range` の指定ミスや行数の多い SELECT で何時間も固まる」という自己 DoS であり、
// **黙って数時間回るのが最悪の壊れ方**。したがって上限超過は degrade でも既定への
// フォールバックでもなく**明示エラー**にし、メッセージに「上限値・実際の値・上げ方」を
// 必ず含める(オペレータが即座に指定ミスと分かることが実際の価値)。
//
// `config.ts` は `createPieLayoutConfig` の描画設定で意味が違うため混ぜない。

import { hasXmlInvalidChars } from './svg_export/values.js';

/**
 * 数値の env 上書き。10 進表記に一致しない値・0 以下は**エラー**にする — 素の `Number()`
 * は `'64MB'` を NaN にし、`n > NaN` が常に false = 上限が黙って消える経路になる。
 */
function envPositiveInt(name: string, def: number): number {
  const raw = process.env[name];
  if (raw === undefined) return def;
  if (!/^\d+$/.test(raw.trim()) || Number(raw) <= 0)
    throw new Error(`${name} must be a positive integer (got "${raw}").`);
  return Number(raw);
}

/**
 * 1 枚のグラフに載せる項目数の上限。配置カスケードは `pickUpperEscapeCount` が候補ごとに
 * レイアウト全体を作り直し、重なり解消が O(n^2) を反復するため実測で n^3 より悪い
 * (この端末で n=20 が 19 秒、n=40 は 5 分でも未完了)。32 が「中断できる 2 分」の線。
 * 40 スライスの円グラフはラベルが収まらず業務上も成立しないので、防御であると同時に
 * 正当なドメイン制約でもある。
 */
export const PIE_MAX_ITEMS = envPositiveInt('PIE_MAX_ITEMS', 32);

/** この件数を超えたら「時間がかかる」と stderr へ警告する(待たされていることの可視化)。 */
export const PIE_WARN_ITEMS = 16;

/**
 * 項目数の上限判定。**割り当ての直前** (`renderPdfStylePieToSvg` が唯一の funnel) から
 * 呼ぶ。エラーメッセージには上限値・実際の件数・上げ方を必ず含める — オペレータが即座に
 * 指定ミスと分かることが、速く描けることより実際の価値。
 */
export function assertItemCount(count: number): void {
  if (count > PIE_MAX_ITEMS)
    throw new Error(
      `Too many items: ${count} (limit ${PIE_MAX_ITEMS}). ` +
        'Label placement grows worse than cubically in the item count, so a larger chart ' +
        'would run for many minutes. Reduce the data, or raise the limit deliberately with ' +
        `PIE_MAX_ITEMS=<n> (n=${PIE_MAX_ITEMS} already takes about two minutes).`,
    );
  if (count > PIE_WARN_ITEMS)
    console.warn(`[pie-chart] ${count} items: label placement may take tens of seconds.`);
}

/**
 * スライス値の総和が「割合を計算できる数」であることの検査。`assertItemCount` と同じ
 * funnel(`renderPdfStylePieToSvg` の割り当て直前)から呼ぶ。
 *
 * 各項目が有限でも総和は `Number.MAX_VALUE` を超えて `Infinity` になりうる(例: `1e308`
 * が 2 行)。そのとき `value / Infinity` は 0 なので、**例外も警告も出ないまま全項目
 * 0.0%・全スライス幅ゼロの SVG が書かれる**。帳票用途では無警告の誤出力が最悪の壊れ方
 * なので、上限系と同じ様式(実際の値・原因・対処)の明示エラーで落とす。
 */
export function assertTotalValue(total: number): void {
  if (!Number.isFinite(total) || total <= 0)
    throw new Error(
      `Sum of |value| is not a usable number (got ${String(total)}). ` +
        'Percentages would all come out as 0.0%, so the chart is refused instead of being ' +
        'written silently. Check the input for overflowing magnitudes (values near 1e308).',
    );
}

/** ラベル 1 件の最大文字数。切り詰めると出力が黙って変わるためエラーにする。 */
export const MAX_LABEL_CHARS = envPositiveInt('PIE_MAX_LABEL_CHARS', 256);

/** `--range` が跨げる行数。実データ最終行とは別に、指定そのものの正気度を見る。 */
export const MAX_RANGE_ROWS = envPositiveInt('PIE_MAX_RANGE_ROWS', 10_000);

/**
 * 読み込む xlsx の**圧縮後**ファイルサイズ上限。exceljs は zip 内の全エントリを無条件に
 * 展開して JS 文字列へ載せる(必要判定は展開の**後**)ため、展開バイト数の予算を pie-chart
 * 側から掛ける手段が無い。つまりこの値は**展開後サイズの上限ではない** — 高圧縮率の XML を
 * 詰めた小さな .xlsx は展開後に何桁も大きくなり、`--range` が 10 行しか指していなくても
 * range 検査へ到達する前にメモリを食い潰せる(zip 爆弾)。
 *
 * 運用条件(この上限が守れない部分を人が守る): **信用できない .xlsx を開かない。**
 * 業務入力は「2 列 × 数十行の集計表」で、実ファイルは百 KB 台に収まる。既定はそれに対して
 * 十分な余裕を持たせた 4 MiB へ下げ、圧縮率 1000:1 の細工でも展開が数 GB 規模に留まるように
 * している(それでも落ちうるので、上の運用条件が主で本値は緩和)。他所から受け取った
 * .xlsx を扱う運用が要るなら、上限を上げるのではなく exceljs を「必要なエントリだけを
 * inflate 出力バイト数の予算付きで読む」実装へ置き換えること。
 */
export const MAX_XLSX_BYTES = envPositiveInt('PIE_MAX_XLSX_BYTES', 4 * 1024 * 1024);

/** `--data-json` の文字列長上限。 */
export const MAX_JSON_BYTES = envPositiveInt('PIE_MAX_JSON_BYTES', 8 * 1024 * 1024);

/**
 * `--sql` の結果セットが持てる行数。`MAX_RANGE_ROWS` と同水準で、意味も同じ
 * 「指定そのものの正気度を見る」— 集計を忘れた SELECT が明細を数十万行返すと、行 → 項目の
 * 変換とそれに続く `Object.keys` / 文字列化で待たされたうえ、最後に `PIE_MAX_ITEMS` で
 * 落ちる。どこで落ちたか分かるよう、行の変換に入る前に行数で切る。
 *
 * これは**結果セットが手元に来た後**の上限である。msnodesqlv8 の one-shot API は全行を
 * 溜めてからコールバックへ渡すので、フェッチそのものを途中で止める術はドライバ側の
 * ストリーミング API に移らない限り無い。巨大な明細を DB から引かせないことは
 * `SELECT TOP` や集計を書くクエリ側の責務で、本上限はその指定ミスを早く見せる装置。
 */
export const MAX_DB_ROWS = envPositiveInt('PIE_MAX_DB_ROWS', 10_000);

/**
 * ラベル名が XML 1.0 として出力できる文字だけで構成されていることを検査する。
 * `escapeXml` は不正文字を落としてから特殊文字をエスケープするが、それは出力側の最終防衛線
 * であって入口ではない — 黙って落とすと「入力した名前と違う文字列が帳票に出る」という
 * 無警告の誤出力になる(上限系と同じ「明示エラーが最悪の壊れ方を避ける」思想)。判定は
 * `svg_export/values.ts` の `hasXmlInvalidChars` を再利用し、除去ロジックを重複させない。
 */
export function assertLabelXmlSafe(name: string): void {
  if (!hasXmlInvalidChars(name)) return;
  // 位置は正規表現の再実装でなく hasXmlInvalidChars の 1 文字ずつの再適用で求める
  // (判定ロジックを 2 箇所に持たない)。for..of はサロゲートペアを 1 コードポイントとして
  // 扱うため、孤立サロゲートだけを 1 コード単位として検出できる。
  let index = 0;
  for (const ch of name) {
    if (hasXmlInvalidChars(ch)) break;
    index += ch.length;
  }
  const codePoint = name.codePointAt(index);
  const codePointHex =
    codePoint === undefined ? '?' : codePoint.toString(16).toUpperCase().padStart(4, '0');
  throw new Error(
    `Label ${JSON.stringify(name)} has a character invalid in XML output at position ${index} ` +
      `(code point U+${codePointHex}). Remove or replace it in the source data.`,
  );
}
