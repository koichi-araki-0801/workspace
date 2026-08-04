// =============================================================================
// projectConfig.test.ts — アップロード config のフィールド許可リスト
// =============================================================================
// ここが閉じていないと、`entry` のパスだけ検査しても `server.proxy`(上流 Vite を踏み台に
// した SSRF)・`pdfPostprocess`(docker / press-ready 起動)・`static`(任意ディレクトリ配信)が
// 素通りする。テストは「この迂回入力が 400 になること」の形で書く。
import path from 'node:path';
import { isAppError } from '@editor/shared';
import { describe, expect, it } from 'vitest';
import { parseProjectConfig } from '../src/vivliostyle/projectConfig.js';

const ROOT = path.resolve('/tmp/vivlio-root');
/** 実在判定の差し替え。`theme.css` と `sub/theme.css` だけが在ることにする。 */
const isFile = (p: string): boolean =>
  [path.resolve(ROOT, 'theme.css'), path.resolve(ROOT, 'sub/theme.css')].includes(p);

const parse = (obj: unknown) => parseProjectConfig(JSON.stringify(obj), ROOT, isFile);
const parseText = (text: string) => parseProjectConfig(text, ROOT, isFile);

describe('parse そのもの', () => {
  it('JSONC は 400(パーサを 1 つに絞ったので、コメント入りは単に読めない)', () => {
    // 以前は我々が JSON.parse に失敗すると黙って素通しし、CLI 側は JSONC で読めていた。
    // 同じバイト列を 2 つのパーサが読む構造こそが根で、第 2 のパーサを消すのが直し方。
    expect(() => parseText('{"entry":"a.md" /* c */}')).toThrow();
    expect(() => parseText('// x\n{"entry":"a.md"}')).toThrow();
    expect(() => parseText('{"entry":"a.md",}')).toThrow();
  });

  it('壊れた JSON は 400(旧実装は素通ししていた)', () => {
    expect(() => parseText('not json at all')).toThrow();
    expect(() => parseText('')).toThrow();
  });

  it('BOM 付きの正当な JSON は通る', () => {
    expect(parseText('\uFEFF{"entry":"a.md"}').entry).toBe('a.md');
  });

  it('配列(複数タスク)は 400', () => {
    expect(() => parse([{ entry: 'a.md' }])).toThrow();
  });

  it('prototype 汚染を持ち込めない', () => {
    expect(() => parseText('{"entry":"a.md","__proto__":{"polluted":1}}')).toThrow();
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });

  it('すべての失敗は AppError(400)である', () => {
    try {
      parseText('nope');
      throw new Error('should have thrown');
    } catch (e) {
      expect(isAppError(e)).toBe(true);
    }
  });
});

describe('未知フィールド', () => {
  it.each([
    'vite',
    'viteConfigFile',
    'server',
    'static',
    'output',
    'workspaceDir',
    'pdfPostprocess',
    'pressReady',
    'image',
    'browser',
    'viewer',
    'viewerParam',
    'timeout',
    'temporaryFilePrefix',
    'includeAssets',
    'vfm',
    'documentProcessor',
  ])('%s は 400', (key) => {
    expect(() => parse({ entry: 'a.md', [key]: {} })).toThrow();
  });

  it('server.proxy を持つ config は 400(上流 Vite を踏み台にした SSRF の入口)', () => {
    expect(() =>
      parse({ entry: 'a.md', server: { proxy: { '/x': 'http://169.254.169.254' } } }),
    ).toThrow();
  });

  it('400 のメッセージにキー名が入る(黙って捨てない)', () => {
    expect(() => parse({ entry: 'a.md', pdfPostprocess: {} })).toThrow(/pdfPostprocess/);
  });
});

describe('base', () => {
  it('利用者は base を指定できない', () => {
    expect(() => parse({ entry: 'a.md', base: '/docs' })).toThrow();
    expect(() => parse({ entry: 'a.md', base: '/__vivliostyle-viewer' })).toThrow();
  });

  it('返却オブジェクトの base は常に /vivliostyle', () => {
    expect(parse({ entry: 'a.md' }).base).toBe('/vivliostyle');
  });
});

