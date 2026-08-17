// =============================================================================
// state.test.js — `resources/web/state.js` の状態機械の単体テスト (vitest)
// =============================================================================
// `S` はモジュールシングルトンのため、各テスト冒頭で `reset` により既知状態へ戻す。
// DOM 非依存 (spec 入力値・parseSpec は引数渡し) を利用して node 単体で検証する。

import { beforeEach, describe, expect, it } from "vitest";
import {
  S, counts, pass, initStatus,
  statusArr, changedArr, selSet, pkey, curElSel, statusOfCur, selKeys, selCount, clearSel,
  applyState, nextPending, firstPending, advancePhase,
  exportPageList, expCount, zipName,
} from "../resources/web/state.js";

function reset() {
  applyState({
    files: [{ name: "a.pdf", pages: 2 }, { name: "b.pdf", pages: 3 }],
    pages: [
      { fileIndex: 0, pageInFile: 0 }, { fileIndex: 0, pageInFile: 1 },
      { fileIndex: 1, pageInFile: 0 }, { fileIndex: 1, pageInFile: 1 }, { fileIndex: 1, pageInFile: 2 },
    ],
    total: 5,
    changed2: [true, false, true, true, false],
    changed3: [false, false, false, false, false],
  });
  S.phase = 2; S.page = 0; S.guarding = false;
  S.selFor = { 2: {}, 3: {} };
  S.expMode = "all"; S.expFile = 0;
}

beforeEach(reset);

describe("純粋ヘルパ", () => {
  it("counts は状態別に集計する", () => {
    expect(counts(["pending", "reviewed", "skipped", "none", "pending"]))
      .toEqual({ done: 1, skip: 1, pend: 2, none: 1 });
  });
  it("pass は all で常に通し、それ以外は一致のみ", () => {
    expect(pass("pending", "all")).toBe(true);
    expect(pass("pending", "pending")).toBe(true);
    expect(pass("reviewed", "pending")).toBe(false);
  });
  it("initStatus は changed から pending/none を導出する", () => {
    expect(initStatus([true, false])).toEqual(["pending", "none"]);
  });
});

describe("applyState", () => {
  it("FILE_START を累積ページ数で組む", () => {
    expect(S.FILE_START).toEqual([0, 2]);
  });
  it("status を changed から初期化し、キャッシュを破棄する", () => {
    expect(S.status2).toEqual(["pending", "none", "pending", "pending", "none"]);
    expect(S.svgCache).toEqual({});
    expect(S.elSel).toEqual({});
  });
  it("ページ数減少時は現在ページを 0 へ戻す", () => {
    S.page = 4;
    applyState({ files: [{ name: "a.pdf", pages: 1 }], pages: [{ fileIndex: 0, pageInFile: 0 }], total: 1, changed2: [false], changed3: [false] });
    expect(S.page).toBe(0);
  });

  it("同一ページ列の再取得は確認状態 (reviewed/skipped/pending) を保持する", () => {
    S.status2 = ["reviewed", "skipped", "pending", "pending", "none"];
    applyState({
      files: [{ name: "a.pdf", pages: 2 }, { name: "b.pdf", pages: 3 }],
      pages: [
        { fileIndex: 0, pageInFile: 0 }, { fileIndex: 0, pageInFile: 1 },
        { fileIndex: 1, pageInFile: 0 }, { fileIndex: 1, pageInFile: 1 }, { fileIndex: 1, pageInFile: 2 },
      ],
      total: 5,
      changed2: [true, true, true, true, false],
      changed3: [false, false, false, false, false],
    });
    expect(S.status2).toEqual(["reviewed", "skipped", "pending", "pending", "none"]);
  });

  it("changed2 が false→true になったページは pending、true→false は none へ倒す", () => {
    S.status2 = ["reviewed", "none", "pending", "pending", "none"];
    applyState({
      files: [{ name: "a.pdf", pages: 2 }, { name: "b.pdf", pages: 3 }],
      pages: [
        { fileIndex: 0, pageInFile: 0 }, { fileIndex: 0, pageInFile: 1 },
        { fileIndex: 1, pageInFile: 0 }, { fileIndex: 1, pageInFile: 1 }, { fileIndex: 1, pageInFile: 2 },
      ],
      total: 5,
      changed2: [false, true, true, true, false], // index0: true→false / index1: false→true
      changed3: [false, false, false, false, false],
    });
    expect(S.status2[0]).toBe("none");   // 変更が無くなった → none
    expect(S.status2[1]).toBe("pending"); // 新たに変更あり → pending
    expect(S.status2[2]).toBe("pending"); // 元々 pending のまま
  });

  it("ページ列が異なる (ファイル追加・削除) ときは initStatus で作り直す", () => {
    S.status2 = ["reviewed", "skipped"];
    applyState({
      files: [{ name: "c.pdf", pages: 3 }],
      pages: [
        { fileIndex: 0, pageInFile: 0 }, { fileIndex: 0, pageInFile: 1 }, { fileIndex: 0, pageInFile: 2 },
      ],
      total: 3,
      changed2: [true, false, true],
      changed3: [false, false, false],
    });
    expect(S.status2).toEqual(["pending", "none", "pending"]);
  });
});

