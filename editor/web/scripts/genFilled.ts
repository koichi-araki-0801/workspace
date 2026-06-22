/**
 * Regenerate the static "filled" editor fixtures from the raw Jinja2 templates
 * and their sample data. Output is committed so the editor has a value-filled
 * canvas without a runtime render; re-run after changing a template or sample:
 *
 *   npx vite-node scripts/genFilled.ts     (from editor/web)
 *
 * The filled form preserves the original Jinja source (see fillJinja.toFilled),
 * so jinjaMask.toTemplate restores the exact template on save.
 */
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildSampleData, type FundMaster, parseTemplateFileName } from '@editor/shared';
import fundMaster from '../src/api/fixtures/funds.json';
import { toFilled } from '../src/lib/fillJinja';

const web = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const templatesDir = resolve(web, 'src/api/fixtures/templates');

// 出力は local 同梱の filled fixtures のみ。REST 実体は dataRoot(git 管理)へ移したため
// 旧 editor/data/templates-filled への出力は廃止した。
const outDirs = [resolve(web, 'src/api/fixtures/filled')];
for (const d of outDirs) mkdirSync(d, { recursive: true });

const funds = fundMaster as Record<string, FundMaster>;

// Auto-discover every template fixture; fund code + edition type come from the
// file name. Sample values are the part-level common dummy (`sampleCommon`) with
// only the fund-specific name/company overlaid from funds.json.
for (const file of readdirSync(templatesDir).filter((f) => f.endsWith('.html'))) {
  const attrs = parseTemplateFileName(file);
  if (!attrs) {
    console.warn(`skip ${file}: ファイル名から属性を解決できません`);
    continue;
  }
  const raw = readFileSync(resolve(templatesDir, file), 'utf8');
  const sample = buildSampleData(funds[attrs.fundCode], attrs.fundCode, attrs.editionType);
  const filled = toFilled(raw, sample);
  for (const d of outDirs) writeFileSync(resolve(d, file), filled, 'utf8');
  console.log(`wrote ${file} (${filled.length} chars)`);
}
