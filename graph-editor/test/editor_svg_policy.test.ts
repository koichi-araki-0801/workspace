// =============================================================================
// editor_svg_policy.test.ts — 未信頼 SVG 許可リストの単体テスト (vitest / node)
// =============================================================================
// `svg-policy.js` は DOM 非依存なので node からそのまま import できる
// (`editor_pie_rules.test.ts` と同じ流儀。jsdom は入れない)。
//
// 本ファイルは**迂回入力が拒否されること**を主張する形に振り切る。正常系だけを
// 並べたテストは「危険物リストに載っていなかっただけ」の経路を検出できず、
// denylist 時代の穴 (`<foreignObject>` の XHTML `<iframe>` / `<animate
// attributeName="href">` / `xl:href` / `java\tscript:`) を素通しさせた。

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  ALLOWED_ELEMENTS,
  SVG_NS,
  isAllowedAttr,
  isAllowedElement,
  safeCssColor,
  sanitizeAttrValue,
  sanitizeFontFaceCss,
} from "../resources/web/js/svg-policy.js";

const XHTML_NS = "http://www.w3.org/1999/xhtml";
const XLINK_NS = "http://www.w3.org/1999/xlink";

describe("isAllowedElement", () => {
  it("能動コンテンツを持ち込める要素は SVG 名前空間でも通さない", () => {
    for (const name of [
      "script", "foreignObject", "animate", "set", "animateTransform", "animateMotion",
      "discard", "a", "image", "use", "feImage", "handler", "iframe", "audio", "video",
      "switch", "filter", "pattern", "marker", "mask", "clipPath", "linearGradient",
    ]) {
      expect(isAllowedElement(name, SVG_NS), name).toBe(false);
    }
  });

  it("許可済みの綴りでも名前空間が違えば通さない (プレフィックスでの持ち込み対策)", () => {
    expect(isAllowedElement("iframe", XHTML_NS)).toBe(false);
    expect(isAllowedElement("g", XHTML_NS)).toBe(false);
    expect(isAllowedElement("g", "urn:x-evil")).toBe(false);
    expect(isAllowedElement("g", null)).toBe(false);
    expect(isAllowedElement("svg", XHTML_NS)).toBe(false);
  });

  it("大小文字を畳まない (畳むと綴り替えが通る / 正常系の綴りが壊れる)", () => {
    expect(isAllowedElement("G", SVG_NS)).toBe(false);
    expect(isAllowedElement("SVG", SVG_NS)).toBe(false);
    expect(isAllowedElement("Path", SVG_NS)).toBe(false);
  });

  it("pie-chart 実出力の 8 要素は通る", () => {
    for (const name of ["svg", "defs", "style", "g", "path", "text", "tspan", "rect"]) {
      expect(isAllowedElement(name, SVG_NS), name).toBe(true);
      expect(ALLOWED_ELEMENTS.has(name), name).toBe(true);
    }
  });
});

