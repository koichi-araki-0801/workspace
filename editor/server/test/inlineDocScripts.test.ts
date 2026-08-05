// =============================================================================
// inlineDocScripts.test.ts — 外部 JS のインライン展開(PDF 経路)
// =============================================================================
// 主張は 2 系統。①「配信ルートに実体がある相対参照だけが展開される」(迂回入力は展開しない)、
// ② 展開が**文書を壊さない**(`</script` 脱出・script data 二重エスケープ)。
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { inlineDocScripts } from '../src/vivliostyle/inlineDocScripts.js';

let root = '';
const SERVED = new Set(['js/app.js', 'js/evil.js', 'js/nested.js', 'css/a.css']);

beforeAll(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'inline-scripts-'));
  await fs.mkdir(path.join(root, 'js'), { recursive: true });
  await fs.mkdir(path.join(root, 'css'), { recursive: true });
  await fs.writeFile(path.join(root, 'js', 'app.js'), 'window.MARK = 1;', 'utf8');
  // `</script>` の字面を含む JS(素朴に埋め込むと要素がここで閉じ、残りがマークアップ化する)。
  await fs.writeFile(
    path.join(root, 'js', 'evil.js'),
    `var s = "</script><img src=x onerror=alert(1)>";`,
    'utf8',
  );
  // script data 二重エスケープを起こす形。展開を諦める側へ倒れることを固定する。
  await fs.writeFile(path.join(root, 'js', 'nested.js'), 'var a = "<!--" + "<script>";', 'utf8');
  await fs.writeFile(path.join(root, 'css', 'a.css'), 'body{}', 'utf8');
});

afterAll(async () => {
  if (root) await fs.rm(root, { recursive: true, force: true });
});

describe('inlineDocScripts — 展開の対象', () => {
  it('配信ルートに実体のある相対参照をインライン化する', async () => {
    const out = await inlineDocScripts(
      '<html><body><script src="js/app.js"></script></body></html>',
      root,
      SERVED,
    );
    expect(out).toContain('window.MARK = 1;');
    expect(out).not.toContain('src="js/app.js"');
  });

  it('配信していない参照は原文のまま残す(展開しない)', async () => {
    const html = '<script src="js/missing.js"></script>';
    expect(await inlineDocScripts(html, root, SERVED)).toBe(html);
  });

  it('絶対参照・ルート絶対は展開しない(解決器が undefined を返す)', async () => {
    for (const src of ['https://evil/x.js', '//evil/x.js', '/js/app.js']) {
      const html = `<script src="${src}"></script>`;
      expect(await inlineDocScripts(html, root, SERVED)).toBe(html);
    }
  });

  it('`..` で配信ルートの外へ出る形は展開しない', async () => {
    const html = '<script src="js/../../js/app.js"></script>';
    expect(await inlineDocScripts(html, root, SERVED)).toBe(html);
  });

  it('src 以外の属性(integrity など)を持つ script は展開しない', async () => {
    const html = '<script src="js/app.js" integrity="sha384-x"></script>';
    expect(await inlineDocScripts(html, root, SERVED)).toBe(html);
  });

  it('素のインライン script・link は触らない', async () => {
    const html = '<link rel="stylesheet" href="css/a.css"><script>var a=1;</script>';
    expect(await inlineDocScripts(html, root, SERVED)).toBe(html);
  });
});

describe('inlineDocScripts — 文書を壊さない', () => {
  it('`</script` を中和して要素の途中閉じを起こさない', async () => {
    const out = await inlineDocScripts(
      '<body><script src="js/evil.js"></script><p id="after">x</p></body>',
      root,
      SERVED,
    );
    // 中和済み: 生の `</script>` は末尾の 1 つだけ。
    expect(out.match(/<\/script/gi) ?? []).toHaveLength(1);
    expect(out).toContain('<\\/script>');
    // 後続のマークアップが script の中身へ飲み込まれていない。
    expect(out).toContain('<p id="after">x</p>');
    // 注入されたはずの `onerror` は文字列リテラルの中に留まる(要素として復活しない)。
    expect(out.indexOf('onerror')).toBeLessThan(out.lastIndexOf('</script>'));
  });

  it('`<!--` を含む JS は展開せず原文のまま残す(二重エスケープ回避)', async () => {
    const html = '<script src="js/nested.js"></script><p>after</p>';
    expect(await inlineDocScripts(html, root, SERVED)).toBe(html);
  });

  it('タグ走査が一意に決まらない入力は一切加工しない', async () => {
    // 閉じない属性引用符で `scanTags` が ok:false になる形。
    const html = '<script src="js/app.js"></script><div title="';
    expect(await inlineDocScripts(html, root, SERVED)).toBe(html);
  });
});
