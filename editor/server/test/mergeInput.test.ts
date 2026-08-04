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
  mergeConfigObject,
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

  // `css` は `/api/build`・`/api/build/merge`・`/api/preview`(inline)のリクエスト本文
  // そのもの。`<style>` は raw text 要素なので、`</style>` を書かれると要素が閉じて
  // 続きが HTML として解釈される。PDF build 経路には CSP が無く、ここが唯一の防壁。
  it('neutralises a </style> escape in user css (head / body / wrapper paths)', () => {
    const evil = '}</style><script>fetch("/api/review-requests")</script><style>{';
    for (const html of ['<html><head></head><body>x</body></html>', '<body>x</body>', '<p>x</p>']) {
      const out = inlineCss(html, evil);
      // `<style>` を閉じさせない: 終端タグは差し込んだ 1 つだけで、`<script>` は style の
      // 中身(raw text)のまま = 実行されない。
      expect(out.match(/<\/style>/gi) ?? [], html).toHaveLength(1);
      expect(out, html).not.toContain('</style><script');
      // 内容は落とさない: CSS のエスケープ `\/` は文字列中で `/` と同義。
      expect(out, html).toContain('<\\/style>');
    }
  });

  it('leaves ordinary css byte-identical', () => {
    const css = 'p{color:red}\n@page{size:A4}\na::after{content:"a/b"}';
    expect(inlineCss('<html><head></head><body>x</body></html>', css)).toContain(
      `<style>\n${css}\n</style>`,
    );
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

  it('keeps non-stylesheet links and elements whose name merely starts with "link"', () => {
    const html =
      '<head><link rel="icon" href="i.png">' +
      "<link rel=stylesheet href='a.css'>" +
      '<linkish rel="stylesheet"></head><body>x</body>';
    const out = inlineCss(html, '');
    expect(out).toContain('<link rel="icon" href="i.png">');
    expect(out).toContain('<linkish rel="stylesheet">');
    expect(out).not.toContain('a.css');
  });

  it('injects into the body tag when there is no head', () => {
    const out = inlineCss('<body class="p">x</body>', 'b{}');
    expect(out).toBe('<body class="p"><style>\nb{}\n</style>x</body>');
  });

  // 差し込みは文字列連結で行う。`replace` の置換文字列は `$&` などを特殊解釈するため、
  // CSS(利用者入力)がそのまま化ける。
  it('inserts css containing $-patterns verbatim', () => {
    const css = "a::after{content:'$& $` $0'}";
    expect(inlineCss('<html><head></head><body>x</body></html>', css)).toContain(css);
    expect(inlineCss('<body>x</body>', css)).toContain(css);
  });

  // 二次バックトラックの回帰テスト: `>` を一切含まない入力は、旧実装だと `<link` の
  // 出現ごとに末尾まで舐め直してイベントループを塞いだ。
  it('handles pathological link-heavy input in linear time', () => {
    const html = '<link '.repeat(200_000);
    const started = performance.now();
    expect(inlineCss(html, '')).toBe(html);
    expect(performance.now() - started).toBeLessThan(2000);
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
