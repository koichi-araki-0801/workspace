// =============================================================================
// svgInspect.tools.test.ts — 社内ツールが実際に出す SVG が inspectSvg を通ることの固定
// =============================================================================
// 画像は pdf-to-svg と pie-chart が作って images/ に置く。検査が実出力を落とすと、正当な画像が
// 黙って表示されなくなる(配置しない・404)。見本は手で書かず、ツールの出力をそのまま置いている。
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { inspectSvg } from '../src/security/svgInspect.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const TOOLS = path.join(HERE, 'fixtures', 'svg', 'tools');

const samples = ['pie-chart', 'pdf-to-svg'].flatMap((tool) =>
  readdirSync(path.join(TOOLS, tool))
    .filter((f) => f.endsWith('.svg'))
    .map((f) => [`${tool}/${f}`, path.join(TOOLS, tool, f)] as const),
);

describe('社内ツールの実出力', () => {
  it('両ツールの見本が 1 本以上ある', () => {
    expect(samples.some(([n]) => n.startsWith('pie-chart/'))).toBe(true);
    expect(samples.some(([n]) => n.startsWith('pdf-to-svg/'))).toBe(true);
  });

  it.each(samples)('%s は違反なし', (_name, file) => {
    expect(inspectSvg(readFileSync(file, 'utf8'))).toEqual([]);
  });
});
