/**
 * Generate seed SQL for the parts catalog and common sample rows from the
 * existing web fixtures (the same data phase 1 ships). Output is idempotent
 * (INSERT guarded by IF NOT EXISTS) and written UTF-8 BOM for sqlcmd.
 *
 *   corepack pnpm --filter server exec tsx scripts/gen-seed.ts
 *
 * Writes: server/db/seed/パーツカタログ.sql, server/db/seed/共通サンプル.sql
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { COMMON_SAMPLE_SEED_ROWS } from './commonSampleSeed.js';

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
  syncDefault?: string | null;
  masterReflectDefault?: string | null;
  companyCode?: string | null;
}
const parts = JSON.parse(fs.readFileSync(path.join(fixtures, 'parts.json'), 'utf8')) as Part[];
const T_PART = '[ug01].[Rep1_運報自動化_Editor_パーツカタログ]';
// `対象版種` は parts.json に値があっても常に NULL で入れる。新しい環境は「全パーツ共通」から
// 始め、版種の振り分けは運用で UPDATE して決める(local モードとテストは parts.json の値を使う)。
const partRows = parts
  .map((p) => {
    const c = p.classification;
    return `IF NOT EXISTS (SELECT 1 FROM ${T_PART} WHERE [パーツID] = ${q(p.id)})
  INSERT INTO ${T_PART}
    ([パーツID],[カテゴリ],[大分類],[中分類],[小分類],[名称],[説明],[使用上の注意],[内容HTML],[更新日時],[更新者],[同期既定],[次回反映既定],[対象版種],[委託会社コード])
  VALUES (${q(p.id)}, ${q(c.category)}, ${q(c.majorClass)}, ${q(c.middleClass)}, ${q(c.minorClass)},
    ${q(p.name)}, ${q(p.description)}, ${q(p.usageNotes)}, ${q(p.content)}, ${dt(p.updatedAt)}, ${q(p.updatedBy)}, ${q(p.syncDefault)}, ${q(p.masterReflectDefault)}, NULL, ${q(p.companyCode)});`;
  })
  .join('\nGO\n');
const partSql = `${BOM}/* seed: パーツカタログ (生成物 — gen-seed.ts from web fixtures) */
SET NOCOUNT ON;
${partRows}
GO
`;
fs.writeFileSync(path.join(seedDir, 'パーツカタログ.sql'), partSql, 'utf8');

// --- 共通サンプル (分類ごとの JSON 断片) --------------------------------------
// 行の定義は commonSampleSeed.ts。再実行しても同じになるよう、全行を消してから入れ直す。
const T_COMMON = '[ug01].[Rep1_運報自動化_Editor_共通サンプル]';
const commonRows = COMMON_SAMPLE_SEED_ROWS.map(
  (r) => `  INSERT INTO ${T_COMMON}
    ([カテゴリ],[大分類],[中分類],[小分類],[データJSON],[更新日時],[更新者])
  VALUES (${q(r.category)}, ${q(r.major)}, ${q(r.middle)}, ${q(r.minor)},
    ${q(JSON.stringify(r.data))}, SYSUTCDATETIME(), N'seed');`,
).join('\n');
const commonSql = `${BOM}/* seed: 共通サンプル (生成物 — gen-seed.ts / commonSampleSeed.ts) */
SET NOCOUNT ON;
SET QUOTED_IDENTIFIER ON; -- 計算列に索引がある表への書き込みに必要(sqlcmd の既定は OFF)
DELETE FROM ${T_COMMON};
${commonRows}
GO
`;
fs.writeFileSync(path.join(seedDir, '共通サンプル.sql'), commonSql, 'utf8');

console.log(`[gen-seed] wrote パーツカタログ.sql (${parts.length} parts) and 共通サンプル.sql`);
