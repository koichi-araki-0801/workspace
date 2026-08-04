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

/** ラベル 1 件の最大文字数。切り詰めると出力が黙って変わるためエラーにする。 */
export const MAX_LABEL_CHARS = envPositiveInt('PIE_MAX_LABEL_CHARS', 256);

/** `--range` が跨げる行数。実データ最終行とは別に、指定そのものの正気度を見る。 */
export const MAX_RANGE_ROWS = envPositiveInt('PIE_MAX_RANGE_ROWS', 10_000);

/**
 * 読み込む xlsx のファイルサイズ上限。exceljs は zip 内の全エントリを無条件に展開して
 * JS 文字列へ載せる(必要判定は展開の**後**)ため、エントリ単位の防御は pie-chart 側から
 * 掛けられない。**展開後サイズは依然として制御できない残余リスク**で、塞ぐには exceljs の
 * 置き換えが要る。入力元がオペレータのローカルファイルである前提での許容判断。
 */
export const MAX_XLSX_BYTES = envPositiveInt('PIE_MAX_XLSX_BYTES', 16 * 1024 * 1024);

/** `--data-json` の文字列長上限。 */
export const MAX_JSON_BYTES = envPositiveInt('PIE_MAX_JSON_BYTES', 8 * 1024 * 1024);
