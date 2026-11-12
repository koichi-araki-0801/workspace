// =============================================================================
// baseDate.ts — 基準日の入力を yyyymmdd に読む
// =============================================================================
// 利用者は `2026/9/30` `2026-09-30` `20260930` などで基準日を打つ。候補の表記も
// `yyyymmdd` と `yyyy-mm-dd` が混在するため、比較は数字だけにそろえて行う。

export type BaseDateParse =
  | { ok: true; value: string }
  | { ok: false; reason: 'format' | 'invalid' };

const DELIMITED = /^(?<y>\d{4})(?<sep>[/-])(?<m>\d{1,2})\k<sep>(?<d>\d{1,2})$/;
const COMPACT = /^(?<y>\d{4})(?<m>\d{2})(?<d>\d{2})$/;

// UTC で組み立てて年月日が戻るかを見る(ローカル TZ に依らないため)。`Date.UTC` は年 0〜99 を
// 1900 年代へ読み替えるので、`setUTCFullYear` で年を入れて 0000〜0099 も実在する日付として扱う。
function exists(y: number, m: number, d: number): boolean {
  const t = new Date(0);
  t.setUTCFullYear(y, m - 1, d);
  return t.getUTCFullYear() === y && t.getUTCMonth() === m - 1 && t.getUTCDate() === d;
}

/** 区切りあり(`/` か `-` で揃っている)は月日 1〜2 桁、区切りなしは 8 桁ちょうどだけ受ける。 */
export function parseBaseDateInput(raw: string): BaseDateParse {
  // 日本語入力のまま打った全角の数字・`／`・`－` も半角と同じに読む。
  const s = raw.normalize('NFKC').trim();
  const g = (DELIMITED.exec(s) ?? COMPACT.exec(s))?.groups;
  if (!g) {
    return { ok: false, reason: 'format' };
  }
  const { y, m: mo, d } = g;
  if (!exists(Number(y), Number(mo), Number(d))) {
    return { ok: false, reason: 'invalid' };
  }
  return { ok: true, value: `${y}${mo.padStart(2, '0')}${d.padStart(2, '0')}` };
}

/** `value`(yyyymmdd)と数字だけにした候補が一致する最初の候補を、元の表記のまま返す。 */
export function findBaseDateCandidate(value: string, candidates: string[]): string | undefined {
  return candidates.find((c) => c.replace(/\D/g, '') === value);
}
