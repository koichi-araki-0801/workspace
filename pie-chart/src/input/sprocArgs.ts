// =============================================================================
// input/sprocArgs.ts — ストアド入力の引数(ファンドコード・基準日・グラフ種別)の検査
// =============================================================================
// 値は位置バインドで渡すので、SQL インジェクションを防ぐのはここの責務ではない。ここで
// 止めるのは指定ミス(欠落・空白だけ・制御文字・実在しない日付)で、DB へ問い合わせる前に
// 原因の分かるメッセージを出すため。文字種を制限しないのも同じ理由(バインド値に `'` や
// `[` が入っても文は壊れない)。ストアド名だけは文へ埋め込むので、形を厳しく検査する。
// =============================================================================

/** 呼ぶストアドの既定名。実 DB の名前が決まるまでの仮置きで、`PIE_DB_PROC` で上書きする。 */
export const DEFAULT_SPROC_NAME = 'dbo.pie_chart_items';

/** ストアドのパラメータ名(`@` は付けない)。実 DB の定義に合わせるときはここだけを直す。 */
export const SPROC_PARAM_NAMES = {
  fund: 'ファンドコード',
  baseDate: '基準日',
  chartType: 'グラフ種別',
} as const;

/** ファンドコードとグラフ種別の文字数上限。 */
export const MAX_SPROC_TEXT_CHARS = 64;

export interface SprocArgs {
  fund: string;
  /** `YYYYMMDD`。サーバの DATEFORMAT 設定に左右されない形で渡すため。 */
  baseDate: string;
  chartType: string;
}

export interface RawSprocArgs {
  fund?: string;
  baseDate?: string;
  chartType?: string;
}

const CONTROL_CHAR_RE = /[\u0000-\u001f\u007f]/;
const ISO_DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
const COMPACT_DATE_RE = /^(\d{4})(\d{2})(\d{2})$/;

/** 各部は文字か `_` で始まり、文字・数字・`_` だけ。角括弧・空白・`;` は文の構造を変えうる。 */
const SPROC_PART = '[\\p{L}_][\\p{L}\\p{N}_]{0,127}';
const SPROC_NAME_RE = new RegExp(`^(?:${SPROC_PART}\\.)?${SPROC_PART}$`, 'u');

/** 3 つのうちどれか 1 つでも指定されていれば、ストアド入力が意図されている。 */
export function hasSprocArgs(raw: RawSprocArgs): boolean {
  return raw.fund !== undefined || raw.baseDate !== undefined || raw.chartType !== undefined;
}

/** 3 つの値を検査して正規化する。1 つでも欠けていれば、欠けたフラグを列挙して投げる。 */
export function normalizeSprocArgs(raw: RawSprocArgs): SprocArgs {
  const missing = [
    raw.fund === undefined ? '--fund' : null,
    raw.baseDate === undefined ? '--base-date' : null,
    raw.chartType === undefined ? '--chart-type' : null,
  ].filter((flag): flag is string => flag !== null);
  if (missing.length > 0) {
    throw new Error(
      'Stored procedure input needs --fund, --base-date and --chart-type ' +
        `(missing: ${missing.join(', ')}).`,
    );
  }
  return {
    fund: checkText('--fund', raw.fund as string),
    baseDate: normalizeBaseDate(raw.baseDate as string),
    chartType: checkText('--chart-type', raw.chartType as string),
  };
}

function checkText(flag: string, raw: string): string {
  const text = raw.trim();
  if (text === '') throw new Error(`${flag} is empty.`);
  if (CONTROL_CHAR_RE.test(text)) throw new Error(`${flag} contains a control character.`);
  if (text.length > MAX_SPROC_TEXT_CHARS) {
    throw new Error(`${flag} is ${text.length} characters (limit ${MAX_SPROC_TEXT_CHARS}).`);
  }
  return text;
}

/** `YYYY-MM-DD` / `YYYYMMDD` を実在する日付として検査し、`YYYYMMDD` にする。 */
export function normalizeBaseDate(raw: string): string {
  const text = raw.trim();
  const m = ISO_DATE_RE.exec(text) ?? COMPACT_DATE_RE.exec(text);
  if (!m) throw new Error(`--base-date must be YYYY-MM-DD or YYYYMMDD (got "${raw}").`);
  const year = Number(m[1]);
  const month = Number(m[2]);
  const day = Number(m[3]);
  // Date は 2/30 を 3/2 へ繰り上げるので、組み立て直した値が入力と一致するかで実在を判定する。
  const date = new Date(Date.UTC(year, month - 1, day));
  if (
    date.getUTCFullYear() !== year ||
    date.getUTCMonth() !== month - 1 ||
    date.getUTCDate() !== day
  ) {
    throw new Error(`--base-date is not a real date: "${raw}".`);
  }
  return `${m[1]}${m[2]}${m[3]}`;
}

/** `YYYYMMDD` を表示用の `YYYY-MM-DD` にする。 */
export function formatBaseDateIso(yyyymmdd: string): string {
  return `${yyyymmdd.slice(0, 4)}-${yyyymmdd.slice(4, 6)}-${yyyymmdd.slice(6, 8)}`;
}

/** 呼ぶストアド名を決める。`PIE_DB_PROC` が空なら既定値。 */
export function resolveSprocName(env: string | undefined = process.env.PIE_DB_PROC): string {
  const name = env === undefined || env.trim() === '' ? DEFAULT_SPROC_NAME : env.trim();
  if (!SPROC_NAME_RE.test(name)) {
    throw new Error(
      `PIE_DB_PROC must look like [schema.]name using letters, digits and "_" only (got "${env}").`,
    );
  }
  return name;
}
