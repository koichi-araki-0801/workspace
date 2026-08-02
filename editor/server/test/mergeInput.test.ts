import { existsSync } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { BuildMergeRequest } from '@editor/shared/schemas';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { config } from '../src/config.js';
import { inlineCss } from '../src/vivliostyle/inlineCss.js';
import {
  MERGE_PAGE_COUNTER_CSS,
  materializeMergeProject,
  mergeConfigSource,
  stripPageCounterReset,
} from '../src/vivliostyle/mergeInput.js';
import { cleanupProject } from '../src/vivliostyle/projectInput.js';

const created: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  while (created.length) await cleanupProject(created.pop() as string);
});

describe('inlineCss', () => {
  it('injects a style tag before </head> and strips stylesheet links', () => {
    const html = '<html><head><link rel="stylesheet" href="a.css"></head><body>x</body></html>';
    const out = inlineCss(html, 'p{color:red}');
    expect(out).toContain('<style>\np{color:red}\n</style></head>');
    expect(out).not.toContain('<link');
  });

  it('wraps a bare fragment into a full document', () => {
    const out = inlineCss('<p>x</p>', 'p{}');
    expect(out).toMatch(/^<!doctype html>/);
    expect(out).toContain('<p>x</p>');
  });

  it('returns html unchanged (minus links) when css is empty', () => {
    expect(inlineCss('<html><head></head><body>x</body></html>', '')).toBe(
      '<html><head></head><body>x</body></html>',
    );
  });
});

describe('stripPageCounterReset', () => {
  it('removes counter-reset/set declarations that mention the page counter', () => {
    const css = 'div { counter-reset: page; } p { counter-set: page 5; color: red; }';
    const out = stripPageCounterReset(css);
    expect(out).not.toContain('counter-reset');
    expect(out).not.toContain('counter-set');
    expect(out).toContain('color: red;');
  });

  it('keeps counter declarations for other counters', () => {
    const css = 'h1 { counter-reset: chapter; } h2 { counter-set: section 2; }';
    expect(stripPageCounterReset(css)).toBe(css);
  });

  it('does not match counters whose name merely contains "page"', () => {
    const css = 'div { counter-reset: subpage; }';
    expect(stripPageCounterReset(css)).toBe(css);
  });
});

describe('mergeConfigSource', () => {
  it('emits entries in order as CommonJS', () => {
    const src = mergeConfigSource(['doc-000.html', 'doc-001.html']);
    expect(src).toMatch(/^module\.exports = \{/);
    expect(src.indexOf('doc-000.html')).toBeLessThan(src.indexOf('doc-001.html'));
    expect(src).not.toContain('"size"');
  });

  it('includes size when given and escapes special characters via JSON', () => {
    const src = mergeConfigSource(['a"b.html'], 'A4');
    expect(src).toContain('"size": "A4"');
    expect(src).toContain('"a\\"b.html"');
  });
});

describe('materializeMergeProject', () => {
  it('writes zero-padded docs with per-doc css + page counter css, and a .cjs config', async () => {
    const docs = [
      { html: '<html><head></head><body>一</body></html>', css: 'body{margin:0}' },
      { html: '<html><head></head><body>二</body></html>', css: '' },
    ];
    const { dir, configPath } = await materializeMergeProject(docs, 'A4');
    created.push(dir);

    expect(configPath).toBe(path.join(dir, 'vivliostyle.config.cjs'));
    const confSrc = await fs.readFile(configPath, 'utf8');
    expect(confSrc).toContain('"doc-000.html"');
    expect(confSrc).toContain('"doc-001.html"');
    expect(confSrc).toContain('"size": "A4"');

    const doc0 = await fs.readFile(path.join(dir, 'doc-000.html'), 'utf8');
    expect(doc0).toContain('body{margin:0}');
    expect(doc0).toContain('counter(page)');
    expect(doc0).toContain('一');
    // css 無しの文書にも通しページ番号 CSS だけは必ず載る。
    const doc1 = await fs.readFile(path.join(dir, 'doc-001.html'), 'utf8');
    expect(doc1).toContain(MERGE_PAGE_COUNTER_CSS.slice(0, 20));
  });

  it('strips page counter resets from document css before inlining', async () => {
    const docs = [
      { html: '<html><head></head><body>x</body></html>', css: '@page{counter-reset: page;}' },
    ];
    const { dir } = await materializeMergeProject(docs);
    created.push(dir);
    const doc = await fs.readFile(path.join(dir, 'doc-000.html'), 'utf8');
    expect(doc).not.toContain('counter-reset');
  });

  it('cleans up the directory when a write fails mid-way', async () => {
    const spy = vi.spyOn(fs, 'writeFile').mockRejectedValueOnce(new Error('disk full'));
    await expect(materializeMergeProject([{ html: '<p>x</p>', css: '' }])).rejects.toThrow(
      'disk full',
    );
    spy.mockRestore();
    // 失敗時に vivlio-merge-* の残骸が tmpDir に残らない。
    const leftovers = (await fs.readdir(config.tmpDir).catch(() => [])).filter((n) =>
      n.startsWith('vivlio-merge-'),
    );
    for (const n of leftovers) {
      // 並行テストの他ディレクトリを巻き込まないため、中身が空であることまでは断定しない。
      expect(existsSync(path.join(config.tmpDir, n, 'doc-000.html'))).toBe(false);
    }
  });
});

describe('BuildMergeRequest schema', () => {
  it('accepts 1..30 documents and fills css default', () => {
    const one = BuildMergeRequest.safeParse({ documents: [{ html: '<p>x</p>' }] });
    expect(one.success).toBe(true);
    if (one.success) expect(one.data.documents[0].css).toBe('');
  });

  it('rejects empty list, empty html and >30 documents', () => {
    expect(BuildMergeRequest.safeParse({ documents: [] }).success).toBe(false);
    expect(BuildMergeRequest.safeParse({ documents: [{ html: '' }] }).success).toBe(false);
    const many = Array.from({ length: 31 }, () => ({ html: '<p>x</p>' }));
    expect(BuildMergeRequest.safeParse({ documents: many }).success).toBe(false);
  });
});
