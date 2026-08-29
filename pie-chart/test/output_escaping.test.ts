// =============================================================================
// output_escaping.test.ts — 設定値の素通しの退行ガード
// =============================================================================
// 「エスケープすべき属性」を列挙する形だと、同じ 1 行の中で `font-family` は escape され
// `fill` は素通し、という非対称が生まれる。`--font-weight '400" onload="alert(1)'` で全 `<text>`
// に onload が付く。**「迂回入力で throw すること」を主張する形**で書く。
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { createPieLayoutConfig } from '../src/config.js';
import { attr, escapeXml, isSvgColor } from '../src/svg_export/values.js';
import { renderPdfStylePieToSvg } from '../src/svg_export/pipeline.js';

const ITEMS: Array<[string, number]> = [
  ['国内株式', 40],
  ['外国債券', 35],
  ['その他', 25],
];

/** 属性を閉じて新しい属性を足す典型的な breakout 値。 */
const BREAKOUT = '#111" onload="alert(1)';

describe('設定値の許可リスト', () => {
  it('font-weight の属性 breakout を拒否する', async () => {
    await expect(
      renderPdfStylePieToSvg(ITEMS, { fontWeight: '400" onload="alert(1)' }),
    ).rejects.toThrow(/font-weight/);
  });

  // 完全一致の Set は受理集合が仕様として閉じていることを構造で示せる(正規表現は読み手が
  // 受理範囲を再導出する必要がある)。Set の完全一致で書いていることを固定する。
  it('末尾に改行や空白が付いた font-weight を拒否する', () => {
    for (const bad of ['400\n', '400 ', ' 400', '400;']) {
      expect(() => createPieLayoutConfig({ fontWeight: bad }), bad).toThrow(/font-weight/);
    }
    expect(() => createPieLayoutConfig({ fontWeight: '700' })).not.toThrow();
  });

  it('色を受ける設定すべてで breakout を拒否する', () => {
    const keys = ['textColor', 'lineColor', 'backgroundColor', 'darkSliceTextColor'] as const;
    for (const key of keys) {
      expect(() => createPieLayoutConfig({ [key]: BREAKOUT }), key).toThrow(/色として受理できない/);
    }
    expect(() => createPieLayoutConfig({ grayScale4: ['#fff', BREAKOUT, '#000', '#111'] })).toThrow(
      /grayScale4\[1\]/,
    );
  });

  // CSS の関数記法は `rgb(0,0,0);x:y` で宣言を増やせ、`url()` は外部参照の入口になる。
  it('rgb() / hsl() / url() は色として受理しない', () => {
    for (const bad of ['rgb(0,0,0)', 'hsl(0,0%,0%)', 'url(#x)', 'javascript:alert(1)']) {
      expect(isSvgColor(bad), bad).toBe(false);
    }
    for (const ok of ['#fff', '#ffff', '#112233', '#11223344', 'rebeccapurple', 'none']) {
      expect(isSvgColor(ok), ok).toBe(true);
    }
  });

  // 属性エスケープでは守れない経路。`font.ts` は `@font-face{font-family:"…"}` を CDATA 内の
  // CSS として書くため、`"` を閉じて `;` で宣言を増やせるし `]]>` で CDATA も閉じられる。
  it('埋め込みフォント名の CSS / CDATA breakout を拒否する', () => {
    for (const bad of ['X";}@font-face{font-family:Y', 'X]]><script>alert(1)</script>']) {
      expect(() => createPieLayoutConfig({ embedFontFamilyName: bad }), bad).toThrow(
        /フォント名として受理できない/,
      );
    }
    expect(() => createPieLayoutConfig({ embedFontFamilyName: 'BIZ UDPGothic' })).not.toThrow();
  });

  // `WEIGHT_FONT[base.fontWeight]` の素の添字は Object.prototype を辿り、
  // `embedFontPath` に関数が入る。
  it('プロトタイプ由来のキーを font-weight として受け付けない', () => {
    for (const bad of ['constructor', '__proto__', 'toString']) {
      expect(() => createPieLayoutConfig({ fontWeight: bad }), bad).toThrow(/font-weight/);
    }
  });

  it('既定の設定は throw しない(既定値では検証が恒等)', () => {
    expect(() => createPieLayoutConfig()).not.toThrow();
  });

  // `embedFontPath` は設定値のうち唯一「読めたファイルの中身がそのまま `@font-face` の
  // base64 として出力 SVG へ入る」フィールドで、許可リストから漏れると読み出しと持ち出しが
  // 1 経路でつながる。同梱フォント 2 ファイルの完全一致のみを通す。
  it('embedFontPath は同梱フォント 2 ファイル以外を拒否する', () => {
    for (const bad of [
      'C:\\Users\\svc\\.ssh\\id_rsa',
      '../../secret.woff2',
      'fonts/BIZUDPGothic-Regular.woff2 ',
      'fonts/../fonts/BIZUDPGothic-Regular.woff2',
      42 as unknown as string,
    ]) {
      expect(() => createPieLayoutConfig({ embedFontPath: bad }), String(bad)).toThrow(
        /embedFontPath/,
      );
    }
    for (const ok of ['fonts/BIZUDPGothic-Regular.woff2', 'fonts/BIZUDPGothic-Bold.woff2']) {
      expect(() => createPieLayoutConfig({ embedFontPath: ok }), ok).not.toThrow();
    }
  });
});

