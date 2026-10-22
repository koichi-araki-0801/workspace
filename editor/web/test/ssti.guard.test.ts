// =============================================================================
// ssti.guard.test.ts — 「アプリオリジンで Jinja をコンパイルしない」ガード
// =============================================================================
// `compareService` が申請者の書いたテンプレ本文を承認者のページオリジンの
// メインスレッドで nunjucks コンパイルする形は許されない。nunjucks はサンドボックスではなく
// **コンパイラ**で、`{{ range.constructor("…")() }}` は `new Function` へ到達する。走った JS は
// 承認者のセッション(HttpOnly cookie は同一オリジン fetch へ自動で付く)のまま承認 API を
// 叩けるため、editor 1 ロールで職務分掌が破れる。
//
// 直したのは「どこでコンパイルするか」であって、入力の検査ではない。ゆえに守るべき不変則は
// 個々の入力に対する挙動ではなく**呼び出しの形**で、それはソース走査でしか固定できない:
//
//   (I)   アプリコードは `renderJinja` を import しない(定義はテストヘルパーだけ)。
//   (II)  Worker 層は Jinja 描画を持たない(Worker は**同一オリジン**で、cookie 付き fetch が
//         通る = 隔離になっていない。オフロードは隔離ではない)。
//   (III) 描画を要する 4 経路は `renderJinjaIsolated`(opaque オリジンの iframe)を通る。
//         配線が外れた瞬間にここが落ちる — 「機構はあるが繋がっていない」を許さない。
import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { renderPlainFilled } from '@editor/shared';
import { describe, expect, it } from 'vitest';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const WEB_SRC = path.resolve(HERE, '../src');
const SHARED_SRC = path.resolve(HERE, '../../shared/src');

/** `web/src` 配下の `.ts` / `.vue` を全部集める(除外リストを作らない = 見落としを作らない)。 */
function sourceFiles(dir: string): string[] {
  const found: string[] = [];
  for (const name of readdirSync(dir)) {
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) found.push(...sourceFiles(full));
    else if (/\.(ts|vue)$/.test(name)) found.push(full);
  }
  return found;
}

/**
 * コメントを落とす。禁止したいのは**コード上の形**で、理由を説明する散文まで禁じると
 * 「なぜそうしたか」を書けなくなる(コメント規約と正面から衝突する)。
 * 文字列リテラル中の `//` も巻き込むが、それで緩むのはその行だけなので許容する。
 */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
}

const ALL_SOURCES = sourceFiles(WEB_SRC);
/** 隔離を介さない描画済み HTML の組み立て口。走査が実在のファイルを読めているかの確認に使う。 */
const ASSEMBLE_HOME = path.join(WEB_SRC, 'lib/nunjucksRender.ts');

/** Jinja 描画を持ってはならない Worker 層。 */
const WORKER_FILES = [
  path.join(WEB_SRC, 'workers/index.ts'),
  path.join(WEB_SRC, 'workers/htmlWorkerImpl.ts'),
  path.join(WEB_SRC, 'workers/fallback.ts'),
];

/** 隔離描画を通さねばならない経路(承認・比較画面 + PDF 系)。 */
const ISOLATED_CALLERS = [
  path.join(WEB_SRC, 'features/compare/services/compareService.ts'),
  path.join(WEB_SRC, 'features/preview/services/templatePreviewService.ts'),
  path.join(WEB_SRC, 'lib/pdfDocument.ts'),
];

/** server からも使う値差込の描画器。web の外にあっても eval 系を持たないことを固定する。 */
const SHARED_RENDERERS = [
  path.join(SHARED_SRC, 'jinja/jinjaExpr.ts'),
  path.join(SHARED_SRC, 'jinja/fillRender.ts'),
  path.join(SHARED_SRC, 'jinja/jinjaTree.ts'),
];

