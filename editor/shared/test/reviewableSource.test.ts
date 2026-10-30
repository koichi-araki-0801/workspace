// =============================================================================
// reviewableSource.test.ts — 作成経路の受付で、承認画面と本番で読みが割れる原文を見つける
// =============================================================================
// 制約 1〜4・6(設計書の追補 改訂 3)。承認画面に出ず本番だけに出る形の回帰は、受付の全体を通す
// server の `reviewableForms.test.ts` が持つ。ここは制約ごとの判定と、fixture・パーツが通ることを固定する。
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  findReviewableIssues,
  headFixedSources,
  type ReviewableIssueCode,
  reviewableIssueMessage,
  stripLeadingBom,
} from '../src/jinja/reviewableSource';

const P = '<section data-part-id="s">本文 {{ fund.name }}</section>';
const doc = (body: string, head = '<title>{{ fund.name }} レポート</title>') =>
  `<!doctype html><html><head>${head}</head><body>${body}</body></html>`;
const codes = (src: string, document = false) =>
  findReviewableIssues(src, { document }).map((i) => i.code);

describe('制約 1: Jinja のトークンは地の文で、読みかけの区切りが無い位置にだけ置く', () => {
  it.each([
    ['<! の途中', '<!{% if false %}-- {% endif %}><p>x</p>'],
    ['<!- の途中', '<!-{% if false %}-{% endif %}<p>x</p>-->'],
    ['コメントの中', '<!-- x --{% if false %}x{% endif %}><p>x</p>'],
    ['コメントの中の Jinja コメント', '<!-- x --{# c #}\n><p>x</p><!-- -->'],
    ['コメントの中の set', '<!-- x --{% set a = 1 %}\n><p>x</p><!-- -->'],
    ['コメントの中の raw', '<!-- {% raw %}{% endraw %} --><p>x</p>'],
    ['< の直後', '<{% if true %}p{% endif %}>x</p>'],
    ['<? の途中', '{% if false %}<?{% endif %}x>'],
    ['</ の途中', '</{% if true %}p{% endif %}>'],
    ['タグ名の途中', '<p{% if a %}x{% endif %}>x</p>'],
    ['属性の位置の文', '<p {% if a %}class="a"{% endif %}>x</p>'],
    ['引用符の無い属性値の式', '<p title={{ x }}>x</p>'],
    ['引用符の無い属性値の文', '<p title={% if false %}"{% endif %}>x</p>'],
    ['引用符付きの属性値の中の文', '<p title="{% if a %}x{% endif %}">x</p>'],
    ['style の中の式', '<style>.a{width:{{ w }}px}</style>'],
    ['script の中の式', '<script>var a = {{ x }};</script>'],
    ['RCDATA の閉じタグの読みかけの後の式', '<title>t</ti{{ x }}tle>'],
  ])('%s は止める', (_label, src) => {
    expect(codes(src)).toContain('token-position');
  });

  it.each([
    ['--!> で閉じるコメント', '<!-- a --!>{{ x }}'],
    ['<!--> と <!---> のコメント', '<!-->{{ x }}<!--->{{ y }}'],
    ['- を含むコメント', '<!-- a - b -- c --->{{ x }}'],
    ['</> と </1> と <!x>', '</>{{ x }}</1>{{ y }}<!x>{{ z }}'],
    ['文字の <', 'a < b {{ x }} <1'],
    ['doctype の後', '<!DOCTYPE html>{{ x }}'],
    ['属性の色々の後', '<p a b=c d = "e" f=\'g\'/>{{ x }}<br/ >{{ y }}<i a="x"b>{{ z }}</i>'],
    ['閉じタグの属性', '</p x>{{ x }}'],
  ])('%s の後の地の文は通す', (_label, src) => {
    expect(codes(src)).toEqual([]);
  });

  it.each([
    ['--! の途中', '<!-- a --!{{ x }}>'],
    ['<!- の途中', '<!-{{ x }}->'],
    ['doctype の途中', '<!DOCTYPE {{ x }}>'],
    ['属性名の後', '<p a {{ x }}>'],
    ['= の後', '<p a={{ x }}>'],
    ['/ の後', '<br/{{ x }}>'],
  ])('%s は止める', (_label, src) => {
    expect(codes(src)).toContain('token-position');
  });

  it.each([
    ['地の文の式と文', '<p>{{ fund.name }}</p>{% if a %}<p>x</p>{% endif %}'],
    [
      '引用符付きの属性値の中の式',
      '<tr data-rank="{{ loop.index }}"><td title=\'{{ x }}\'>x</td></tr>',
    ],
    ['title の中の式', '<title>{{ fund.name }} レポート</title>'],
    ['textarea の中の式', '<textarea>{{ x }}</textarea>'],
    ['raw の中身は地の文', '{% raw %}<p>{{ x }}</p>{% endraw %}'],
    ['コメントの後', '<!-- c -->{{ x }}<!---->{{ y }}'],
  ])('%s は通す', (_label, src) => {
    expect(codes(src)).toEqual([]);
  });
});

