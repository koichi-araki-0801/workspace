// =============================================================================
// ssti.guard.test.ts — 「アプリオリジンで Jinja をコンパイルしない」ガード
// =============================================================================
// 所見 F1: `compareService` が申請者の書いたテンプレ本文を承認者のページオリジンの
// メインスレッドで nunjucks コンパイルしていた。nunjucks はサンドボックスではなく
// **コンパイラ**で、`{{ range.constructor("…")() }}` は `new Function` へ到達する。走った JS は
// 承認者のセッション(HttpOnly cookie は同一オリジン fetch へ自動で付く)のまま承認 API を
// 叩けるため、editor 1 ロールで職務分掌が破れていた。
//
// 直したのは「どこでコンパイルするか」であって、入力の検査ではない。ゆえに守るべき不変則は
// 個々の入力に対する挙動ではなく**呼び出しの形**で、それはソース走査でしか固定できない:
//
//   (I)   `lib/nunjucksRender.ts` 以外のアプリコードは `renderJinja` を import しない。
//   (II)  Worker 層は Jinja 描画を持たない(Worker は**同一オリジン**で、cookie 付き fetch が
//         通る = 隔離になっていない。オフロードは隔離ではない)。
//   (III) 描画を要する 4 経路は `renderJinjaIsolated`(opaque オリジンの iframe)を通る。
//         配線が外れた瞬間にここが落ちる — 「機構はあるが繋がっていない」を許さない。
import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const WEB_SRC = path.resolve(HERE, '../src');

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
/** `renderJinja` の定義元。ここだけは実装を持ってよい(隔離側と設定を揃える出所)。 */
const RENDER_JINJA_HOME = path.join(WEB_SRC, 'lib/nunjucksRender.ts');

/** Jinja 描画を持ってはならない Worker 層。 */
const WORKER_FILES = [
  path.join(WEB_SRC, 'workers/index.ts'),
  path.join(WEB_SRC, 'workers/htmlWorkerImpl.ts'),
  path.join(WEB_SRC, 'workers/fallback.ts'),
];

/** 隔離描画を通さねばならない経路(F1 の実体 + PDF 系)。 */
const ISOLATED_CALLERS = [
  path.join(WEB_SRC, 'features/compare/services/compareService.ts'),
  path.join(WEB_SRC, 'features/preview/services/templatePreviewService.ts'),
  path.join(WEB_SRC, 'lib/pdfDocument.ts'),
];

describe('SSTI ガード — Jinja のコンパイルはアプリオリジンで行わない', () => {
  it('走査対象を実際に読めている(セルフテスト)', () => {
    // 収集に失敗していると以下が全部素通りして「常に緑」になる。
    expect(ALL_SOURCES.length).toBeGreaterThan(50);
    expect(ALL_SOURCES).toContain(RENDER_JINJA_HOME);
    for (const file of [...WORKER_FILES, ...ISOLATED_CALLERS]) {
      expect(readFileSync(file, 'utf8').length).toBeGreaterThan(200);
    }
  });

  it('nunjucksRender.ts 以外のアプリコードは renderJinja を import しない', () => {
    // `import type` だけを取り出す形にはしない — 値として束縛できれば呼べてしまう。
    const offenders = ALL_SOURCES.filter((file) => {
      if (file === RENDER_JINJA_HOME) return false;
      const code = stripComments(readFileSync(file, 'utf8'));
      return /import[^;]*\brenderJinja\b[^;]*from/.test(code);
    }).map((f) => path.relative(WEB_SRC, f));
    expect(offenders, `renderJinja を import している: ${offenders.join(', ')}`).toEqual([]);
  });

  it('nunjucks を直に import してよいのは nunjucksRender / fillJinja だけ', () => {
    // 新しい描画経路が別ファイルに生えると、隔離を経ないコンパイルが静かに復活する。
    // `fillJinja.ts` は作成タブの値差込(自分が作ったスケルトンを自分の画面で埋める)で、
    // 他人が書いた本文を通す経路ではないため現時点では対象外。増やすときはここを更新し、
    // 「他人由来の本文を通さない」ことを確認すること。
    const allowed = new Set([RENDER_JINJA_HOME, path.join(WEB_SRC, 'lib/fillJinja.ts')]);
    const offenders = ALL_SOURCES.filter((file) => {
      if (allowed.has(file)) return false;
      const code = stripComments(readFileSync(file, 'utf8'));
      return /from\s*['"]nunjucks['"]/.test(code);
    }).map((f) => path.relative(WEB_SRC, f));
    expect(offenders, `nunjucks を直接 import している: ${offenders.join(', ')}`).toEqual([]);
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

  it('発信元の検証が contentWindow の同一性で行われている', () => {
    // opaque オリジンの子から届くメッセージの `origin` は 'null' で、他の任意の sandbox
    // フレームとも一致する。`origin` 比較へ差し替えられたらここが落ちる。
    const code = stripComments(readFileSync(path.join(WEB_SRC, 'lib/renderHostClient.ts'), 'utf8'));
    expect(code).toContain('e.source !== frame.contentWindow');
  });
});
