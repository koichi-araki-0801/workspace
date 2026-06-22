/**
 * Generate seed SQL for the parts catalog and per-fund sample data from the
 * existing web fixtures (the same data phase 1 ships). Output is idempotent
 * (INSERT guarded by IF NOT EXISTS) and written UTF-8 BOM for sqlcmd.
 *
 *   corepack pnpm --filter server exec tsx scripts/gen-seed.ts
 *
 * Writes: server/db/seed/パーツカタログ.sql, server/db/seed/サンプルデータ.sql
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const fixtures = path.resolve(__dirname, '..', '..', 'web', 'src', 'api', 'fixtures');
const seedDir = path.resolve(__dirname, '..', 'db', 'seed');
fs.mkdirSync(seedDir, { recursive: true });

const BOM = '﻿';
/** Quote a value as an N'' literal (or NULL), escaping single quotes. */
const q = (v: unknown): string => (v == null ? 'NULL' : `N'${String(v).replace(/'/g, "''")}'`);
/** ISO timestamp -> datetime2 literal (strip trailing Z; keep ISO8601 'T'). */
const dt = (iso: unknown): string =>
  iso == null ? 'NULL' : `CONVERT(datetime2(3), N'${String(iso).replace(/Z$/, '')}')`;

// --- parts catalog ----------------------------------------------------------
interface Part {
  id: string;
  classification: { category: string; majorClass: string; middleClass: string; minorClass: string };
  name: string;
  description?: string;
  usageNotes?: string;
  updatedAt?: string | null;
  updatedBy?: string | null;
  content: string;
}
const parts = JSON.parse(fs.readFileSync(path.join(fixtures, 'parts.json'), 'utf8')) as Part[];
const T_PART = '[ug01].[Rep1_運報自動化_Editor_パーツカタログ]';
const partRows = parts
  .map((p) => {
    const c = p.classification;
    return `IF NOT EXISTS (SELECT 1 FROM ${T_PART} WHERE [パーツID] = ${q(p.id)})
  INSERT INTO ${T_PART}
    ([パーツID],[カテゴリ],[大分類],[中分類],[小分類],[名称],[説明],[使用上の注意],[内容HTML],[更新日時],[更新者])
  VALUES (${q(p.id)}, ${q(c.category)}, ${q(c.majorClass)}, ${q(c.middleClass)}, ${q(c.minorClass)},
    ${q(p.name)}, ${q(p.description)}, ${q(p.usageNotes)}, ${q(p.content)}, ${dt(p.updatedAt)}, ${q(p.updatedBy)});`;
  })
  .join('\nGO\n');
const partSql = `${BOM}/* seed: パーツカタログ (生成物 — gen-seed.ts from web fixtures) */
SET NOCOUNT ON;
${partRows}
GO
`;
fs.writeFileSync(path.join(seedDir, 'パーツカタログ.sql'), partSql, 'utf8');

// --- sample data (ファンド固有マスタ = 名称/会社のみ) -----------------------
// サンプル本体はパーツ別共通ダミー(`sampleCommon`)に集約済み。DB が持つのは
// REST の getSampleData が名称解決に使う fund(name/nickname) と company だけ。
const T_SAMPLE = '[ug01].[Rep1_運報自動化_Editor_サンプルデータ]';
interface FundMasterEntry {
  name: string;
  nickname?: string;
  company: { code: string; name: string };
}
const funds = JSON.parse(fs.readFileSync(path.join(fixtures, 'funds.json'), 'utf8')) as Record<
  string,
  FundMasterEntry
>;
const sampleRows = Object.entries(funds)
  .map(([fundCode, m]) => {
    const json = JSON.stringify({
      fund: { name: m.name, nickname: m.nickname ?? '' },
      company: m.company,
    });
    return `IF NOT EXISTS (SELECT 1 FROM ${T_SAMPLE} WHERE [ファンドコード] = ${q(fundCode)})
  INSERT INTO ${T_SAMPLE} ([ファンドコード],[データJSON],[更新日時])
  VALUES (${q(fundCode)}, ${q(json)}, SYSUTCDATETIME());`;
  })
  .join('\nGO\n');
const sampleSql = `${BOM}/* seed: サンプルデータ (生成物 — gen-seed.ts from web fixtures) */
SET NOCOUNT ON;
${sampleRows}
GO
`;
fs.writeFileSync(path.join(seedDir, 'サンプルデータ.sql'), sampleSql, 'utf8');

console.log(`[gen-seed] wrote パーツカタログ.sql (${parts.length} parts) and サンプルデータ.sql`);