// 第 2 層。config の検査を迂回して cfg を直に組んでも、フォントとして解釈できない
// バイト列は埋め込まれない(subset 失敗時に原本を truetype と名乗って base64 埋込する
// fallback へ倒さない)。
describe('埋め込みフォントの fallback', () => {
  it('フォントでないファイルは subset 失敗時に埋め込まず投げる', async () => {
    const { buildFontFaceDefs } = await import('../src/svg_export/font.js');
    const cfg = { ...createPieLayoutConfig(), embedFontPath: 'README.md' };
    await expect(buildFontFaceDefs(cfg, null)).rejects.toThrow(/does not look like a font file/);
  });

  it('同梱フォントは従来どおり @font-face を返す(回帰)', async () => {
    const { buildFontFaceDefs } = await import('../src/svg_export/font.js');
    const defs = await buildFontFaceDefs(createPieLayoutConfig(), null);
    expect(defs).toContain('@font-face');
    expect(defs).toContain('format("woff2")');
  });
});

describe('出力側からの網羅主張', () => {
  it('ラベル・設定に注入値を入れても実行可能な属性が出力に現れない', async () => {
    const nasty: Array<[string, number]> = [
      ['a" onload="alert(1)', 40],
      ['<script>alert(1)</script>', 35],
      ["b' onerror='x", 25],
    ];
    const { svg } = await renderPdfStylePieToSvg(nasty, {});
    // 属性を閉じる生の引用符が出力に現れない = breakout が成立していない。
    expect(svg).not.toContain('" onload="');
    expect(svg).not.toContain("' onerror='");
    expect(svg).not.toMatch(/<script/i);
    // 値が消えたのではなくエスケープされて残っていること(欠測との取り違えを防ぐ)。
    expect(svg).toContain('&quot; onload=&quot;');
    expect(svg).toContain('&lt;script&gt;');
  });
});