describe("導出 (phase 別の別名参照と選択集合)", () => {
  it("statusArr/changedArr は phase で切り替わる", () => {
    expect(statusArr()).toBe(S.status2);
    expect(changedArr()).toBe(S.changed2);
    S.phase = 3;
    expect(statusArr()).toBe(S.status3);
    expect(changedArr()).toBe(S.changed3);
  });
  it("pkey/curElSel は現在ページの fi:pi をキーにする", () => {
    S.page = 2;
    expect(pkey()).toBe("1:0");
    curElSel().x = true;
    expect(S.elSel["1:0"]).toEqual({ x: true });
  });
  it("selKeys/selCount/clearSel は現在 phase の選択のみ扱う", () => {
    selSet()[0] = true; selSet()[3] = true;
    S.selFor[3][1] = true; // 別 phase の選択は無関係
    expect(selKeys().sort()).toEqual(["0", "3"]);
    expect(selCount()).toBe(2);
    clearSel();
    expect(selCount()).toBe(0);
    expect(S.selFor[3][1]).toBe(true);
  });
  it("statusOfCur は現在ページの状態を返す", () => {
    S.page = 1;
    expect(statusOfCur()).toBe("none");
  });
});

describe("遷移", () => {
  it("nextPending は現在位置の先を優先し、末尾まで無ければ先頭へ巻き戻る", () => {
    S.page = 2;
    expect(nextPending(S.status2)).toBe(3);
    S.status2[3] = "reviewed";
    expect(nextPending(S.status2)).toBe(0); // 巻き戻り
    S.status2[0] = "skipped"; S.status2[2] = "reviewed";
    expect(nextPending(S.status2)).toBe(-1);
  });
  it("firstPending は先頭から探し、無ければ 0", () => {
    expect(firstPending(S.status2)).toBe(0);
    S.status2 = ["reviewed", "none", "pending", "none", "none"];
    expect(firstPending(S.status2)).toBe(2);
    expect(firstPending(["none", "none", "none", "none", "none"])).toBe(0);
  });
  it("advancePhase は 2→3 (page リセット) → 4 と進み、ガードと遷移先の選択を解除する", () => {
    S.page = 4; S.guarding = true;
    S.selFor[3][1] = true; // clearSel は遷移「後」の phase の選択を消す (旧実装からの仕様)
    advancePhase();
    expect(S.phase).toBe(3);
    expect(S.page).toBe(0);
    expect(S.guarding).toBe(false);
    expect(Object.keys(S.selFor[3]).filter((k) => S.selFor[3][k])).toEqual([]);
    advancePhase();
    expect(S.phase).toBe(4);
  });
});

describe("書き出し範囲", () => {
  const parseSpecStub = (spec, max) => (spec === "1-2" ? [1, 2].filter((n) => n <= max) : []);

  it("all は全ページ", () => {
    expect(exportPageList("", parseSpecStub)).toHaveLength(5);
  });
  it("noskip はどちらかの手順でスキップしたページを除く", () => {
    S.expMode = "noskip";
    S.status2[1] = "skipped"; S.status3[4] = "skipped";
    expect(exportPageList("", parseSpecStub)).toHaveLength(3);
  });
  it("spec は指定ファイル内のページ番号列を fileIndex 付きで返す", () => {
    S.expMode = "spec"; S.expFile = 1;
    expect(exportPageList("1-2", parseSpecStub)).toEqual([
      { fileIndex: 1, pageInFile: 0 }, { fileIndex: 1, pageInFile: 1 },
    ]);
    S.expFile = 9; // 存在しないファイル
    expect(exportPageList("1-2", parseSpecStub)).toEqual([]);
  });
  it("expCount は page モードで 1 (ページがあれば)", () => {
    S.expMode = "page";
    expect(expCount("", parseSpecStub)).toBe(1);
  });
  it("zipName は単一ファイル由来なら元名を継ぎ、混在なら汎用名", () => {
    expect(zipName([{ fileIndex: 0 }, { fileIndex: 0 }])).toBe("a_svg.zip");
    expect(zipName([{ fileIndex: 0 }, { fileIndex: 1 }])).toBe("svg_export.zip");
  });
});