describe("isAllowedAttr", () => {
  it("名前空間つき属性は URI だけを見て一律に落とす (プレフィックス比較をしない)", () => {
    // `xlink:href` も `xl:href` も `whatever:href` も、宣言された URI が同じなら同じ扱い。
    expect(isAllowedAttr("href", XLINK_NS, "path")).toBe(false);
    expect(isAllowedAttr("href", "urn:x-evil", "path")).toBe(false);
    expect(isAllowedAttr("space", "http://www.w3.org/XML/1998/namespace", "text")).toBe(false);
    // 修飾名を属性名として持ち込む形 (名前空間宣言なし) も通らない。
    expect(isAllowedAttr("xlink:href", null, "path")).toBe(false);
  });

  it("URL を値に取る属性とイベント属性は許可集合に無い", () => {
    for (const name of ["href", "src", "xlink:href", "onload", "onLoad", "ONLOAD", "onclick", "style"]) {
      expect(isAllowedAttr(name, null, "path"), name).toBe(false);
    }
  });

  it("綴りは完全一致 (`viewBox` を畳むと正常系が壊れる)", () => {
    expect(isAllowedAttr("viewBox", null, "svg")).toBe(true);
    expect(isAllowedAttr("viewbox", null, "svg")).toBe(false);
    expect(isAllowedAttr("textLength", null, "tspan")).toBe(true);
    expect(isAllowedAttr("textlength", null, "tspan")).toBe(false);
  });

  it("`data-*` は通すが、エディタ専有名だけは通さない", () => {
    expect(isAllowedAttr("data-name", null, "g")).toBe(true);
    expect(isAllowedAttr("data-inside-slice", null, "g")).toBe(true);
    // 通すと `bakeSvg` が保存時に消し「開けたのに保存すると消える」不整合になる。
    expect(isAllowedAttr("data-editor", null, "g")).toBe(false);
    expect(isAllowedAttr("data-editor-hit", null, "rect")).toBe(false);
  });

  it("`type` は `<style>` の 1 箇所だけ", () => {
    expect(isAllowedAttr("type", null, "style")).toBe(true);
    expect(isAllowedAttr("type", null, "path")).toBe(false);
  });
});

describe("sanitizeAttrValue", () => {
  it("paint 属性はスキームつきの値も `url()` 参照も受理しない", () => {
    expect(sanitizeAttrValue("path", "fill", "javascript:alert(1)")).toBeNull();
    expect(sanitizeAttrValue("path", "fill", "java\tscript:alert(1)")).toBeNull();
    expect(sanitizeAttrValue("path", "fill", "url(https://example.invalid/x)")).toBeNull();
    expect(sanitizeAttrValue("path", "fill", "url(#grad)")).toBeNull();
    expect(sanitizeAttrValue("path", "stroke", 'red" onload="alert(1)')).toBeNull();
  });

  it("pie-chart 実出力の paint 値は受理する", () => {
    for (const v of ["#d1d2d4", "#ffffff", "#111111", "none", "currentColor"]) {
      expect(sanitizeAttrValue("path", "fill", v), v).toBe(v);
    }
  });

  it("`<style type>` は `text/css` のみ", () => {
    expect(sanitizeAttrValue("style", "type", "text/css")).toBe("text/css");
    expect(sanitizeAttrValue("style", "type", " TEXT/CSS ")).toBe("text/css");
    expect(sanitizeAttrValue("style", "type", "text/javascript")).toBeNull();
  });

  it("制御文字を含む値と長すぎる値は落とす", () => {
    expect(sanitizeAttrValue("text", "font-family", "sans\u0000serif")).toBeNull();
    expect(sanitizeAttrValue("text", "font-family", "x".repeat(5000))).toBeNull();
    // 座標列 (`d` / `points`) だけは長さの別枠を持つ。
    expect(sanitizeAttrValue("path", "d", `M0,0 ${"L1,1 ".repeat(2000)}`)).not.toBeNull();
  });

  it("それ以外の属性値は素通しする (URL 属性が 1 つも残らないため)", () => {
    expect(sanitizeAttrValue("text", "font-family", '"BIZ UDPGothic", sans-serif'))
      .toBe('"BIZ UDPGothic", sans-serif');
    expect(sanitizeAttrValue("g", "data-name", "A & B")).toBe("A & B");
    expect(sanitizeAttrValue("g", "data-name", 42 as unknown as string)).toBeNull();
  });
});

