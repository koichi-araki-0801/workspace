// =============================================================================
// nunjucksRender.test.ts — プレビュー文書組み立ての回帰
// =============================================================================
// 主張はすべて**再パースした DOM**に対して行う。`toContain('<style data-preview-css>')` の
// ような字面比較は (a) 直列化の些細な差(`data-preview-css=""`)で壊れ、(b) 攻撃者が本文に
// 同じ字面を書くだけで満たせてしまうため、ガードとして機能しない。
import { describe, expect, it } from 'vitest';
import { assemblePreviewDocument, renderJinja } from '../src/lib/nunjucksRender';

/** 生成文書を HTML パーサへ戻す。「文字列にどう見えるか」ではなく「何になるか」を見る。 */
function parse(html: string): Document {
  return new DOMParser().parseFromString(html, 'text/html');
}

/** 文書中に live な `on*` 属性が 1 つも無いこと(字面ではなく属性として存在しないこと)。 */
function expectNoEventHandlers(doc: Document): void {
  const offenders: string[] = [];
  for (const el of Array.from(doc.querySelectorAll('*'))) {
    for (const attr of Array.from(el.attributes)) {
      if (/^on/i.test(attr.name)) offenders.push(`${el.tagName}[${attr.name}]`);
    }
  }
  expect(offenders, `復活したイベントハンドラ: ${offenders.join(', ')}`).toEqual([]);
}

describe('renderJinja', () => {
  it('renders a template with the given data', () => {
    const r = renderJinja('Hello {{ name }}', { name: 'World' });
    expect(r.error).toBeNull();
    expect(r.html).toBe('Hello World');
  });

  it('returns an error string (not a throw) on a broken template', () => {
    const r = renderJinja('{% if %}', {});
    expect(r.html).toBe('');
    expect(r.error).toBeTruthy();
  });
});

// 旧 `buildPreviewDocument`(描画 + 組み立ての一括)は撤去した — 描画を含む以上アプリ
// オリジンでのコンパイル経路になり、`renderJinja` 禁止の抜け道になるため。組み立て側の
// 契約はここで、描画済み HTML を入力として固定する(描画は隔離 iframe が返す文字列)。
describe('assemblePreviewDocument — 文書の正規化と CSS の inline 化', () => {
  it('injects the style tag as the last child of <head>', () => {
    const html = assemblePreviewDocument(
      '<html><head><title>t</title></head><body>X</body></html>',
      '.a{color:red}',
    );
    const doc = parse(html);
    const style = doc.querySelector('style[data-preview-css]');
    expect(style?.parentElement?.tagName).toBe('HEAD');
    expect(style?.textContent).toMatch(/color:\s*red/);
    expect(doc.body.textContent).toContain('X');
  });

  it('normalizes a head-less document and injects the inlined CSS (body attrs/content kept)', () => {
    // サニタイズ(DOMPurify, WHOLE_DOCUMENT)が <head> を補完するため、CSS は head に入る。
    const html = assemblePreviewDocument('<body class="r">X</body>', '.a{}');
    expect(html).toContain('<!doctype html>');
    const doc = parse(html);
    expect(doc.querySelector('style[data-preview-css]')?.parentElement?.tagName).toBe('HEAD');
    expect(doc.body.getAttribute('class')).toBe('r');
    expect(doc.body.textContent).toContain('X');
  });

  it('wraps a bare fragment in a full document', () => {
    const html = assemblePreviewDocument('X', '.a{}');
    expect(html).toContain('<!doctype html>');
    const doc = parse(html);
    expect(doc.querySelector('style[data-preview-css]')?.parentElement?.tagName).toBe('HEAD');
    expect(doc.body.textContent).toContain('X');
  });

  it('strips the external stylesheet <link> (CSS is inlined; the link would 404 in the viewer)', () => {
    const html = assemblePreviewDocument(
      '<html><head><link rel="stylesheet" href="css/110024.css" /></head><body>x</body></html>',
      '.a{color:red}',
    );
    const doc = parse(html);
    // 除去しているのは後段の正規表現ではなくサニタイザの許可リスト(+ 構造の上での二重化)。
    expect(doc.querySelectorAll('link')).toHaveLength(0);
    expect(html).not.toContain('css/110024.css');
    expect(doc.querySelector('style[data-preview-css]')?.textContent).toMatch(/color:\s*red/);
  });

  it('strips a stylesheet link regardless of attribute order or quoting', () => {
    const html = assemblePreviewDocument(
      `<head><link href='a.css' rel=stylesheet></head><body>y</body>`,
      '.a{}',
    );
    expect(parse(html).querySelectorAll('link')).toHaveLength(0);
    expect(html).not.toContain('a.css');
  });

  // テンプレの JS は正当なコンテンツなのでプレビューも PDF も **script は残す**
  // (承認者は JS が効いた実行結果を見て承認する)。プレビューの隔離は除去ではなく
  // opaque オリジンの iframe(`PreviewPanel.vue` + `server/src/vivliostyle/previewHost.ts`)で
  // 行う。ここで固定するのは「script 以外の能動コンテンツは今も落ちている」ことである —
  // `on*` ハンドラと `javascript:` URL は生成時の照合(`security/templateScripts.ts`)を
  // 経ていない実行面で、隔離の有無に関わらず通してはならない。
  it('script は残し、on* ハンドラと javascript: URL は落とす', () => {
    const html = assemblePreviewDocument(
      '<html><head></head><body>' +
        '<h1>レポート</h1>' +
        '<script>window.__xss=1</script>' +
        '<img src="x" onerror="window.__xss=2">' +
        '<a href="javascript:alert(1)">link</a>' +
        '<div style="margin-top:10mm">本文 X</div>' +
        '</body></html>',
      '.a{color:red}',
    );
    const doc = parse(html);
    expect(doc.querySelectorAll('script')).toHaveLength(1);
    expect(doc.querySelector('script')?.textContent).toContain('window.__xss=1');
    expectNoEventHandlers(doc);
    expect(doc.querySelector('a')?.getAttribute('href')).toBeNull();
    // 体裁・内容は保持
    expect(doc.body.textContent).toContain('レポート');
    expect(doc.querySelector('div')?.getAttribute('style')).toContain('margin-top:10mm');
    expect(doc.querySelector('style[data-preview-css]')?.textContent).toMatch(/color:\s*red/);
    expect(doc.body.textContent).toContain('X');
  });
});

