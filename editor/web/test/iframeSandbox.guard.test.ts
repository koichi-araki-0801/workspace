// =============================================================================
// iframeSandbox.guard.test.ts — srcdoc iframe の sandbox 必須ガード
// =============================================================================
// 差分・比較・プレビューの iframe には、他ユーザ(申請者)が書いた HTML/CSS が入る。sandbox が
// 無いと承認者のブラウザ上・アプリと同一オリジンでスクリプトが走り、職務分掌(自己承認拒否)を
// 実質回避できる。個々の画面のマウントではなくソース走査で守るのは、iframe を増やした時に
// 「新しい 1 箇所だけ付け忘れる」形の退行を確実に落とすため。
//
// **守り方は「除去」ではなく「隔離」である。** テンプレの JavaScript は正当なコンテンツで、
// 承認者は JS が効いた実行結果を見て承認する。よって JS は動かす(`allow-scripts`)が、
// `allow-same-origin` は付けない — 両方を同時に付けると子は親オリジンの DOM へ到達でき、
// sandbox は事実上無効になる。`allow-same-origin` 単独(= JS を殺す)も採らない: 承認者が
// 「JS が効いていない見た目」を承認してしまい、承認ゲートの意味が失われる。
// 高さ追随は `useIframeAutoFit` の postMessage 経由で、親は子の DOM を読まない。
import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const SRC_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../src');

// 走査は `.vue` だけでなく `.ts` も対象にする。iframe は画面のテンプレートだけでなく
// `document.createElement('iframe')` でも生えるためで、実際に隔離レンダーホスト
// (`lib/renderHostClient.ts`)はそちらの形で作っている。`.vue` しか見ない版では、
// 隔離の本体が 1 行も検査されていなかった。
function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) out.push(...sourceFiles(full));
    else if (name.endsWith('.vue') || name.endsWith('.ts')) out.push(full);
  }
  return out;
}

/**
 * 字面の走査はコメントを外してから行う。`.ts` の doc コメントには説明として
 * `<iframe srcdoc>` のような字面が現れ、素で走査すると「属性の無い iframe」として誤検出する
 * (`lib/useIframeAutoFit.ts` で実際に起きた)。行番号は報告に使うので、コメントは
 * 削除ではなく**空白へ潰して行の数を保つ**。
 */