describe('制約 2: 空白の刈り込み記号を使わない', () => {
  it.each([
    ['{%- if a %}x{% endif %}'],
    ['{% if a -%}x{% endif %}'],
    ['{{- x }}'],
    ['{{ x -}}'],
    ['{#- c #}'],
    ['{# c -#}'],
    ['{%+ if a %}x{% endif %}'],
    ['{% if a +%}x{% endif %}'],
  ])('%s は止める', (src) => {
    expect(codes(src)).toContain('trim-marker');
  });
});

describe('制約 3: raw text・RCDATA の中身に < を置かない。CDATA・plaintext・svg / math の中の script', () => {
  it.each([
    ['style', '<style>a{}<!--</style>'],
    ['title', '<title><b>t</b></title>'],
    ['textarea', '<textarea><!--</textarea>'],
    ['noscript', '<noscript><!--</noscript><p>x</p>-->'],
    ['iframe', '<iframe><p>x</p></iframe>'],
    ['xmp', '<xmp><p>x</p></xmp>'],
    ['noembed', '<noembed><p>x</p></noembed>'],
    ['noframes', '<noframes><p>x</p></noframes>'],
    ['svg の中の style', '<svg><style><!--</style></svg><p>x</p><!-- -->'],
  ])('%s の中の < は止める', (_label, src) => {
    expect(codes(src)).toContain('raw-markup');
  });

  it('閉じの無い raw text も、中身の < で止める', () => {
    expect(codes('<style>a{}<p>x</p>')).toContain('raw-markup');
  });

  it.each([['<![CDATA[ x ]]>'], ['<svg><desc><![CDATA[ x > ]]></desc></svg>'], ['<plaintext>x']])(
    '%s は止める',
    (src) => {
      expect(codes(src)).toContain('cdata-plaintext');
    },
  );

  it.each([
    ['svg の中', '<svg><script>x()</script></svg>'],
    ['math の中', '<math><script>x()</script></math>'],
    [
      '分岐の片側で開いた svg の後',
      '{% if false %}<svg>{% endif %}<script>/*<!--*/</script>{% if false %}</svg>{% endif %}',
    ],
    ['閉じない svg の後', '<svg><rect/><script>x()</script>'],
  ])('script を %s に置くと止める', (_label, src) => {
    expect(codes(src)).toContain('foreign-script');
  });

  it.each([
    ['script の中身の <', '<script>if (a < b) {}</script>'],
    ['Jinja のトークンの中の <', '<title>{{ a < b }}</title>'],
    ['閉じた svg の後の script', '<svg><rect/></svg><script>x()</script>'],
    ['自分で閉じた svg', '<svg/><script>x()</script>'],
  ])('%s は通す', (_label, src) => {
    expect(codes(src)).toEqual([]);
  });
});

describe('制約 4: 分岐・反復の中で set しない', () => {
  it.each([
    ['if の中', '{% if a %}{% set t = "x" %}{% endif %}'],
    ['else の中', '{% if a %}x{% else %}{% set t = "x" %}{% endif %}'],
    ['for の中', '{% for r in rs %}{% set t = r %}{% endfor %}'],
    ['for の else の中', '{% for r in rs %}x{% else %}{% set t = 1 %}{% endfor %}'],
    ['属性への代入', '{% set ns = namespace(v=1) %}{% if a %}{% set ns.v = 2 %}{% endif %}'],
    ['ブロックの set', '{% if a %}{% set t %}x{% endset %}{% endif %}'],
  ])('%s は止める', (_label, src) => {
    expect(codes(src)).toContain('set-in-branch');
  });

  it('分岐の外の set は通す', () => {
    expect(codes('{% set t = fund.name %}{% if a %}{{ t }}{% endif %}')).toEqual([]);
  });
});