describe("safeCssColor", () => {
  it("宣言の継ぎ足し・markup 脱出・関数呼び出しを落とす", () => {
    expect(safeCssColor("red;background-image:url(https://example.invalid/x)")).toBeNull();
    expect(safeCssColor('#fff"><img src=x onerror="alert(1)">')).toBeNull();
    expect(safeCssColor("expression(alert(1))")).toBeNull();
    expect(safeCssColor("url(#x)")).toBeNull();
    expect(safeCssColor("rgb(0,0,0);x:y")).toBeNull();
    expect(safeCssColor("var(--sunk, url(https://example.invalid/x))")).toBeNull();
    expect(safeCssColor("#ff\u0000f")).toBeNull();
    expect(safeCssColor("a".repeat(200))).toBeNull();
    expect(safeCssColor("")).toBeNull();
    expect(safeCssColor(null as unknown as string)).toBeNull();
  });

  it("色として妥当な書式だけ受理する", () => {
    for (const v of ["#4e79a7", "#fff", "#ffff", "#4e79a7cc", "rgb(1,2,3)", "rgba(1, 2, 3, 0.5)",
      "hsl(120deg 50% 50%)", "var(--sunk)", "currentColor", "rebeccapurple", " #fff "]) {
      expect(safeCssColor(v), v).not.toBeNull();
    }
    expect(safeCssColor(" #fff ")).toBe("#fff");
  });
});

describe("sanitizeFontFaceCss", () => {
  it("外部フェッチを立てる CSS は 1 つも受理しない", () => {
    expect(sanitizeFontFaceCss("@import url(https://example.invalid/x.css);")).toBe("");
    expect(sanitizeFontFaceCss("@font-face{src:url(https://example.invalid/f.woff2)}")).toBe("");
    expect(sanitizeFontFaceCss("@font-face{src:url(data:text/html;base64,AAAA)}")).toBe("");
    expect(sanitizeFontFaceCss("@font-face{src:url('/local.woff2')}")).toBe("");
  });

  it("`@import` を消すだけの denylist では抜ける形を、全消費マッチで落とす", () => {
    // CSS エスケープでの綴り替え。バックスラッシュを含む入力は入口で捨てる。
    expect(sanitizeFontFaceCss("@\\69mport url(https://example.invalid/x.css);")).toBe("");
    // 大小混在・前後の空白でも `@font-face` 以外は受理しない。
    expect(sanitizeFontFaceCss("  @IMPORT url(https://example.invalid/x.css);  ")).toBe("");
    // アプリ UI のセレクタを乗っ取る CSS (インライン SVG の CSS は文書全体に効く)。
    expect(sanitizeFontFaceCss(".btn{display:none}")).toBe("");
    expect(sanitizeFontFaceCss("@font-face{font-weight:400}.btn{display:none}")).toBe("");
  });

  it("受理ブロックの後ろに 1 バイトでも残れば全体を捨てる", () => {
    const ok = '@font-face{src:url(data:font/woff2;base64,AAAA) format("woff2");}';
    expect(sanitizeFontFaceCss(ok)).not.toBe("");
    expect(sanitizeFontFaceCss(`${ok}]]><script>x</script>`)).toBe("");
    expect(sanitizeFontFaceCss(`${ok}x`)).toBe("");
    expect(sanitizeFontFaceCss("@font-face{src:url(data:font/woff2;base64,AAAA)")).toBe("");
  });

  it("base64 の charset を縛り `)` での早期クローズを塞ぐ", () => {
    expect(sanitizeFontFaceCss("@font-face{src:url(data:font/woff2;base64,AA)AA)}")).toBe("");
    expect(sanitizeFontFaceCss("@font-face{src:url(data:font/woff2;base64,AA<AA)}")).toBe("");
  });

  it("認識できない宣言が 1 つでもあればブロックごと捨てる", () => {
    expect(sanitizeFontFaceCss("@font-face{font-weight:400;behavior:url(x.htc)}")).toBe("");
    expect(sanitizeFontFaceCss("@font-face{font-weight:heavy}")).toBe("");
    expect(sanitizeFontFaceCss("@font-face{@media{}}")).toBe("");
  });

  it("宣言名がプロトタイプ由来の語でも、例外ではなく拒否で返す", () => {
    // 宣言名は攻撃者が綴れる文字列で、そのまま許可表のキーになる。素のオブジェクト表だと
    // `constructor` / `__proto__` が継承値 (`Object` / `Object.prototype`) を返し、
    // 「未知プロパティ = 拒否」ではなく `re.test` の TypeError になっていた。例外は
    // `sanitizeSvg` を貫いて `editor-io.js` の `load` を中断させ、キャンバスに前のファイルを
    // 残す (= 旧内容を新ファイル名で保存できる) ので、ここは**投げないこと**まで主張する。
    for (const prop of ["constructor", "__proto__", "toString", "hasOwnProperty", "valueOf",
      "isPrototypeOf", "propertyIsEnumerable", "toLocaleString"]) {
      expect(() => sanitizeFontFaceCss(`@font-face{${prop}:a}`), prop).not.toThrow();
      expect(sanitizeFontFaceCss(`@font-face{${prop}:a}`), prop).toBe("");
      // 正当な宣言に混ぜても、ブロックごと捨てる方へ倒れること。
      const mixed = `@font-face{src:url(data:font/woff2;base64,AAAA);${prop}:a}`;
      expect(() => sanitizeFontFaceCss(mixed), prop).not.toThrow();
      expect(sanitizeFontFaceCss(mixed), prop).toBe("");
    }
  });

  it("pie-chart 実出力の `@font-face` はバイト単位で受理し、再適用でも変わらない", () => {
    // 出典: `pie-chart/out/svg_js/asset_4slice_simple.svg` の `<style>` 内容
    // (base64 のみ先頭 64 文字へ短縮)。`out/` は git 未追跡なのでフィクスチャに固定する。
    const css = readFileSync(new URL("./fixtures/pie_font_face.css", import.meta.url), "utf8");
    const out = sanitizeFontFaceCss(css);
    expect(out).toBe(css);
    expect(sanitizeFontFaceCss(out)).toBe(out);
    expect(out).toContain("data:font/woff2;base64,");
    expect(out).not.toContain("@import");
  });
});

