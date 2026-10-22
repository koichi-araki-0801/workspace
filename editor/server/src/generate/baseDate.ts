// =============================================================================
// baseDate.ts — 生成器へ渡す基準日(日本時間の当日。土日は直前の金曜。利用者の指定も受ける)
// =============================================================================
// 基準日は運用の暦(日本の営業日)で決まるので、サーバの OS のタイムゾーンや UTC の日付に
// 依存させない。`Intl.DateTimeFormat` で日本時間の年月日と曜日だけを取り、日付の足し引きは
// UTC の正午に置いた `Date` で行う(夏時間のある環境でも日付がずれない)。
import { validation } from '@editor/shared';

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

/** 日本時間の暦日(`YYYY-MM-DD`)。土日でも戻さない。利用者の指定が未来かの比較に使う。 */
export function todayInTokyo(now: Date = new Date()): string {
  const { year, month, day } = tokyoParts(now);
  return new Date(Date.UTC(year, month - 1, day, 12)).toISOString().slice(0, 10);
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

/**
 * 利用者が指定した基準日を検査して、そのまま返す。形式が `YYYY-MM-DD` でない、暦に無い日、
 * 日本時間の今日より後の日は `validation`。過去日や土日は営業日へ寄せずに通す(指定を尊重する)。
 * 空文字は呼び出し側で「指定なし」として扱うので、ここへは渡さない。
 */
export function assertRequestedBaseDate(value: string, now: Date = new Date()): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!m) throw validation('基準日は YYYY-MM-DD 形式で指定してください');
  // 2026-02-30 のような日は Date が翌月へ繰り上げるので、往復して一致するかで実在を見る。
  const roundTrip = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]), 12));
  if (roundTrip.toISOString().slice(0, 10) !== value) {
    throw validation(`基準日が暦に存在しません: ${value}`);
  }
  // 同じ桁数のゼロ埋め文字列なので、文字列の大小がそのまま日付の前後になる。
  if (value > todayInTokyo(now)) {
    throw validation('基準日は今日より後にできません');
  }
  return value;
}