describe('SSTI ガード — Jinja のコンパイルはアプリオリジンで行わない', () => {
  it('走査対象を実際に読めている(セルフテスト)', () => {
    // 収集に失敗していると以下が全部素通りして「常に緑」になる。
    expect(ALL_SOURCES.length).toBeGreaterThan(50);
    expect(ALL_SOURCES).toContain(ASSEMBLE_HOME);
    for (const file of [...WORKER_FILES, ...ISOLATED_CALLERS]) {
      expect(readFileSync(file, 'utf8').length).toBeGreaterThan(200);
    }
  });

  it('アプリコードは renderJinja を import しない', () => {
    // `import type` だけを取り出す形にはしない — 値として束縛できれば呼べてしまう。
    const offenders = ALL_SOURCES.filter((file) => {
      const code = stripComments(readFileSync(file, 'utf8'));
      return /import[^;]*\brenderJinja\b[^;]*from/.test(code);
    }).map((f) => path.relative(WEB_SRC, f));
    expect(offenders, `renderJinja を import している: ${offenders.join(', ')}`).toEqual([]);
  });

  it('アプリコードは nunjucks を直に import しない', () => {
    // 新しい描画経路が別ファイルに生えると、隔離を経ないコンパイルが静かに復活する。
    // `fillJinja.ts`(作成タブの値差込)も `jinjaExpr.ts` の許可リスト評価器で実装して
    // おり、例外は 1 つも無い。この 0 件が、全域 CSP
    // から `'unsafe-eval'` を落とせている根拠でもある(`server/src/config.ts`)。
    const offenders = ALL_SOURCES.filter((file) => {
      const code = stripComments(readFileSync(file, 'utf8'));
      return /from\s*['"]nunjucks['"]/.test(code);
    }).map((f) => path.relative(WEB_SRC, f));
    expect(offenders, `nunjucks を直接 import している: ${offenders.join(', ')}`).toEqual([]);
  });

  it('アプリコードは eval / new Function を自前で持たない', () => {
    // `'unsafe-eval'` を落とした以上、呼べば CSP 違反で必ず落ちる。落ちた結果を
    // `catch` で握られると「値が空になるだけ」で無言の退行になるため、書かせない側で
    // 止める(値を黙って空にする `catch` がまさにこの形 — `fillJinja.ts` を見よ)。
    const offenders = ALL_SOURCES.filter((file) => {
      const code = stripComments(readFileSync(file, 'utf8'));
      return /\bnew\s+Function\s*\(|(?<![.\w])eval\s*\(/.test(code);
    }).map((f) => path.relative(WEB_SRC, f));
    expect(offenders, `eval 系を持っている: ${offenders.join(', ')}`).toEqual([]);
  });

  it('shared の描画器も eval / new Function を持たない', () => {
    // 走査が実在のファイルを読めていないと「常に緑」になるので、描画器が対象に入ることも確かめる。
    const sharedSources = sourceFiles(SHARED_SRC);
    for (const file of SHARED_RENDERERS) expect(sharedSources).toContain(file);
    const offenders = sharedSources
      .filter((file) => {
        const code = stripComments(readFileSync(file, 'utf8'));
        return /\bnew\s+Function\s*\(|(?<![.\w])eval\s*\(/.test(code);
      })
      .map((f) => path.relative(SHARED_SRC, f));
    expect(offenders, `eval 系を持っている: ${offenders.join(', ')}`).toEqual([]);
  });

  it('Worker 層は Jinja 描画を持たない(同一オリジンなので隔離にならない)', () => {
    const offenders = WORKER_FILES.filter((file) =>
      /\brenderJinja\b/.test(stripComments(readFileSync(file, 'utf8'))),
    ).map((f) => path.relative(WEB_SRC, f));
    expect(offenders, `Worker に描画が残っている: ${offenders.join(', ')}`).toEqual([]);
  });

  it.each(ISOLATED_CALLERS)('%s は隔離描画を経由している', (file) => {
    const code = stripComments(readFileSync(file, 'utf8'));
    expect(code).toMatch(/import[^;]*\brenderJinjaIsolated\b[^;]*from/);
    expect(code).toMatch(/\brenderJinjaIsolated\s*\(/);
  });

  it('隔離クライアントは allow-same-origin を付けない', () => {
    // `allow-scripts` と `allow-same-origin` を同時に付けた瞬間に sandbox は無効化と等価に
    // なる(中の JS が親オリジンの DOM と cookie へ到達する)= 隔離そのものが消える。
    const code = readFileSync(path.join(WEB_SRC, 'lib/renderHostClient.ts'), 'utf8');
    expect(stripComments(code)).not.toContain('allow-same-origin');
    expect(stripComments(code)).toContain("'allow-scripts'");
  });

  describe('値差込の評価器は許可リストの外を呼ばない', () => {
    // 評価器(`shared/src/jinja/jinjaExpr.ts`)はコンパイルせずに式を読むが、フィルタ・テスト・関数・
    // メソッドの呼び出しを持つ。呼べる名前が一覧から増えていないこと、一覧の名前を足場にしても
    // prototype の関数へ届かないことを、server と web が共有する描画器(`renderPlainFilled`)の出口で
    // 確かめる。名前を足したら、ここにもその名前を使った攻撃の例を足す。
    const g = globalThis as { __pwnedSsti?: number };
    const run = (src: string) => renderPlainFilled(src, { s: 'abc', xs: [{ a: 1 }], h: '<b>' });

    it.each([
      'default',
      'int',
      'length',
      'list',
      'trim',
      'safe',
      'batch(1)',
      'slice(1)',
      'groupby("a")',
      'select',
      'reject',
      'selectattr("a")',
    ])('許可しているフィルタ %s は解釈できる', (filter) => {
      expect(run(`{{ xs|${filter} }}`).diagnostics.unsupported).toEqual([]);
    });

    it.each([
      // Jinja2 / nunjucks の組み込みのうち、本番パーツが使っていないもの。属性・書式・JSON 化は
      // とくに SSTI の足場になる。
      'attr("constructor")',
      'map("constructor")',
      'format("x")',
      'xmlattr',
      'tojson',
      'dictsort',
      'join',
      'first',
      'sort',
      'unique',
      'rejectattr("a")',
      'string',
      'indent',
      'urlize',
      'wordwrap',
      'pprint',
      'constructor',
      '__proto__',
      'toString',
      'valueOf',
      'hasOwnProperty',
    ])('一覧に無いフィルタ %s は解釈しない', (filter) => {
      expect(run(`{{ xs|${filter} }}`).diagnostics.unsupported).toEqual([`xs|${filter}`]);
    });

    it.each([
      ['テスト', '{{ xs is callable }}'],
      ['テスト(prototype の名前)', '{{ xs is constructor }}'],
      ['select のテスト', '{{ xs|select("callable")|list }}'],
      ['selectattr のテスト', '{{ xs|selectattr("a", "sameas", 1)|list }}'],
      ['関数', '{{ cycler(1) }}'],
      ['関数', '{{ lipsum() }}'],
      ['関数の prototype', '{{ range.constructor("globalThis.__pwnedSsti = 1")() }}'],
      ['関数の prototype', '{{ namespace.constructor("globalThis.__pwnedSsti = 1")() }}'],
      ['メソッド', '{{ s.upper() }}'],
      ['メソッドの prototype', '{{ s.startswith.constructor("globalThis.__pwnedSsti = 1")() }}'],
      ['文字列以外のメソッド', '{{ xs.startswith("a") }}'],
      ['Python の SSTI', "{{ ''.__class__.__mro__[1].__subclasses__() }}"],
      ['Python の SSTI', '{{ cycler.__init__.__globals__.os.popen("id").read() }}'],
      [
        'set 経由の呼び出し',
        '{% set f = range.constructor %}{{ f("globalThis.__pwnedSsti = 1")() }}',
      ],
      ['値データの属性への代入', '{% set xs.a = 1 %}'],
      ['長すぎる range', '{{ range(1000000) }}'],
    ])('%s: %s は評価しない', (_, src) => {
      expect(run(src).diagnostics.unsupported.length).toBeGreaterThan(0);
      expect(g.__pwnedSsti).toBeUndefined();
    });

    it('prototype の値は一覧の名前を経由しても関数として出てこない', () => {
      const { html } = run(
        '{{ (s|safe).constructor }}|{{ namespace(a=1).constructor }}|' +
          '{{ xs|selectattr("constructor")|list|length }}|{{ (xs|groupby("a"))[0].constructor }}',
      );
      expect(html).toBe('||0|');
    });
  });

  it('発信元の検証が contentWindow の同一性で行われている', () => {
    // opaque オリジンの子から届くメッセージの `origin` は 'null' で、他の任意の sandbox
    // フレームとも一致する。`origin` 比較へ差し替えられたらここが落ちる。
    const code = stripComments(readFileSync(path.join(WEB_SRC, 'lib/renderHostClient.ts'), 'utf8'));
    expect(code).toContain('e.source !== frame.contentWindow');
  });
});
