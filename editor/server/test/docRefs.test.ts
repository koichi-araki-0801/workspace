// =============================================================================
// docRefs.test.ts — 「文書が参照している資産」の洗い出しが staging と食い違わないこと
// =============================================================================
// ここが取りこぼすと `stageDocAssets` が資産を置かず、`inlineCss` が「実体が無い」として
// `<link>`/`<script src>` を落とす = **静かに見た目が劣化する**。よって主張は
// 「拾えること」を厚く、「拾いすぎても害が無い」ことを 1 本、の配分にする。
import { describe, expect, it } from 'vitest';
import { collectDocumentAssetRefs, resolveRefFrom } from '../src/vivliostyle/docRefs.js';

const refs = (html: string, css = ''): string[] => [...collectDocumentAssetRefs(html, css)].sort();

describe('collectDocumentAssetRefs — 取得系属性', () => {
  it('link href / script src を拾う', () => {
    expect(
      refs(
        '<html><head><link rel="stylesheet" href="css/510037.css">' +
          '<script src="js/column-width.js"></script></head><body>x</body></html>',
      ),
    ).toEqual(expect.arrayContaining(['css/510037.css', 'js/column-width.js']));
  });

  // 属性を取得系に絞らないので、`rel="stylesheet"` のような値も候補として上がる。
  // 候補は `stageDocAssets` が資産目録と突き合わせるので、目録に無いものは黙って消える。
  // 「拾いすぎる」側の誤りは配置が 1 つ増えるだけで、「取りこぼす」側は静かな劣化になる。
  it('取得系でない属性の値も候補に上がる(過剰包含は目録との突き合わせで消える)', () => {
    expect(refs('<link rel="stylesheet" href="css/510037.css">')).toContain('stylesheet');
  });

  it('`./` 付き・クエリ付きも同じ資産へ正規化する(staging の解決と同じ関数)', () => {
    expect(refs('<link href="./css/510037.css?v=3">')).toEqual(['css/510037.css']);
  });

  it('オリジン外の絶対参照は資産として拾わない(そもそも 400 で落ちる入力)', () => {
    expect(refs('<link href="https://evil.example/x.css">')).toEqual([]);
    expect(refs('<link href="/css/510037.css">')).toEqual([]);
  });
});

describe('collectDocumentAssetRefs — CSS を書ける 3 面', () => {
  it('リクエストの css の url() を拾う', () => {
    expect(refs('<p>x</p>', '@font-face{src:url(fonts/BIZUD.woff2)}')).toEqual([
      'fonts/BIZUD.woff2',
    ]);
  });

  it('<style> ブロックの url() を拾う', () => {
    expect(refs('<head><style>.a{background:url(img/logo.png)}</style></head>')).toEqual([
      'img/logo.png',
    ]);
  });

  it('style 属性の url() を拾う', () => {
    expect(refs('<div style="background:url(fonts/x.woff2)"></div>')).toEqual(['fonts/x.woff2']);
  });

  it('CSS のエスケープを解いた形で拾う(トークナイザを共有している証拠)', () => {
    expect(refs('<p>x</p>', '.a{background:url(css\\2f a.png)}')).toEqual(['css/a.png']);
  });
});

describe('collectDocumentAssetRefs — 壊れた入力', () => {
  // タグ境界が一意に決まらない入力は `assertNoDocumentExternalRefs` が
  // `DOCUMENT_UNPARSABLE` で先に 400 にする。ここで手当てすると二重防御に見えて、
  // どちらが関門かが曖昧になる。
  it('走査を諦める HTML では HTML 側の参照を返さない(400 が先に立つ)', () => {
    expect(refs('<link href="css/510037.css"')).toEqual([]);
  });

  it('css だけは走査不能な HTML でも拾う(css は独立して解ける)', () => {
    expect(refs('<div', '.a{background:url(css/a.png)}')).toEqual(['css/a.png']);
  });
});

describe('resolveRefFrom — 参照元ファイルからの相対解決', () => {
  it.each([
    ['css/510037.css', '../fonts/a.woff2', 'fonts/a.woff2'],
    ['css/510037.css', 'sub/b.png', 'css/sub/b.png'],
    ['', 'fonts/a.woff2', 'fonts/a.woff2'],
  ])('%s から %s → %s', (base, url, expected) => {
    expect(resolveRefFrom(base, url)).toBe(expected);
  });

  it('配信ルートの外へ出る形は解決しない', () => {
    expect(resolveRefFrom('css/510037.css', '../../secret.css')).toBeUndefined();
    expect(resolveRefFrom('css/510037.css', 'https://evil.example/x.css')).not.toBe(
      'https://evil.example/x.css',
    );
  });
});