// ここが本丸。旧実装はサニタイズ**後**の文字列へ `<link…>` 除去と `</head>` 挿入を正規表現で
// 当てていたため、属性値に置いた字面がタグ終端を食って `on*` が live な属性として復活した。
// 以下はすべて「その迂回入力で失敗すること」を主張する。
describe('assemblePreviewDocument — サニタイズ後の復活を許さない', () => {
  it('属性値に埋めた <link rel=stylesheet> の字面で on* が復活しない', () => {
    // 旧実装: `[^>]*` が `>` を越えないぶん <img> 自身のタグ終端を食い、
    // 残った `Z" onerror=alert(1)` が属性トークン列として再解釈された。
    // `src` は 404 を返すパスなので、復活すればユーザー操作ゼロで発火する。
    const evil = '<img src="/nope.png" alt="<link rel=stylesheet">Z" onerror=alert(1) <b>t</b>';
    const doc = parse(assemblePreviewDocument(evil, '.a{}'));
    expectNoEventHandlers(doc);
    expect(doc.querySelectorAll('[onerror]')).toHaveLength(0);
  });

  it('属性値に埋めた </head> の字面で <style> が属性の内側へ落ちない', () => {
    // 旧実装: `</head>` の初出が属性値の中だと、信頼済みの <style> がその属性値へ落ち、
    // CSS の字面(`" onload=…`)が属性トークン列として再解釈された。
    const evil = '<html><head><title data-x="</head>">t</title></head><body>b</body></html>';
    const doc = parse(assemblePreviewDocument(evil, 'body{}" onload=alert(1) x="'));
    const style = doc.querySelector('style[data-preview-css]');
    expect(style?.parentElement?.tagName).toBe('HEAD');
    expectNoEventHandlers(doc);
  });

  it('CSS の </style> 中和が DOM 経路でも効いている', () => {
    // 直列化器は raw text をエスケープしないので、DOM で組んでも中和は必須。
    const doc = parse(
      assemblePreviewDocument('<p>x</p>', '}</style><script>alert(1)</script><style>{'),
    );
    expect(doc.querySelectorAll('script')).toHaveLength(0);
    expect(doc.querySelectorAll('style')).toHaveLength(1);
  });

  it('extraCss は本文 CSS の後ろへ足される(後勝ちの順序)', () => {
    const doc = parse(
      assemblePreviewDocument('<p>x</p>', '.a{}', { extraCss: '@page{marks:crop}' }),
    );
    const styles = Array.from(doc.querySelectorAll('head style'));
    expect(styles).toHaveLength(2);
    expect(styles[0].hasAttribute('data-preview-css')).toBe(true);
    expect(styles[1].hasAttribute('data-extra-css')).toBe(true);
  });

  it('組み立て済み文書を再度通しても構造が壊れない(filledHtml 経由の再入)', () => {
    const once = assemblePreviewDocument('<p>x</p>', '.a{color:red}');
    const twice = assemblePreviewDocument(once, '.b{color:blue}');
    const doc = parse(twice);
    expect(doc.querySelectorAll('style[data-preview-css]')).toHaveLength(2);
    expect(doc.body.textContent).toContain('x');
    expectNoEventHandlers(doc);
  });
});
