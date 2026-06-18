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
import { parseTemplateFileName, type SampleData } from '@editor/shared';
import { toFilled } from '../src/lib/fillJinja';

const web = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const editor = resolve(web, '..');
const templatesDir = resolve(web, 'src/api/fixtures/templates');

const outDirs = [resolve(editor, 'data/templates-filled'), resolve(web, 'src/api/fixtures/filled')];
for (const d of outDirs) mkdirSync(d, { recursive: true });

// Auto-discover every template fixture; the fund code (→ its sample data) is
// derived from the file name, so adding a template needs no edit here.
for (const file of readdirSync(templatesDir).filter((f) => f.endsWith('.html'))) {
  const fund = parseTemplateFileName(file)?.fundCode;
  if (!fund) {
    console.warn(`skip ${file}: ファイル名からファンドコードを解決できません`);
    continue;
  }
  const raw = readFileSync(resolve(templatesDir, file), 'utf8');
  const sample = JSON.parse(
    readFileSync(resolve(web, 'src/api/fixtures/sample', `${fund}.json`), 'utf8'),
  ) as SampleData;
  const filled = toFilled(raw, sample);
  for (const d of outDirs) writeFileSync(resolve(d, file), filled, 'utf8');
  console.log(`wrote ${file} (${filled.length} chars)`);
}