describe('theme', () => {
  it('展開ルート内の実在する .css は通る', () => {
    expect(parse({ entry: 'a.md', theme: 'theme.css' }).theme).toBe('theme.css');
    expect(parse({ entry: 'a.md', theme: 'sub/theme.css' }).theme).toBe('sub/theme.css');
  });

  it.each([
    // 大小文字を畳んではいけない。CLI 側は `endsWith(".css")` で区別するため、畳んで通すと
    // file 分岐に入らず npa → arborist の postinstall へ落ちる(R7 の本体)。
    'theme.CSS',
    '../outside.css',
    'http://evil.example/x.css',
    'file:///etc/x.css',
    // npm パッケージ名 / ディレクトリ指定子は arborist 経路そのもの。
    'my-theme',
    '@vivliostyle/theme-techbook',
    'themes/',
    // 実在しない .css も拒否(`existsSync` が false だと CLI が file 分岐に入らない)。
    'ghost.css',
  ])('%s は 400', (theme) => {
    expect(() => parse({ entry: 'a.md', theme })).toThrow();
  });

  it('オブジェクト形({specifier})は 400', () => {
    expect(() => parse({ entry: 'a.md', theme: { specifier: 'my-theme' } })).toThrow();
  });

  it('配列は全要素を検証する(1 つでも素通しすると arborist 経路が開く)', () => {
    expect(parse({ entry: 'a.md', theme: ['theme.css'] }).theme).toEqual(['theme.css']);
    expect(() => parse({ entry: 'a.md', theme: ['theme.css', 'evil-dir'] })).toThrow();
  });

  it('entry ごとの theme も同じ規則で検証する', () => {
    expect(() => parse({ entry: [{ path: 'a.md', theme: '../../evil.css' }] })).toThrow();
    expect(() => parse({ entry: [{ path: 'a.md', theme: 'my-theme' }] })).toThrow();
  });
});

describe('entry / entryContext', () => {
  it.each([
    '../../../etc/passwd',
    'C:/Windows/x.html',
    'http://127.0.0.1:9200/x',
    'file:///etc/passwd',
    'x\u0000.html',
  ])('entry %s は 400', (entry) => {
    expect(() => parse({ entry })).toThrow();
  });

  it('entry の要素オブジェクトに未知キーがあれば 400', () => {
    expect(() => parse({ entry: [{ path: 'a.md', output: 'x.pdf' }] })).toThrow();
  });

  it('entry が無い / 空配列は 400', () => {
    expect(() => parse({ title: 'x' })).toThrow();
    expect(() => parse({ entry: [] })).toThrow();
  });

  it("entryContext: '.' は正当な入力として通る(普通のプロジェクトを 400 にしない)", () => {
    expect(parse({ entry: 'a.md', entryContext: '.' }).entryContext).toBe('.');
  });

  it('entryContext の脱出は 400', () => {
    expect(() => parse({ entry: 'a.md', entryContext: '../..' })).toThrow();
    expect(() => parse({ entry: 'a.md', entryContext: 'C:/Windows' })).toThrow();
  });
});

describe('その他のフィールド', () => {
  it('cover / toc のパスも封じ込める', () => {
    expect(() => parse({ entry: 'a.md', cover: '../evil.png' })).toThrow();
    expect(() => parse({ entry: 'a.md', cover: { src: '../evil.png' } })).toThrow();
    expect(() => parse({ entry: 'a.md', toc: { htmlPath: '../evil.html' } })).toThrow();
    expect(() => parse({ entry: 'a.md', toc: { transformDocumentList: 'x' } })).toThrow();
    expect(parse({ entry: 'a.md', toc: true }).toc).toBe(true);
  });

  it('copyAsset の glob は相対のみ', () => {
    expect(parse({ entry: 'a.md', copyAsset: { includes: ['assets/**'] } }).copyAsset).toEqual({
      includes: ['assets/**'],
    });
    expect(() => parse({ entry: 'a.md', copyAsset: { includes: ['../**'] } })).toThrow();
    expect(() => parse({ entry: 'a.md', copyAsset: { includes: ['/etc/**'] } })).toThrow();
    expect(() => parse({ entry: 'a.md', copyAsset: { extra: [] } })).toThrow();
  });

  it('自由文字列は長さ上限を持つ', () => {
    expect(() => parse({ entry: 'a.md', title: 'x'.repeat(2000) })).toThrow();
    expect(parse({ entry: 'a.md', title: '報告書', size: 'A4' }).title).toBe('報告書');
  });

  it('受理したキーだけが出力に載る(片方向の移し替えである)', () => {
    const out = parse({ entry: 'a.md', title: 't' });
    expect(Object.keys(out).sort()).toEqual(['base', 'entry', 'title']);
  });
});
