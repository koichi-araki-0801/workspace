// =============================================================================
// input/number.ts — 入力値の数値解釈(xlsx / DB / JSON の 3 経路で共有)
// -----------------------------------------------------------------------------
// `load.ts` は `db.ts` を import しているので、両方が使う判定を片方に置くと逆向きの
// import が循環になる。どちらにも依存しない本ファイルへ置き、規則を 1 箇所に保つ。
// =============================================================================

/** 桁区切りとして成立するカンマ入り数値(`1,234` / `-1,234,567.89`)。 */
const GROUPED_NUMBER_RE = /^[+-]?\d{1,3}(?:,\d{3})+(?:\.\d+)?$/;

/**
 * 10 進表記の数値(符号・小数・指数を許す)。`Number()` は `0x1A` / `0b11` / `0o7` も
 * 26 / 3 / 7 と読むが、帳票の数値にそうした記法は無く、受理すると書き損じが別の値として
 * 黙って載る。`Number()` へ渡す前にこの形だけへ絞る。
 */
const DECIMAL_NUMBER_RE = /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/;

/**
 * 文字列を数値として読む。読めなければ null。前後の空白は無視する。
 * カンマは `allowGrouping` のときだけ、**桁区切りとして成立する位置にある時に限り**許容する。
 * 全カンマを無条件に除去すると `1,23`(小数点にカンマを使う locale の 1.23)が 123 に、
 * `1,2,3` が 123 になり、100 倍の値が無警告で帳票へ載る。
 */
export function parseDecimalText(raw: string, allowGrouping: boolean): number | null {
  const text = raw.trim();
  const normalized = allowGrouping && GROUPED_NUMBER_RE.test(text) ? text.replace(/,/g, '') : text;
  if (!DECIMAL_NUMBER_RE.test(normalized)) return null;
  const n = Number(normalized);
  return Number.isFinite(n) ? n : null;
}

/**
 * セル値(xlsx)・列値(DB)を数値として読む。読めなければ null。
 * 数値型は有限ならそのまま、それ以外は文字列化して `parseDecimalText`(桁区切り可)へ回す。
 * 空白だけの値も「読めない値」— `Number('   ')` は 0 なので、素通しすると値の欠落が
 * 0.0% のスライスとして帳票に載る。
 */
export function cellValueAsNumber(v: unknown): number | null {
  if (v == null || v === '') return null;
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  return parseDecimalText(String(v), true);
}