// ── 計算量の上限(ReDoS) ──
// 資源上限は「入力の大きさ」と「処理の計算量」の 2 軸で持つ必要がある。入力長
// (`MAX_SVG_INPUT_CHARS` 8MiB)・ノード数・ラベル数の上限はどれも大きさの上限で、
// 100 バイト未満の入力で刺さる指数バックトラックは止められない。しかもサニタイザが
// メインスレッドで固まると、規定の失敗の仕方(読込ごと拒否 + 件数通知)にすらならず、
// `/ping` 途絶で 60 秒後にサーバが自ら終了する = 守るためのコードが守る対象を殺す。
describe("@font-face の値検証は入力長に対して線形", () => {
  /** 受理される `src`(許可されるのは `data:` のフォントだけ)。ここは検証の対象外。 */
  const SRC = 'src:url(data:font/woff2;base64,AAAA) format("woff2")';

  /** 非マッチが確定する最悪形。区切りごとに解析の分岐が増える形を狙う。 */
  const evil = (n: number) => `${Array(n).fill("a ").join(",")},!`;

  it("正当な font-family は今までどおり通る", () => {
    for (const ok of [
      "Arial",
      "sans-serif",
      '"BIZ UDPGothic"',
      "'Noto Serif JP'",
      "Times New Roman",
      'Arial, "BIZ UDPGothic", sans-serif',
      "Helvetica Neue, Arial, sans-serif",
    ])
      expect(sanitizeFontFaceCss(`@font-face{font-family:${ok};${SRC}}`), ok).not.toBe("");
  });

  it("区切りを 16 倍にしても所要は跳ね上がらない", () => {
    // 指数バックトラックだと 28 → 448 で天文学的に伸びる(修正前は 85 バイトで 6.5 秒)。
    const measure = (n: number) => {
      const css = `@font-face{font-family:${evil(n)};${SRC}}`;
      const t0 = performance.now();
      sanitizeFontFaceCss(css);
      return performance.now() - t0;
    };
    measure(28); // ウォームアップ(JIT の初回コストを測らない)
    const small = measure(28);
    const large = measure(448);
    // 線形なら概ね 16 倍。定数項に埋もれるので上限は緩く取り、桁が変わらないことを見る。
    expect(large).toBeLessThan(Math.max(50, small * 200));
    expect(large).toBeLessThan(1000);
  });
});