// 宣言だけで強制が無い状態を防ぐ。python-tools リポジトリの pdf-to-svg 側にある
// `test_no_attribute_is_built_with_a_raw_f_string` と同趣旨のソース走査で、
// 列挙(「この属性もエスケープする」)の漏れを「`attr()` を使っていない箇所」として検出する。
describe('属性を書く手段は attr() 1 つだけ(ソース走査)', () => {
  const srcDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../src/svg_export');
  // 個別ファイルのハードコードだと新規ファイルが検査から漏れる。build_pins.test.ts の
  // .ps1 走査と同じ形で svg_export/ 配下の .ts を全走査する。
  const srcFiles = readdirSync(srcDir).filter((f) => f.endsWith('.ts'));

  // 走査で引っかかる正当行(コード例のコメント等)は行内容の完全一致でのみ除外する。
  // 「コメント行なら除外」のような緩い述語にすると、本物の breakout をコメント化して
  // 隠す迂回を通してしまう。
  const ALLOWED_OFFENDER_LINES: ReadonlySet<string> = new Set([
    ' * — テンプレートリテラルで `x="${v}"` と組む箇所を残すと、そこが次の注入点になる。',
  ]);

  it('走査対象の .ts が存在する(空なら検査自体が空振りしている)', () => {
    expect(srcFiles.length).toBeGreaterThan(0);
    expect(srcFiles).toEqual(expect.arrayContaining(['rendering.ts', 'font.ts', 'pipeline.ts']));
  });

  for (const name of srcFiles) {
    it(`${name} にテンプレートリテラルで組んだ属性が残っていない`, () => {
      const text = readFileSync(path.join(srcDir, name), 'utf8');
      // 行単位でなく全文へ正規表現を当てる。`[^}]*` は改行も含むので、属性を複数行に
      // 折り返した breakout(`x="${\n...\n}"` のような形)も拾える。ネストした `${...}` の
      // 中に `}` が現れると早期に閉じてしまうが、attr() 迂回の検出という検査意図では
      // 1 段の breakout を見つけられれば十分なので今回はこの限界を据え置く。
      const offenders = [...text.matchAll(/[\w:-]+="\$\{[^}]*\}/g)]
        .filter((match) => {
          // マッチの開始位置が属する行を求め、その行がまるごと許可リストに載っているかで
          // 除外を判定する(マッチ文字列自体でなく行内容の完全一致にすることで、正当な
          // コメント例だけを通し、複数行の実コードは素通りさせない)。
          const start = match.index ?? 0;
          const lineStart = text.lastIndexOf('\n', start - 1) + 1;
          const lineEndRaw = text.indexOf('\n', start);
          const lineEnd = lineEndRaw === -1 ? text.length : lineEndRaw;
          return !ALLOWED_OFFENDER_LINES.has(text.slice(lineStart, lineEnd));
        })
        .map((match) => match[0]);
      expect(offenders, `attr() を通さずに属性を組んでいる: ${offenders.join(' / ')}`).toEqual([]);
    });
  }
});

describe('XML 1.0 不正文字の除去', () => {
  it('制御文字と孤立サロゲートを落とす', () => {
    expect(escapeXml('ok\u0007bell')).toBe('okbell');
    expect(escapeXml('a\u0000b\u001Fc')).toBe('abc');
    expect(escapeXml('lone\uD800surrogate')).toBe('lonesurrogate');
    // 正当なサロゲートペアは残す(絵文字・拡張漢字が消えては困る)。
    expect(escapeXml('𩸽')).toBe('𩸽');
    // タブ・改行は XML 1.0 で合法なので残す。
    expect(escapeXml('a\tb\nc')).toBe('a\tb\nc');
  });

  // 入口(`normalizeInputItems` の `checkName`)が fail-close するので、除去されて別の
  // 文字列が黙って出力される経路はもう無い。escapeXml 自身の除去挙動(上記)は出力段の
  // 最終防衛線としてそのまま残す。
  it('制御文字を含む名前は入口で明示エラーになる', async () => {
    await expect(renderPdfStylePieToSvg([['ベル入り', 100]], {})).rejects.toThrow(
      /invalid in XML output/,
    );
  });
});

describe('attr の出力形', () => {
  // `out/_baseline` との byte 一致が鉄則なので、空白の入り方と数値の文字列化を固定する。
  it('先頭に空白 1 つ・値は二重引用符・数値は String と同一', () => {
    expect(attr('x', 12.5)).toBe(' x="12.5"');
    expect(attr('fill', '#111111')).toBe(' fill="#111111"');
    expect(attr('d', 'M0,0 L1,1')).toBe(' d="M0,0 L1,1"');
    expect(attr('data-name', 'a"b')).toBe(' data-name="a&quot;b"');
  });
});
