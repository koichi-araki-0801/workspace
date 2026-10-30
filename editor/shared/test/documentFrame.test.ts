// =============================================================================
// documentFrame.test.ts — 本文の外側の固定と、本文の中の骨格のタグ
// =============================================================================
// 承認画面は body の中だけを見せる。本文の外側(head・html と body の開始タグ・`</body>` の後ろ)を
// 基準とバイト列で比べること、本文の中に骨格のタグを書かせないことを固定する(両経路の受付と承認)。
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  documentFrameOf,
  findDocumentFrameIssue,
  sameDocumentFrame,
} from '../src/html/documentFrame';

const BASE =
  '<!doctype html>\n<html lang="ja">\n<head>\n<meta charset="utf-8">\n<title>t</title>\n' +
  '<style>.a{}</style>\n</head>\n<body class="doc">\n<p>本文</p>\n</body>\n</html>\n';
const withBody = (body: string) => BASE.replace('<p>本文</p>', body);
const issue = (html: string, base = BASE, jinja = false, requireBody = !jinja) =>
  findDocumentFrameIssue(html, base, { jinja, requireBody })?.code ?? null;

describe('documentFrameOf: 本文の外側を取り出す', () => {
  it('先頭〜最初の <body …> の > と、最後の </body>〜末尾', () => {
    const f = documentFrameOf(BASE);
    expect(f.before.endsWith('<body class="doc">')).toBe(true);
    expect(f.after.startsWith('</body>')).toBe(true);
    expect(f.from).toBe(BASE.indexOf('<body class="doc">') + '<body class="doc">'.length);
    expect(f.to).toBe(BASE.indexOf('</body>'));
  });

  it('先頭の BOM と CRLF を揃える', () => {
    const crlf = `﻿${BASE.replace(/\n/g, '\r\n')}`;
    expect(sameDocumentFrame(crlf, BASE)).toBe(true);
    expect(issue(BASE, crlf)).toBeNull();
    expect(issue(crlf, BASE)).toBeNull();
  });

  it('body の無い断片は外側が空(本文直下の範囲と同じ規則)', () => {
    expect(documentFrameOf('<p>x</p>')).toMatchObject({ before: '', after: '', from: 0, to: 8 });
  });

  it('body の開始・終了の片方だけは境界を確かめられない', () => {
    expect(() => documentFrameOf('<html><body><p>x</p></html>')).toThrow();
    expect(() => documentFrameOf('<p>x</p></body>')).toThrow();
  });

  it('コメント・属性値・raw text の中の <body> は境界に数えない', () => {
    const f = documentFrameOf(
      '<html><head><!-- <body> --><script>"<body>"</script></head><body title="<body>"><p>x</p></body></html>',
    );
    expect(f.before.endsWith('<body title="<body>">')).toBe(true);
  });
});

