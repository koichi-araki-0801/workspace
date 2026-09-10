// =============================================================================
// confirmedCanonical.ts — 確定版正規形(HTML + CSS)の localStorage キャッシュ
// =============================================================================
// 役割: 「未確定」の判定基準になる確定版の正規形(canvas を通して GrapesJS 自身が直列化した
// 形)を templateId + updatedAt をキーに保持する。確定版から開いた初回に取り、draft 再開時は
// これを使って canvas の二重 load を避ける。updatedAt が変われば(承認で確定版が更新されれば)
// 使わない。null の版はキャッシュしない。読めない・書けないは「無い」として扱う(判定側が
// フォールバックする)。

import { confirmedCanonicalKey } from '@/lib/storageKeys';

export interface ConfirmedCanonical {
  html: string;
  css: string;
}

type CanonicalMap = Record<string, { updatedAt: string; html: string; css: string }>;

function readMap(): CanonicalMap {
  try {
    return JSON.parse(localStorage.getItem(confirmedCanonicalKey()) ?? '{}') as CanonicalMap;
  } catch {
    return {};
  }
}

export function readConfirmedCanonical(
  templateId: string,
  updatedAt: string | null,
): ConfirmedCanonical | null {
  if (!updatedAt) return null;
  const e = readMap()[templateId];
  if (!e || e.updatedAt !== updatedAt) return null;
  return { html: e.html, css: e.css };
}

export function writeConfirmedCanonical(
  templateId: string,
  updatedAt: string | null,
  value: ConfirmedCanonical,
): void {
  if (!updatedAt) return;
  const map = readMap();
  delete map[templateId]; // 削除→再追加でキー順の末尾 = 最近使用に置く
  map[templateId] = { updatedAt, ...value };
  try {
    localStorage.setItem(confirmedCanonicalKey(), JSON.stringify(map));
  } catch {
    // quota: 古い順に間引いて 1 回だけ再試行。それでも駄目なら諦める(判定はフォールバックする)。
    const keys = Object.keys(map);
    for (const k of keys.slice(0, Math.max(0, keys.length - 1))) delete map[k];
    try {
      localStorage.setItem(confirmedCanonicalKey(), JSON.stringify(map));
    } catch {
      /* 諦める */
    }
  }
}
