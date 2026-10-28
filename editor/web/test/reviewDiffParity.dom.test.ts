// =============================================================================
// reviewDiffParity.dom.test.ts — 承認の差分の linkedom と DOMParser のパリティ
// =============================================================================
// 承認画面の差分は Worker(linkedom)で作り、Worker が落ちるとメインスレッドの `DOMParser` へ
// 倒れる。edit 申請の最終確定はサーバで linkedom の差分を作り、画面で付けた判定(partKey)を当てる。
// 2 つのパーサで partKey・状態・判定を当てた候補がずれると、画面で判定し終えた申請をサーバが
// 400 で止める。ここでは一致すべき入力の一致と、崩れた markup で食い違う形を固定する。

import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import {
  buildHtmlDiff,
  buildReviewedHtmlCandidate,
  type CreateReviewPartDecision,
  type HtmlDiff,
} from '@editor/shared';
import { describe, expect, it } from 'vitest';
import { defaultHtmlParser } from '@/lib/htmlParser';
import { linkedomParser } from '@/workers/htmlWorkerImpl';

/**
 * 直列化だけの差を消す。linkedom は表の暗黙の `<tbody>` を補わず(`htmlWorkerImpl.dom.test.ts` と
 * 同じ正規化)、SVG の空要素を `<line … />` と書く(DOMParser は `<line …></line>`)。候補は画面の
 * 表示にだけ使い、確定の書込は原文を切り貼りするので、この差は確定に影響しない。
 */
const normalize = (h: string) =>
  h.replace(/<\/?tbody>/gi, '').replace(/<([a-zA-Z][\w:-]*)([^<>]*?)\s*\/>/g, '<$1$2></$1>');

/** 確定の検査が見る形: ページごとの partKey と状態、全部承認・全部却下の候補。 */
function signature(diff: HtmlDiff) {
  const blocks = diff.pages.flatMap((p) => p.blocks);
  const all = (status: CreateReviewPartDecision['status']) =>
    blocks.filter((b) => b.status !== 'same').map((b) => ({ partKey: b.partKey, status }));
  return {
    pages: diff.pages.map((p) => p.blocks.map((b) => `${b.partKey}:${b.status}`)),
    afterPageCount: diff.afterPageCount,
    truncated: diff.truncated,
    approved: normalize(buildReviewedHtmlCandidate(diff, all('approved')).html),
    rejected: normalize(buildReviewedHtmlCandidate(diff, all('rejected')).html),
  };
}

const both = (before: string, after: string) => ({
  linkedom: signature(buildHtmlDiff(before, after, linkedomParser)),
  dom: signature(buildHtmlDiff(before, after, defaultHtmlParser)),
});

/**
 * テスト用 fixtures(`editor/fixtures/filled/`)の値入り HTML を、ファイル名 → 本文で読む。承認の差分が
 * 比べるのは値入り HTML なので、生 Jinja(`templates/`。表の中の `{% for %}` は DOMParser が表の外へ
 * 追い出す)は対象にしない。
 */
const FILLED = path.resolve(__dirname, '../../fixtures/filled');
const fixtureFilled: Record<string, string> = Object.fromEntries(
  readdirSync(FILLED)
    .filter((n) => n.endsWith('.html'))
    .map((n) => [n, readFileSync(path.join(FILLED, n), 'utf8')]),
);

const doc = (body: string) =>
  `<!doctype html><html><head><title>t</title></head><body>\n${body}\n</body></html>`;
const BREAK = '<div class="pagebreak"></div>';

describe('fixtures のテンプレ一式', () => {
  const fixtures = fixtureFilled;
  const names = Object.keys(fixtures);

  it('fixtures がある', () => {
    expect(names.length).toBeGreaterThan(0);
  });

  it.each(names)('%s: 新規(白紙から)と無変更で partKey・状態・候補が一致する', (name) => {
    const html = fixtures[name];
    const fresh = both('', html);
    expect(fresh.linkedom).toEqual(fresh.dom);
    const same = both(html, html);
    expect(same.linkedom).toEqual(same.dom);
  });
});

describe('改ページ・付き従う要素・同じアンカー', () => {
  const cases: Array<[string, string, string]> = [
    [
      '改ページの追加',
      doc('<section id="a">A</section>\n<section id="b">B</section>'),
      doc(`<section id="a">A</section>\n${BREAK}\n<section id="b">B 改</section>`),
    ],
    [
      '改ページの削除',
      doc(`<section id="a">A</section>\n${BREAK}\n<section id="b">B</section>`),
      doc('<section id="a">A</section>\n<section id="b">B 改</section>'),
    ],
    [
      '白紙のページ(区切りの連続)',
      doc(`<p>1</p>\n${BREAK}\n${BREAK}\n<p>3</p>`),
      doc(`<p>1 改</p>\n${BREAK}\n${BREAK}\n<p>3</p>\n<p>4</p>`),
    ],
    [
      '本文直下の style と地の文',
      doc('<style>.a{color:red}</style>\n地の文 旧\n<p class="a">本文</p>'),
      doc('<style>.a{color:blue}</style>\n地の文 新\n<p class="a">本文</p>'),
    ],
    [
      '同じアンカーが複数ページにある',
      doc(`<p class="row">1</p>\n<p class="row">2</p>\n${BREAK}\n<p class="row">3</p>`),
      doc(`<p class="row">1</p>\n${BREAK}\n<p class="row">2 改</p>\n<p class="row">3</p>`),
    ],
    [
      'inline の改ページ指定',
      doc('<p>1</p>\n<p style="break-before:page">2</p>'),
      doc('<p>1</p>\n<p style="break-before:page">2 改</p>\n<p style="break-after:page">3</p>'),
    ],
  ];

  it.each(cases)('%s: partKey・状態・候補が一致する', (_name, before, after) => {
    const r = both(before, after);
    expect(r.linkedom).toEqual(r.dom);
  });
});

describe('崩れた markup(パーサで木が変わる入力)の振る舞い', () => {
  it('表の地の文(foster parenting): DOMParser は表の前へ出し、linkedom は表に残す', () => {
    const before = doc('<table>注記 旧<tr><td>1</td></tr></table>');
    const after = doc('<table>注記 新<tr><td>1</td></tr></table>');
    const r = both(before, after);
    expect(r.dom.pages).toEqual([['#text#1:changed', 'table#1:same']]);
    expect(r.linkedom.pages).toEqual([['table#1:changed']]);
  });

  it('`<p>` の入れ子: どちらも内側の `<p>` で外側を閉じ、閉じ忘れの `</p>` から空の `<p>` を作る', () => {
    const before = doc('<p class="o">外<p class="i">内 旧</p></p>');
    const after = doc('<p class="o">外<p class="i">内 新</p></p>');
    const r = both(before, after);
    expect(r.linkedom).toEqual(r.dom);
    expect(r.dom.pages).toEqual([['.o#1:same', '.i#1:changed', 'p#1:same']]);
  });

  it('閉じ忘れの `<div>`: どちらも本文の終わりまでを 1 つのパーツにする', () => {
    const before = doc('<div class="box"><p>旧</p>\n<p>続き</p>');
    const after = doc('<div class="box"><p>新</p>\n<p>続き</p>');
    const r = both(before, after);
    expect(r.linkedom).toEqual(r.dom);
    expect(r.dom.pages).toEqual([['.box#1:changed']]);
  });
});