describe('findDocumentFrameIssue: 本文の外側は基準と同じでなければならない', () => {
  it('本文だけの変更は通る', () => {
    expect(issue(withBody('<p>書き直した本文</p><table><tr><td>1</td></tr></table>'))).toBeNull();
  });

  it.each([
    ['head に style を足す', BASE.replace('</head>', '<style>body{display:none}</style></head>')],
    ['head の title を変える', BASE.replace('<title>t</title>', '<title>u</title>')],
    [
      'body の開始タグに style を足す',
      BASE.replace('<body class="doc">', '<body class="doc" style="x">'),
    ],
    [
      'html の開始タグに class を足す',
      BASE.replace('<html lang="ja">', '<html lang="ja" class="x">'),
    ],
    ['</head> と <body> の間に要素を置く', BASE.replace('</head>\n', '</head>\n<p>間</p>\n')],
    ['</body> の後ろに要素を置く', BASE.replace('</body>\n', '</body>\n<p>後ろ</p>\n')],
  ])('%s → frame-changed', (_, html) => {
    expect(issue(html)).toBe('frame-changed');
  });

  it.each([
    ['2 個目の <body style>', '<body style="background:red">'],
    ['<html class>', '<html class="x">'],
    ['<head>', '<head><style>p{}</style></head>'],
    ['</head>', '</head>'],
    ['</body>', '</body>'],
    ['</html>', '</html>'],
    ['大文字の <BODY>', '<BODY onload="x">'],
  ])('本文の中の %s → skeleton-in-body', (_, tag) => {
    expect(issue(withBody(`<p>a</p>${tag}<p>b</p>`))).toBe('skeleton-in-body');
  });

  it.each([
    ['<svg><style> の中の <body style>', '<svg><style><body style="display:none"></style></svg>'],
    ['<svg><title> の中の <html class>', '<svg><title><html class="x"></title></svg>'],
    [
      '<math><style> の中の <body style>',
      '<math><style><body style="display:none"></style></math>',
    ],
    ['<svg><style> の中の </body>', '<svg><style></body></style></svg>'],
  ])('外来要素の中の raw text・RCDATA に書いた骨格のタグも数える: %s', (_, tag) => {
    // 外来要素の中では style・title も普通の要素で、ブラウザは `<body>`・`<html>` で外来要素を抜けて
    // 既存の body・html へ属性を足す。
    expect(issue(withBody(`<p>a</p>${tag}<p>b</p>`))).toBe('skeleton-in-body');
    expect(issue(withBody(`<p>a</p>${tag}<p>b</p>`), BASE, true)).toBe('skeleton-in-body');
  });

  it.each([
    [
      'svg の中の foreignObject で無視される </svg>',
      '<svg><foreignObject><div></svg></div></foreignObject><title><body style="display:none"></title></svg>',
    ],
    [
      'math の中の mtext で無視される </math>',
      '<math><mtext><div></math></div></mtext><mi><style><body style="display:none"></style></mi></math>',
    ],
  ])('ブラウザが無視する閉じタグで外来要素を抜けたと読まない: %s', (_, tag) => {
    // 本文で最初に svg・math が開いた後ろの raw text・RCDATA は、すべて外来要素の中として探す
    // (止めすぎる側に倒す。字句の状態機械は HTML の木構築をしないので、どの閉じタグが効くかを追えない)。
    expect(issue(withBody(`<p>a</p>${tag}<p>b</p>`))).toBe('skeleton-in-body');
  });

  it('svg・math より前の HTML の style の中は数えない', () => {
    expect(issue(withBody('<style>/* <body> */</style><svg><rect/></svg>'))).toBeNull();
    // svg・math の後ろは、閉じた後でも外来要素の中として探す(止めすぎる側)。
    expect(issue(withBody('<svg><rect/></svg><style>/* <body> */</style>'))).toBe(
      'skeleton-in-body',
    );
  });

  // 次の raw text・RCDATA(style・textarea)は HTML の名前空間の中なので、中身はタグとして読まれない。
  it('コメント・raw text・属性値の中の骨格のタグは数えない(HTML の名前空間)', () => {
    expect(
      issue(
        withBody(
          '<!-- </body><body> --><script>var s = "</body><body style=x>";</script>' +
            '<p title="<body>">a</p><textarea><html></textarea><style>/* <head> */</style>',
        ),
      ),
    ).toBeNull();
  });

  it('Jinja のトークンの中の骨格のタグは数えない(作成経路)', () => {
    expect(issue(withBody('<p>{{ "<body>" }}</p>{# </body> #}'), BASE, true)).toBeNull();
    expect(issue(withBody('<p>{{ x }}</p><body>'), BASE, true)).toBe('skeleton-in-body');
  });

  it('編集経路(requireBody)は body の無い断片を no-body で止める', () => {
    // 断片の先頭の style・link・meta・base は DOMParser が head へ移し、紙面に出ないまま効く。
    expect(issue('<p>新しい本文</p>', '<p>既存</p>')).toBe('no-body');
    expect(issue('<style>p{display:none}</style><p>x</p>', '<p>既存</p>')).toBe('no-body');
    expect(issue('<p>a</p><html class="x"><p>b</p>', '<p>既存</p>')).toBe('no-body');
    expect(issue('<p>a</p><html class="x"><p>b</p>', '<p>既存</p>', false, false)).toBe(
      'skeleton-in-body',
    );
    // body の開始だけを足すと境界を読めない(受付は 400、承認は 409 に倒す)。
    expect(() => issue('<p>a</p><body style="x"><p>b</p>', '<p>既存</p>')).toThrow();
    // requireBody を付けなければ、body の無い断片どうしは外側が空で一致する。
    expect(issue('<p>新しい本文</p>', '<p>既存</p>', false, false)).toBeNull();
  });

  it('fixture の値入り HTML・テンプレートは自分自身を基準にして通る', () => {
    const fixtures = path.resolve(__dirname, '../../fixtures');
    let n = 0;
    for (const dir of ['templates', 'filled']) {
      for (const f of fs.readdirSync(path.join(fixtures, dir))) {
        const src = fs.readFileSync(path.join(fixtures, dir, f), 'utf8');
        expect(findDocumentFrameIssue(src, src, { jinja: dir === 'templates' }), f).toBeNull();
        n++;
      }
    }
    expect(n).toBe(16);
  });
});
