/**
 * Regenerate the static "filled" editor fixtures from the raw Jinja2 templates
 * and their sample data. Output is committed so the editor has a value-filled
 * canvas without a runtime render; re-run after changing a template or sample:
 *
 *   npx vite-node scripts/genFilled.ts     (from editor/web)
 *
 * The filled form preserves the original Jinja source (see fillJinja.toFilled),
 * so jinjaMask.toTemplate restores the exact template on save.
 *
 * 2系統の原則(設計正典.md「編集 2 系統」)に従い、filled fixtures は編集タブが
 * 読む「値埋め込み済みHTML」であり、値は**ファンド別の実サンプル**でなければならない
 * (全ファンド共通ダミーにしない)。ファンド別実値は `src/api/fixtures/sample/<fund>.json`
 * を正典とし、版種・基準日(ファイル名由来)だけ `applyTemplateAttributes` で被せる。
 * per-fund サンプルが無いファンドのみ共通ダミー(`buildSampleData`)へフォールバックする。
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  applyTemplateAttributes,
  buildSampleData,
  type FundMaster,
  parseTemplateFileName,
  type SampleData,
  type SampleTemplateAttributes,
} from '@editor/shared';
import fundMaster from '../src/api/fixtures/funds.json';
import { toFilled } from '../src/lib/fillJinja';

const web = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const templatesDir = resolve(web, 'src/api/fixtures/templates');
const sampleDir = resolve(web, 'src/api/fixtures/sample');

// 出力は local 同梱の filled fixtures のみ。REST 実体は dataRoot(git 管理)側が持つため、
// ここからリポジトリ内の他の場所へは書き出さない。
const outDirs = [resolve(web, 'src/api/fixtures/filled')];
for (const d of outDirs) mkdirSync(d, { recursive: true });

const funds = fundMaster as Record<string, FundMaster>;

/**
 * ファンドの差込サンプルを解決する。`sample/<fund>.json`(実値)があればそれを使い、版種・
 * 基準日だけファイル名由来で上書きする。無ければ共通ダミー(`buildSampleData`)へ
 * フォールバックする。
 */
function resolveSample(fundCode: string, attrs: SampleTemplateAttributes): SampleData {
  const file = resolve(sampleDir, `${fundCode}.json`);
  if (existsSync(file)) {
    const real = JSON.parse(readFileSync(file, 'utf8')) as SampleData;
    return applyTemplateAttributes(real, attrs);
  }
  return buildSampleData(funds[fundCode], fundCode, attrs);
}

// Auto-discover every template fixture; fund code + edition type come from the
// file name. Sample values come from the per-fund real sample (fallback: common).
for (const file of readdirSync(templatesDir).filter((f) => f.endsWith('.html'))) {
  const attrs = parseTemplateFileName(file);
  if (!attrs) {
    console.warn(`skip ${file}: ファイル名から属性を解決できません`);
    continue;
  }
  const raw = readFileSync(resolve(templatesDir, file), 'utf8');
  const sample = resolveSample(attrs.fundCode, attrs);
  const filled = toFilled(raw, sample);
  for (const d of outDirs) writeFileSync(resolve(d, file), filled, 'utf8');
  console.log(`wrote ${file} (${filled.length} chars)`);
}
