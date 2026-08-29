// =============================================================================
// inlineCss.test.ts — CSS の inline 展開が「タグの境界」を誤らないことのガード
// =============================================================================
// この関数の入力は `/api/build`・`/api/build/merge`・`/api/preview` のリクエスト本文
// そのもので、出力は **CSP の無い headless ブラウザ**が開く。`<link` から次の
// `>` までを 1 タグとみなす切り出しでは、属性値の中から始まった span がその要素のタグ終端を
// 食い、除去後に残ったテキストが属性トークン列として再解釈される。以下は「その迂回入力で
// 失敗すること」を主張する。
import { describe, expect, it } from 'vitest';
import { inlineCss, scanTags } from '../src/vivliostyle/inlineCss.js';

/** 出力を素朴に読み直して、属性として live な `on*` が生えていないかを見る。 */
function eventHandlerNames(html: string): string[] {
  const out: string[] = [];
  for (const tag of scanTags(html).tags) {
    for (const m of tag.raw.matchAll(/[\s"'](on[a-z]+)\s*=/gi)) out.push(m[1].toLowerCase());
  }
  return out;
}

describe('scanTags', () => {
  it('属性値の中の `<` や `>` をタグと誤認しない', () => {
    const { tags, ok } = scanTags('<img alt="<link rel=stylesheet>" title="a > b"><p>x</p>');
    expect(ok).toBe(true);
    expect(tags.map((t) => `${t.isEnd ? '/' : ''}${t.name}`)).toEqual(['img', 'p', '/p']);
  });

  it('raw text 要素の中身をマークアップとして読まない', () => {
    const { tags, ok } = scanTags('<head><script>var s = "</head><b>";</script></head>');
    expect(ok).toBe(true);
    // `</head>` は script の raw text の一部。本物の終了タグは末尾の 1 つだけ。
    expect(tags.filter((t) => t.isEnd && t.name === 'head')).toHaveLength(1);
    expect(tags.some((t) => t.name === 'b')).toBe(false);
  });

  it('コメントの中身をタグとして拾わない', () => {
    const { tags, ok } = scanTags('<!-- <link rel=stylesheet> --><p>x</p>');
    expect(ok).toBe(true);
    expect(tags.map((t) => t.name)).toEqual(['p', 'p']);
  });

  it('閉じないタグ・コメント・raw text では ok:false を返す(fail closed)', () => {
    expect(scanTags('<p class="a').ok).toBe(false);
    expect(scanTags('<!-- unterminated').ok).toBe(false);
    expect(scanTags('<script>never closed').ok).toBe(false);
    expect(scanTags('<!doctype html').ok).toBe(false); // bogus comment が閉じない
    expect(scanTags('<?xml version="1.0"').ok).toBe(false);
    expect(scanTags('</ never closed').ok).toBe(false); // `</` + 非英字 = bogus comment
  });

  it('タグでない `<` と bogus comment を読み飛ばす', () => {
    // `a < b` の `<` はテキスト。`</3>` は bogus comment。`<?…>` は処理命令風の bogus。
    const { tags, ok } = scanTags('<!doctype html><?xml?>a < b</3><p>x</p>');
    expect(ok).toBe(true);
    expect(tags.map((t) => t.name)).toEqual(['p', 'p']);
  });

  it('raw text の終了タグは名前の直後が空白 / `/` / `>` のときだけ終端になる', () => {
    // `</styles>` は `</style` に前方一致するが、直後が `s` なので終端ではない。
    const { tags, ok } = scanTags('<style>a{}</styles>b{}</style><p>x</p>');
    expect(ok).toBe(true);
    expect(tags.map((t) => `${t.isEnd ? '/' : ''}${t.name}`)).toEqual([
      'style',
      '/style',
      'p',
      '/p',
    ]);
  });
});

describe('inlineCss', () => {
  it('injects a style tag before </head> and drops links with no served asset', () => {
    const html = '<html><head><link rel="stylesheet" href="a.css"></head><body>x</body></html>';
    const out = inlineCss(html, 'p{color:red}');
    expect(out).toContain('<style>\np{color:red}\n</style></head>');
    // 配信ルートに `a.css` を置いていないので落ちる(404 は組版のページ分割を止める)。
    expect(out).not.toContain('<link');
  });

  // `css` は `/api/build`・`/api/build/merge`・`/api/preview`(inline)のリクエスト本文
  // そのもの。`<style>` は raw text 要素なので、`</style>` を書かれると要素が閉じて
  // 続きが HTML として解釈される。PDF build 経路には CSP が無く、ここが唯一の防壁。
  it('neutralises a </style> escape in user css (head / body / wrapper paths)', () => {
    const evil = '}</style><script>fetch("/api/review-requests")</script><style>{';
    for (const html of ['<html><head></head><body>x</body></html>', '<body>x</body>', '<p>x</p>']) {
      const out = inlineCss(html, evil);
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

  it('returns html unchanged when css is empty and there is nothing to strip', () => {
    expect(inlineCss('<html><head></head><body>x</body></html>', '')).toBe(
      '<html><head></head><body>x</body></html>',
    );
  });

  // 判断を rel の値には委ねない。判断するのは「配信ルートに実体があるか」で、`<base>` と
  // `<meta http-equiv>` だけが値によらず落ちる(前者は相対解決先を丸ごと動かせ、後者は
  // 宣言的リフレッシュで遷移する = 相対参照を許す設計の前提そのものを壊す)。
  it('drops unresolvable refs and always drops base / meta[http-equiv]', () => {
    const html =
      '<head><link rel="icon" href="i.png">' +
      "<link rel=stylesheet href='a.css'>" +
      '<base href="http://evil.example/">' +
      '<meta http-equiv="refresh" content="0;url=http://evil.example/">' +
      '<meta charset="utf-8">' +
      '<linkish rel="stylesheet"></head><body>x</body>';
    const out = inlineCss(html, '');
    // 字面ではなく「要素として残っているか」で見る(`<linkish>` は `<link` を字面に含む)。
    const names = scanTags(out).tags.map((t) => t.name);
    expect(names).not.toContain('link');
    expect(names).not.toContain('base');
    expect(out).not.toContain('http-equiv');
    // 名前が `link` で始まるだけの要素と、取得を伴わない `<meta charset>` は残す。
    expect(out).toContain('<linkish rel="stylesheet">');
    expect(out).toContain('<meta charset="utf-8">');
  });

  // ── 同梱資産への相対参照(テンプレの必須要件)──
  // テンプレは per-fund CSS・共通フォント・テンプレ JS を相対パスで参照し、実体は
  // `docAssets.stageDocAssets` が配信ルートへ置く。**置いたものは残さねばならない** —
  // ここが落ちると CSS が当たらず JS も動かない。
  describe('servedAssets', () => {
    const served = new Set(['css/510037.css', 'js/column-width.js', 'fonts/BIZUD.woff2']);

    it('配信ルートに実体のある <link> と <script src> は残す(リクエスト CSS が無い場合)', () => {
      const html =
        '<html><head><link rel="stylesheet" href="css/510037.css">' +
        '<script src="js/column-width.js"></script></head><body>x</body></html>';
      const out = inlineCss(html, '', { servedAssets: served });
      expect(out).toContain('<link rel="stylesheet" href="css/510037.css">');
      expect(out).toContain('<script src="js/column-width.js">');
    });

    // ── CSS の適用元は 1 つ ──
    // リクエストが `css` を持つとき、それが唯一の源である。`<link>` を残すと同じ per-fund
    // CSS が 2 重に当たり、しかも**ディスク側が先・リクエスト側が後**になるので、下書きで
    // 「削除」した規則がディスクの旧 CSS から復活する(後勝ちでは削除を上書きできない)。
    // プレビュー(`web/src/lib/nunjucksRender.ts`)は `<link>` を落とすので、残すと
    // プレビューと PDF で当たる CSS が食い違う。
    it('リクエスト CSS があるとき stylesheet の <link> は落とす(2 重適用を作らない)', () => {
      const html =
        '<html><head><link rel="stylesheet" href="css/510037.css">' +
        '</head><body>x</body></html>';
      const out = inlineCss(html, 'p{color:red}', { servedAssets: served });
      expect(out).not.toContain('<link');
      expect(out).toContain('p{color:red}');
    });

    it('rel が stylesheet でない <link>(preload 等)はリクエスト CSS があっても残す', () => {
      const html =
        '<html><head><link rel="preload" as="font" href="fonts/BIZUD.woff2">' +
        '</head><body>x</body></html>';
      const out = inlineCss(html, 'p{}', { servedAssets: served });
      expect(out).toContain('<link rel="preload"');
    });

    it('大小文字混じり・複数値の rel でも stylesheet として落とす', () => {
      const html = '<head><link REL="Alternate StyleSheet" href="css/510037.css"></head>';
      expect(inlineCss(html, 'p{}', { servedAssets: served })).not.toContain('<link');
    });

    it('リクエスト CSS があっても <script src> は残す(テンプレ JS は CSS と無関係)', () => {
      const html = '<head><script src="js/column-width.js"></script></head>';
      const out = inlineCss(html, 'p{}', { servedAssets: served });
      expect(out).toContain('<script src="js/column-width.js">');
    });

    it('`./` 付きやクエリ付きの相対参照も同じ資産として解決する', () => {
      const html = '<head><link rel="stylesheet" href="./css/510037.css?v=3"></head>';
      const out = inlineCss(html, '', { servedAssets: served });
      expect(out).toContain('<link');
    });

    it('実体の無い相対参照は落とす(404 は組版のページ分割を止める)', () => {
      const html = '<head><link rel="stylesheet" href="css/999999.css">' + '</head>';
      expect(inlineCss(html, '', { servedAssets: served })).not.toContain('<link');
    });

    it.each([
      'https://evil.example/x.js',
      '//evil.example/x.js',
      '/css/510037.css',
      '../../css/510037.css',
    ])('配信ルート配下へ解決できない src(%s)は残さない', (src) => {
      const html = `<head><script src="${src}"></script></head>`;
      const out = inlineCss(html, '', { servedAssets: served });
      expect(scanTags(out).tags.map((t) => t.name)).not.toContain('script');
    });

    it('落とす <script> は中身と終了タグごと落とす(中身が live なマークアップへ戻らない)', () => {
      const html =
        '<head><script src="missing.js"><img src=x onerror=alert(1)></scr' + 'ipt></head>';
      const out = inlineCss(html, '', { servedAssets: served });
      expect(out).not.toContain('onerror');
      expect(out).not.toContain('</scr' + 'ipt>');
    });

    it('インライン <script>(src なし)は資産の有無によらず残す = テンプレ JS 本体', () => {
      const html = '<head><script>document.title="a"</scr' + 'ipt></head>';
      for (const opts of [{}, { servedAssets: served }]) {
        const out = inlineCss(html, '', opts);
        expect(out).toContain('document.title="a"');
        expect(scanTags(out).tags.map((t) => t.name)).toContain('script');
      }
    });

    it('資産があっても <base> は落ちる(相対解決先を動かせるため)', () => {
      const out = inlineCss('<head><base href="css/"></head>', '', { servedAssets: served });
      expect(scanTags(out).tags.map((t) => t.name)).not.toContain('base');
    });
  });

  // タグ名直後の `/` は self-closing 開始タグ状態を経て before-attribute-name へ**再消費**されるので、
  // `<meta/http-equiv=refresh>` は正当に http-equiv 属性を持つ(Chromium で実際に遷移する)。
  // 属性の有無を `raw` への正規表現(`/[\s"']http-equiv=/`)で嘆ぎ分けるとここが穴になる。
  it.each([
    '<meta/http-equiv="refresh" content="0;url=http://evil.example/">',
    '<meta	http-equiv=refresh content=0;url=http://evil.example/>',
    '<meta//http-equiv = refresh content=x>',
    '<META HTTP-EQUIV=refresh content=x>',
  ])('drops %s (attribute names come from the scanner, not a regex sniff)', (tag) => {
    const out = inlineCss(`<head>${tag}</head><body>x</body>`, '');
    expect(out.toLowerCase()).not.toContain('http-equiv');
  });

  it('keeps meta elements that have no http-equiv attribute', () => {
    const out = inlineCss('<head><meta name="x" content="http-equiv=refresh"></head>', '');
    expect(out).toContain('<meta name="x" content="http-equiv=refresh">');
  });

  // `scanTags` は raw text 要素の中身を `rawText` で返す(外部参照検査が使う)。
  it('exposes raw text content and attribute names on tag spans', () => {
    const scan = scanTags(
      '<style media="print">.a{color:red}</style><div class="x" data-y>z</div>',
    );
    expect(scan.ok).toBe(true);
    const style = scan.tags.find((t) => t.name === 'style' && !t.isEnd);
    expect(style?.rawText).toBe('.a{color:red}');
    expect(style?.attrNames).toEqual(['media']);
    expect(style?.attrs).toEqual([{ name: 'media', value: 'print' }]);
    const div = scan.tags.find((t) => t.name === 'div' && !t.isEnd);
    expect(div?.attrNames).toEqual(['class', 'data-y']);
    expect(div?.attrs).toEqual([
      { name: 'class', value: 'x' },
      { name: 'data-y', value: '' },
    ]);
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

  // 二次バックトラックの回帰テスト: `>` を一切含まない入力は、素朴な切り出しだと `<link` の
  // 出現ごとに末尾まで舐め直してイベントループを塞ぐ。走査器は最初のタグで `>` を
  // 見つけられず即座に打ち切る。
  it('handles pathological link-heavy input in linear time', () => {
    const html = '<link '.repeat(200_000);
    const started = performance.now();
    expect(inlineCss(html, '')).toBe(html);
    expect(performance.now() - started).toBeLessThan(2000);
  });

  it('属性値に埋めた <link rel=stylesheet> の字面でタグ終端を食わない', () => {
    // `<link` から次の `>` までを削る形だと `<img>` のタグ終端まで消え、
    // 残った `Z" onerror=alert(1)` が属性トークン列として再解釈される。
    const html =
      '<html><head></head><body>' +
      '<img src="/nope.png" alt="<link rel=stylesheet">Z" onerror=alert(1) <b>t</b>' +
      '</body></html>';
    const out = inlineCss(html, 'p{}');
    expect(eventHandlerNames(out)).toEqual([]);
    expect(out).toContain('<img src="/nope.png" alt="<link rel=stylesheet">');
  });

  it('属性値に埋めた </head> の字面で <style> が属性の内側へ落ちない', () => {
    const html = '<html><head><title data-x="</head>">t</title></head><body>b</body></html>';
    const out = inlineCss(html, 'body{}" onload=alert(1) x="');
    expect(eventHandlerNames(out)).toEqual([]);
    // 挿入位置は本物の `</head>`(= `</title>` より後ろ)でなければならない。
    expect(out.indexOf('<style>')).toBeGreaterThan(out.indexOf('</title>'));
  });

  it('script の文字列リテラル中の </head> を挿入位置に選ばない', () => {
    const html = '<html><head><script>var s = "</head>";</script></head><body>b</body></html>';
    const out = inlineCss(html, 'p{}');
    expect(out.indexOf('<style>')).toBeGreaterThan(out.indexOf('</script>'));
  });

  it('doctype を保持する(標準モードが崩れるとページ分割が変わる)', () => {
    const out = inlineCss('<!DOCTYPE html><html><head></head><body>x</body></html>', 'p{}');
    expect(out).toMatch(/^<!DOCTYPE html>/);
  });

  it('走査が一意に決まらない入力では加工せず包むだけにする(fail closed)', () => {
    // 閉じないコメントは「以降すべてコメント」とも読めるため、除去も差し込みもしない。
    const html = '<html><head><!-- unterminated <body>x';
    const out = inlineCss(html, 'p{}');
    expect(out).toBe(`<!doctype html>\n<style>\np{}\n</style>\n${html}`);
  });
});