function stripComments(file: string, source: string): string {
  const blank = (m: string) => m.replace(/[^\n]/g, ' ');
  let s = file.endsWith('.vue') ? source.replace(/<!--[\s\S]*?-->/g, blank) : source;
  s = s.replace(/\/\*[\s\S]*?\*\//g, blank);
  // `https://` の `//` をコメント開始と誤らないよう、直前が `:` の場合は対象外にする。
  s = s.replace(
    /(^|[^:])\/\/.*$/gm,
    (m, head: string) => head + ' '.repeat(m.length - head.length),
  );
  return s;
}

const SOURCES = sourceFiles(SRC_DIR).map((full) => {
  const file = path.relative(SRC_DIR, full).replace(/\\/g, '/');
  return { file, source: stripComments(file, readFileSync(full, 'utf8')) };
});

/** `<iframe ...>` の開始タグを属性文字列ごと拾う(自己終了・通常終了の双方)。 */
function iframeTags(source: string): string[] {
  return [...source.matchAll(/<iframe\b[^>]*>/g)].map((m) => m[0]);
}

const FRAMES = SOURCES.flatMap(({ file, source }) =>
  iframeTags(source).map((tag) => ({ file, tag })),
);

// `createElement('iframe')` で作る iframe は、属性が後続の `setAttribute` で付く。
// 生成行から続くこの行数ぶんを「同じ組み立て」と見なして sandbox の有無を判定する。
// 許可リストで実装を名指しするのではなく、**付け方の作法**(生成の直後に付ける)を要求する
// 形にしてある。離れた場所で付ける実装は検査を通らず落ちるが、それは避けるべき書き方でもある。
const CREATION_WINDOW_LINES = 25;

/** 生成箇所と、その直後の窓に現れた `sandbox` の値(付いていなければ null)。 */
const CREATED_FRAMES = SOURCES.flatMap(({ file, source }) => {
  const lines = source.split('\n');
  const out: Array<{ file: string; line: number; sandbox: string | null }> = [];
  lines.forEach((line, i) => {
    if (!/createElement\(\s*['"`]iframe['"`]\s*\)/.test(line)) return;
    const window = lines.slice(i, i + CREATION_WINDOW_LINES).join('\n');
    const m = window.match(/setAttribute\(\s*['"`]sandbox['"`]\s*,\s*['"`]([^'"`]*)['"`]/);
    out.push({ file, line: i + 1, sandbox: m ? m[1] : null });
  });
  return out;
});

describe('srcdoc iframe の sandbox ガード', () => {
  it('走査対象の iframe を実際に見つけている(セルフテスト)', () => {
    // 0 件だと以下の forEach が素通りして「常に緑」になるため、下限を固定する。
    expect(FRAMES.length).toBeGreaterThanOrEqual(5);
  });

  it('すべての iframe が sandbox 属性を持つ', () => {
    const missing = FRAMES.filter((f) => !/\bsandbox\s*=/.test(f.tag)).map((f) => f.file);
    expect(missing, `sandbox の無い iframe: ${missing.join(', ')}`).toEqual([]);
  });

  it('allow-scripts と allow-same-origin を同時に許す iframe が無い', () => {
    // これが本丸。同時指定は sandbox の無効化と等価で、`allow-scripts` へ寄せた今は
    // 「高さを読むために same-origin も足す」形で戻ってくる圧力が最も高い。
    const both = FRAMES.filter(
      (f) => /allow-scripts/.test(f.tag) && /allow-same-origin/.test(f.tag),
    ).map((f) => f.file);
    expect(both, `sandbox が無効化された iframe: ${both.join(', ')}`).toEqual([]);
  });

  it('テンプレ本文を映す iframe は allow-scripts で開く(JS を殺さない)', () => {
    // `allow-same-origin` 単独へ戻すと、承認者は「JS が効いていない見た目」を承認する。
    // 対象は srcdoc を持つ(= テンプレ本文を映す)フレームに限る。
    const srcdocFrames = FRAMES.filter((f) => /srcdoc/.test(f.tag));
    expect(srcdocFrames.length).toBeGreaterThanOrEqual(4);
    const inert = srcdocFrames.filter((f) => !/allow-scripts/.test(f.tag)).map((f) => f.file);
    expect(inert, `JS が動かない iframe: ${inert.join(', ')}`).toEqual([]);
  });

  it('親が子の contentDocument を読まない(高さは postMessage 経由)', () => {
    // `allow-same-origin` なしでは `contentDocument` は null。読む実装が残っていると
    // 「高さが合わないから same-origin を足す」退行の入口になる。
    // メンバアクセス(`.contentDocument`)だけを見る。コメント中のバッククォート表記
    // (規約上、識別子は必ずバッククォートで囲む)を誤検出しないため。
    const offenders = SOURCES.filter(({ source }) => /\.contentDocument\b/.test(source)).map(
      ({ file }) => file,
    );
    expect(offenders, `contentDocument を読む画面: ${offenders.join(', ')}`).toEqual([]);
  });
});

describe('createElement で作る iframe の sandbox ガード', () => {
  it('走査対象の生成箇所を実際に見つけている(セルフテスト)', () => {
    // 0 件だと以下が素通りして「常に緑」になる。隔離レンダーホストが最低 1 箇所ある。
    expect(CREATED_FRAMES.length).toBeGreaterThanOrEqual(1);
  });

  it('生成の直後に sandbox を付けている', () => {
    const missing = CREATED_FRAMES.filter((f) => f.sandbox === null).map(
      (f) => `${f.file}:${f.line}`,
    );
    expect(missing, `sandbox の無い iframe 生成: ${missing.join(', ')}`).toEqual([]);
  });

  it('allow-scripts と allow-same-origin を同時に許す生成が無い', () => {
    // タグ側と同じ本丸。隔離ホストは opaque オリジンであることが前提で、`allow-same-origin`
    // を足した瞬間に子はアプリオリジンの DOM へ到達でき、隔離が無効化と等価になる。
    const both = CREATED_FRAMES.filter(
      (f) => f.sandbox?.includes('allow-scripts') && f.sandbox.includes('allow-same-origin'),
    ).map((f) => `${f.file}:${f.line}`);
    expect(both, `sandbox が無効化された iframe 生成: ${both.join(', ')}`).toEqual([]);
  });
});