describe('制約 6: 本文の外を置かない(文書だけ)', () => {
  it('骨格の整った文書は通す', () => {
    expect(codes(doc(P), true)).toEqual([]);
    expect(codes(`\n<!-- c -->\n${doc(P)}\n<!-- c -->\n`, true)).toEqual([]);
  });

  it.each([
    ['head の中の本文', doc(P, '<p>本番だけ</p>')],
    ['</head> と <body> の間', `<html><head></head><p>本番だけ</p><body>${P}</body></html>`],
    ['</body> の後', `<html><head></head><body>${P}</body><p>本番だけ</p></html>`],
    ['</html> の後', `<html><head></head><body>${P}</body></html><p>本番だけ</p>`],
    ['<html> の前', `<p>本番だけ</p><html><head></head><body>${P}</body></html>`],
    ['本文の中の <body>', doc(`<!--><body><p>本番だけ</p><!-- --><body>${P}`)],
    ['本文の中の </body>', doc(`${P}</body><p>本番だけ</p>`)],
    ['本文の中の <head>', doc(`<head></head>${P}`)],
    ['head の中の差し込み', doc(P, '{{ fund.name }}')],
    ['body の外の差し込み', `<html><head></head><body>${P}</body>{{ x }}</html>`],
    ['html が無い', `<head></head><body>${P}</body>`],
    ['body が無い', '<html><head></head></html>'],
  ])('%s は止める', (_label, src) => {
    expect(codes(src, true)).toContain('skeleton');
  });

  it('パーツの断片には骨格の検査を掛けない', () => {
    expect(codes(P, false)).toEqual([]);
  });

  it('head に置けるのは title・meta・link・style・script・base', () => {
    const head =
      '<meta charset="utf-8"><title>t</title><link rel="stylesheet" href="a.css">' +
      '<style>.a{}</style><script src="a.js"></script><base href="/">';
    expect(codes(doc(P, head), true)).toEqual([]);
  });

  it('headFixedSources は head の meta・title・style・link の原文を並びのまま返す', () => {
    const head =
      '<meta charset="utf-8"><title>{{ fund.name }}</title><link href="a.css"><style>.a{}</style>';
    expect(headFixedSources(doc(P, head))).toEqual([
      '<meta charset="utf-8">',
      '<title>{{ fund.name }}</title>',
      '<link href="a.css">',
      '<style>.a{}</style>',
    ]);
    expect(headFixedSources(`<p>${P}</p>`)).toEqual([]);
  });
});

describe('制御文字', () => {
  it.each([
    ['ESC', '\x1b'],
    ['NUL', '\x00'],
    ['VT', '\x0b'],
    ['US', '\x1f'],
  ])('%s は止める(文字コードの切り替えで本番だけ読みが変わる)', (_label, c) => {
    expect(codes(`<p>a${c}b</p>`)).toContain('control-char');
    expect(codes(`{# ${c} #}<p>x</p>`)).toContain('control-char');
  });
  it('TAB・LF・CR・FF は通す', () => {
    expect(codes('<p>a\tb\nc\rd\fe</p>')).toEqual([]);
  });
});

describe('BOM と文言', () => {
  it('先頭の BOM を 1 文字だけ外す', () => {
    expect(stripLeadingBom('\uFEFF\uFEFFx')).toBe('\uFEFFx');
    expect(stripLeadingBom('x')).toBe('x');
  });

  it('位置を返し、どの種類にも文言がある', () => {
    const src = '<p>x</p><!-- {{ x }} -->';
    expect(findReviewableIssues(src, { document: false })).toEqual([
      { code: 'token-position', at: src.indexOf('{{') },
    ]);
    const all: ReviewableIssueCode[] = [
      'token-position',
      'trim-marker',
      'raw-markup',
      'cdata-plaintext',
      'foreign-script',
      'set-in-branch',
      'skeleton',
      'control-char',
    ];
    for (const c of all) expect(reviewableIssueMessage(c).length).toBeGreaterThan(10);
  });

  it('Jinja として読めない原文は空を返す(受付の描画が理由を返す)', () => {
    expect(codes('{% if a %}')).toEqual([]);
    expect(codes('{{ x ')).toEqual([]);
  });
});

describe('fixture のテンプレート 8 本・パーツ 29 件は通る', () => {
  const root = path.resolve(__dirname, '../../fixtures');
  const templates = fs.readdirSync(path.join(root, 'templates')).filter((f) => f.endsWith('.html'));
  const parts = JSON.parse(fs.readFileSync(path.join(root, 'parts.json'), 'utf8')) as {
    id: string;
    content: string;
  }[];
  it('件数', () => {
    expect(templates).toHaveLength(8);
    expect(parts).toHaveLength(29);
  });
  it.each(templates)('%s', (f) => {
    const src = fs.readFileSync(path.join(root, 'templates', f), 'utf8');
    expect(findReviewableIssues(stripLeadingBom(src), { document: true })).toEqual([]);
  });
  it.each(parts.map((p) => [p.id, p.content]))('パーツ %s', (_id, content) => {
    expect(findReviewableIssues(content, { document: false })).toEqual([]);
  });
});
