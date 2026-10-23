// =============================================================================
// docRefs.test.ts — 「文書が参照している資産」の洗い出しが staging と食い違わないこと
// =============================================================================
// ここが取りこぼすと `stageDocAssets` が資産を置かず、`inlineCss` が「実体が無い」として
// `<link>`/`<script src>` を落とす = **静かに見た目が劣化する**。よって主張は
// 「拾えること」を厚く、「拾いすぎても害が無い」ことを 1 本、の配分にする。
// 文書は論理ルートの `doc/` に置かれたものとして参照を解く(`resolveDocAssetPath`)。
import { describe, expect, it } from 'vitest';
import { collectDocumentAssetRefs } from '../src/vivliostyle/docRefs.js';

const refs = (html: string, css = ''): string[] => [...collectDocumentAssetRefs(html, css)].sort();

describe('collectDocumentAssetRefs — 取得系属性', () => {
  it('../css・../js・../images(会社フォルダ含む)を論理ルート相対へ解く', () => {
    expect(
      refs(
        '<html><head><link rel="stylesheet" href="../css/A_1_交付版.css">' +
          '<script src="../js/column-width.js"></script></head>' +
          '<body><img src="../images/smtam/qr.svg"></body></html>',
      ),
    ).toEqual(
      expect.arrayContaining(['css/A_1_交付版.css', 'js/column-width.js', 'images/smtam/qr.svg']),
    );
  });

  // 属性を取得系に絞らないので、取得系の一覧に無い属性の参照も候補に上がる。候補は
  // `stageDocAssets` が資産目録と突き合わせるので、目録に無いものは黙って消える。
  it('取得系でない属性の値も候補に上がる(過剰包含は目録との突き合わせで消える)', () => {
    expect(refs('<div data-bg="../images/a.png"></div>')).toContain('images/a.png');
  });

  it('`./` 付き・クエリ付きも同じ資産へ正規化する(staging の解決と同じ関数)', () => {
    expect(refs('<link href="./../css/A_1_交付版.css?v=3">')).toEqual(['css/A_1_交付版.css']);
  });

  it('オリジン外の絶対参照・ルートの外へ出る参照は資産として拾わない', () => {
    expect(refs('<link href="https://evil.example/x.css">')).toEqual([]);
    expect(refs('<link href="/css/A_1_交付版.css">')).toEqual([]);
    expect(refs('<link href="../../css/A_1_交付版.css">')).toEqual([]);
  });

  it('srcset 系は候補ごとに分けて記述子を外して拾う', () => {
    expect(
      refs(
        '<img srcset="../images/a.png 1x, ../images/b.png 2x">' +
          '<picture><source srcset="../images/c.png 480w,../images/d.png"></picture>' +
          '<link rel="preload" as="image" imagesrcset="../images/e.png 1x">',
      ),
    ).toEqual(
      expect.arrayContaining([
        'images/a.png',
        'images/b.png',
        'images/c.png',
        'images/d.png',
        'images/e.png',
      ]),
    );
  });

  it('文書直下基準(css/… images/…)は資産として拾わない(doc/ 配下を指す = 規約外)', () => {
    expect(refs('<link href="css/x.css"><img src="images/a.svg">')).toEqual([]);
  });
});

describe('collectDocumentAssetRefs — CSS を書ける 3 面', () => {
  it('リクエストの css(rebaseCssForDoc 済み = 文書基準)の url() を拾う', () => {
    expect(refs('<p>x</p>', '@font-face{src:url("../css/fonts/BIZUD.woff2")}')).toEqual([
      'css/fonts/BIZUD.woff2',
    ]);
  });

  it('<style> ブロックの url() を文書基準で拾う', () => {
    expect(refs('<head><style>.a{background:url(../images/logo.png)}</style></head>')).toEqual([
      'images/logo.png',
    ]);
  });

  it('style 属性の url() を文書基準で拾う', () => {
    expect(refs('<div style="background:url(../images/b.png)"></div>')).toEqual(['images/b.png']);
  });

  it('CSS のエスケープを解いた形で拾う(トークナイザを共有している証拠)', () => {
    expect(refs('<p>x</p>', '.a{background:url(..\\2f images\\2f a.png)}')).toEqual([
      'images/a.png',
    ]);
  });
});

describe('collectDocumentAssetRefs — 壊れた入力', () => {
  // タグ境界が一意に決まらない入力は `assertNoDocumentExternalRefs` が
  // `DOCUMENT_UNPARSABLE` で先に 400 にする。ここで手当てすると二重防御に見えて、
  // どちらが関門かが曖昧になる。
  it('走査を諦める HTML では HTML 側の参照を返さない(400 が先に立つ)', () => {
    expect(refs('<link href="../css/A_1_交付版.css"')).toEqual([]);
  });

  it('css だけは走査不能な HTML でも拾う(css は独立して解ける)', () => {
    expect(refs('<div', '.a{background:url(../images/a.png)}')).toEqual(['images/a.png']);
  });
});
