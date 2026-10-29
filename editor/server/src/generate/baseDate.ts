// =============================================================================
// baseDate.ts — 生成器へ渡す基準日(日本時間の当日。土日は直前の金曜)
// =============================================================================
// 基準日は運用の暦(日本の営業日)で決まるので、サーバの OS のタイムゾーンや UTC の日付に
// 依存させない。`Intl.DateTimeFormat` で日本時間の年月日と曜日だけを取り、日付の足し引きは
// UTC の正午に置いた `Date` で行う(夏時間のある環境でも日付がずれない)。
/** 日本時間の曜日の略称から、直前の金曜へ戻す日数。 */
const DAYS_BACK: Readonly<Record<string, number>> = { Sat: 1, Sun: 2 };

/** `now` の日本時間での年月日と曜日(略称)。 */
function tokyoParts(now: Date): { year: number; month: number; day: number; weekday: string } {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Tokyo',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    weekday: 'short',
  }).formatToParts(now);
  const v = Object.fromEntries(parts.map((p) => [p.type, p.value]));
  return {
    year: Number(v.year),
    month: Number(v.month),
    day: Number(v.day),
    weekday: v.weekday,
  };
}

/**
 * `now` の日本時間での日付を `YYYY-MM-DD` で返す。土曜は 1 日、日曜は 2 日戻して金曜にする。
 */
export function latestBaseDate(now: Date = new Date()): string {
  const { year, month, day, weekday } = tokyoParts(now);
  const noon = new Date(Date.UTC(year, month - 1, day, 12));
  noon.setUTCDate(noon.getUTCDate() - (DAYS_BACK[weekday] ?? 0));
  return noon.toISOString().slice(0, 10);
}
