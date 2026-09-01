import { existsSync } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { BuildMergeRequest } from '@editor/shared/schemas';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { config } from '../src/config.js';
import {
  MERGE_PAGE_COUNTER_CSS,
  materializeMergeProject,
  mergeConfigObject,
  stripPageCounterReset,
} from '../src/vivliostyle/mergeInput.js';
import { cleanupProject } from '../src/vivliostyle/projectInput.js';

const created: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  while (created.length) await cleanupProject(created.pop() as string);
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

describe('mergeConfigObject', () => {
  it('emits entries in order with a fixed base', () => {
    expect(mergeConfigObject(['doc-000.html', 'doc-001.html'])).toEqual({
      entry: ['doc-000.html', 'doc-001.html'],
      base: '/vivliostyle',
    });
  });

  it('includes size only when given', () => {
    expect(mergeConfigObject(['a.html'], 'A4').size).toBe('A4');
    expect(mergeConfigObject(['a.html'])).not.toHaveProperty('size');
  });
});

describe('materializeMergeProject', () => {
  it('writes zero-padded docs with per-doc css + page counter css, and no config file', async () => {
    const docs = [
      { html: '<html><head></head><body>一</body></html>', css: 'body{margin:0}' },
      { html: '<html><head></head><body>二</body></html>', css: '' },
    ];
    const { dir, config: mergeConfig } = await materializeMergeProject(docs, 'A4');
    created.push(dir);

    expect(mergeConfig.entry).toEqual(['doc-000.html', 'doc-001.html']);
    expect(mergeConfig.size).toBe('A4');
    // 実行可能な config をリポジトリから消した(CLI へは `configData` で渡す)。ここが
    // 戻ると「config はオブジェクトでしか CLI へ渡らない」不変則が破れる。
    for (const name of [
      'vivliostyle.config.cjs',
      'vivliostyle.config.js',
      'vivliostyle.config.json',
    ]) {
      expect(existsSync(path.join(dir, name)), name).toBe(false);
    }

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
    // `tmpDir` は他のテストや同時に走る PDF ビルドとも共有する。そこにある
    // `vivlio-merge-*` を一律に見ると、他の主体が残した 1 つで以後ずっと赤くなるため、
    // **このテストの前後で増えた分**だけを検査する。
    const listMergeDirs = async () =>
      (await fs.readdir(config.tmpDir).catch(() => [])).filter((n) =>
        n.startsWith('vivlio-merge-'),
      );
    const before = new Set(await listMergeDirs());
    const spy = vi.spyOn(fs, 'writeFile').mockRejectedValueOnce(new Error('disk full'));
    await expect(materializeMergeProject([{ html: '<p>x</p>', css: '' }])).rejects.toThrow(
      'disk full',
    );
    spy.mockRestore();
    // 失敗時に vivlio-merge-* の残骸が tmpDir に残らない。
    const added = (await listMergeDirs()).filter((n) => !before.has(n));
    for (const n of added) {
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
