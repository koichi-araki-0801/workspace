// =============================================================================
// editor_shortcuts.test.ts — キーボードショートカットの受理判定の単体テスト
// =============================================================================
// `utils.js` は DOM API を関数の中でしか触らないので node からそのまま import できる
// (`editor_state_fields.test.ts` と同じ流儀。jsdom は入れない)。
//
// 受理判定は `editor-events.js` の配線の**先頭**に置く関門で、ここが緩むと入力欄の
// 取り消しを横取りしたり、キャンバスの見えない手順で文書だけが黙って動いたりする。

import { describe, expect, it } from "vitest";
import { acceptsShortcut } from "../resources/web/js/utils.js";

/** `document.activeElement` 相当の最小記述子。 */
const el = (tagName: string, isContentEditable = false) => ({ tagName, isContentEditable });

describe("acceptsShortcut", () => {
  it("入力欄にフォーカスがある間はどの範囲も受理しない", () => {
    for (const scope of ["document", "save", "open"] as const) {
      expect(acceptsShortcut(el("INPUT"), 2, scope), scope).toBe(false);
      expect(acceptsShortcut(el("TEXTAREA"), 2, scope), scope).toBe(false);
      expect(acceptsShortcut(el("SELECT"), 2, scope), scope).toBe(false);
      expect(acceptsShortcut(el("DIV", true), 2, scope), scope).toBe(false);
    }
    // 小文字の `tagName` (XHTML 等) でも同じ判定になる。
    expect(acceptsShortcut(el("input"), 2, "document")).toBe(false);
  });

  it("文書に紐づく操作は編集画面 (手順 2) でのみ受理する", () => {
    expect(acceptsShortcut(el("BODY"), 1, "document")).toBe(false);
    expect(acceptsShortcut(el("BODY"), 2, "document")).toBe(true);
    expect(acceptsShortcut(el("BODY"), 3, "document")).toBe(false);
  });

  it("保存は編集画面と保存画面で、開くはどの手順でも受理する", () => {
    expect(acceptsShortcut(el("BODY"), 1, "save")).toBe(false);
    expect(acceptsShortcut(el("BODY"), 2, "save")).toBe(true);
    expect(acceptsShortcut(el("BODY"), 3, "save")).toBe(true);
    for (const phase of [1, 2, 3]) expect(acceptsShortcut(el("BODY"), phase, "open"), `${phase}`).toBe(true);
  });

  it("フォーカス要素が無くても判定できる (手順だけで決まる)", () => {
    expect(acceptsShortcut(null, 2, "document")).toBe(true);
    expect(acceptsShortcut(undefined, 1, "document")).toBe(false);
    expect(acceptsShortcut(null, 1, "open")).toBe(true);
  });
});
