// =============================================================================
// state.js — 4 ステップ状態機械の状態オブジェクトと遷移・導出ロジック (app.js から分離)
// =============================================================================
// 旧来 `app.js` のモジュールスコープに散在していた可変変数 (約 20 個) を単一の
// 状態オブジェクト `S` へ集約し、状態にしか触れない導出・遷移関数を同居させる。
// DOM には一切触れない (書き出し範囲のテキスト入力値などは引数で受ける) ため、
// vitest (`test/state.test.js`) が node 単体で状態機械を検証できる。
// 描画 (`render`) は呼ばない — 遷移後の再描画は呼び出し側 `app.js` の責務。

// ── 1. 状態オブジェクト (唯一の可変状態) ──

var S = {
  FILES: [],            // [{name, pages, size}]
  PAGES: [],            // [{fileIndex, pageInFile}] (全ファイル通しの平坦列)
  FILE_START: [],       // fileIndex -> 通し先頭ページ index
  TOTAL: 0,
  changed2: [], changed3: [],   // ページごとの「変更あり」(手順2=置換 / 手順3=削除)
  status2: [], status3: [],     // ページごとの確認状態 (pending/reviewed/skipped/none)
  phase: 1,             // ウィザード手順 (1=取込 / 2=置換 / 3=削除 / 4=書き出し)
  page: 0,              // 現在ページ (通し index)
  guarding: false,      // 未確認ガードバー表示中か
  filterFor: { 2: "all", 3: "pending" },
  selFor: { 2: {}, 3: {} },     // ページレール選択 (global idx -> true)
  collapsed: {},        // "step:fi" -> true (レールのファイル折り畳み)
  tool: "select",       // 手順3 ツール (select/crop/border)
  cropDrag: null,       // 範囲ドラッグ中の状態 {origin,rubber,mode}
  elSel: {},            // "fi:pi" -> {elId:true} (要素選択)
  svgCache: {},         // "fi:pi" -> {svg,width,height}
  zoomFor: { 2: 1, 3: 1 },      // 手順2/3 のキャンバス内ズーム倍率
  borderColor: "#000000",       // 枠線ツールの色
  borderWidth: 1,       // 枠線ツールの太さ (pt)
  expMode: "all",       // 書き出しモード: page/all/noskip/spec
  expFile: 0,           // spec モードの対象ファイル
};

// ── 2. 純粋ヘルパ (S 非依存) ──

function counts(arr) {
  var c = { done: 0, skip: 0, pend: 0, none: 0 };
  arr.forEach(function (s) {
    if (s === "reviewed") c.done++; else if (s === "skipped") c.skip++;
    else if (s === "pending") c.pend++; else c.none++;
  });
  return c;
}
function pass(st, filt) { return filt === "all" ? true : st === filt; }
function initStatus(ch) { return ch.map(function (c) { return c ? "pending" : "none"; }); }

// ── 3. 導出 (現在手順の別名参照・選択集合) ──

function statusArr() { return S.phase === 2 ? S.status2 : S.status3; }
function changedArr() { return S.phase === 2 ? S.changed2 : S.changed3; }
function selSet() { return (S.selFor[S.phase] = S.selFor[S.phase] || {}); }
function pkey() { var pg = S.PAGES[S.page]; return pg.fileIndex + ":" + pg.pageInFile; }
function curElSel() { var k = pkey(); return (S.elSel[k] = S.elSel[k] || {}); }
function statusOfCur() { return statusArr()[S.page]; }
function selKeys() { var s = selSet(); return Object.keys(s).filter(function (k) { return s[k]; }); }
function selCount() { return selKeys().length; }
function clearSel() { var s = selSet(); Object.keys(s).forEach(function (k) { delete s[k]; }); }

// ── 4. 状態遷移 ──

/** サーバの `state` RPC 結果を取り込み、派生列 (status/FILE_START) とキャッシュを組み直す */
function applyState(st) {
  S.FILES = st.files; S.PAGES = st.pages; S.TOTAL = st.total;
  S.changed2 = st.changed2; S.changed3 = st.changed3;
  S.status2 = initStatus(S.changed2); S.status3 = initStatus(S.changed3);
  S.FILE_START = []; var s = 0;
  S.FILES.forEach(function (f, i) { S.FILE_START[i] = s; s += f.pages; });
  S.svgCache = {}; S.elSel = {};
  if (S.page >= S.TOTAL) S.page = 0;
}

/** 現在ページの次の「要確認」ページ (現在位置から一巡)。無ければ -1 */
function nextPending(arr) {
  for (var i = S.page + 1; i < S.TOTAL; i++) if (arr[i] === "pending") return i;
  for (var j = 0; j < S.page; j++) if (arr[j] === "pending") return j;
  return -1;
}
/** 先頭から最初の「要確認」ページ。無ければ 0 */
function firstPending(arr) { for (var i = 0; i < S.TOTAL; i++) if (arr[i] === "pending") return i; return 0; }

/** 手順を 1 つ進める (2→3 / 3→4)。ガード解除・選択クリアも行う。再描画は呼び出し側 */
function advancePhase() {
  S.guarding = false;
  if (S.phase === 2) { S.phase = 3; S.page = 0; } else if (S.phase === 3) S.phase = 4;
  clearSel();
}

// ── 5. 書き出し範囲の算出 (spec 入力値は引数で受ける — DOM 非依存) ──

/** 現在のモードで書き出す [{fileIndex, pageInFile}] を返す (page モードは対象外) */
function exportPageList(specValue, parseSpecFn) {
  if (S.expMode === "all") return S.PAGES.slice();
  if (S.expMode === "noskip") {
    return S.PAGES.filter(function (pg, g) { return S.status2[g] !== "skipped" && S.status3[g] !== "skipped"; });
  }
  if (S.expMode === "spec") {
    var fi = S.expFile; if (!S.FILES[fi]) return [];
    return parseSpecFn(specValue, S.FILES[fi].pages)
      .map(function (n) { return { fileIndex: fi, pageInFile: n - 1 }; });
  }
  return []; // page モードは exportPage を使うため対象外
}

function expCount(specValue, parseSpecFn) {
  return S.expMode === "page" ? (S.TOTAL ? 1 : 0) : exportPageList(specValue, parseSpecFn).length;
}

/** ZIP のファイル名。対象が 1 PDF ならその名前を継ぎ、複数ファイル混在なら汎用名にする */
function zipName(list) {
  var fis = {};
  list.forEach(function (it) { fis[it.fileIndex] = 1; });
  var keys = Object.keys(fis);
  if (keys.length === 1 && S.FILES[+keys[0]]) {
    return S.FILES[+keys[0]].name.replace(/\.pdf$/i, "") + "_svg.zip";
  }
  return "svg_export.zip";
}

export {
  S, counts, pass, initStatus,
  statusArr, changedArr, selSet, pkey, curElSel, statusOfCur, selKeys, selCount, clearSel,
  applyState, nextPending, firstPending, advancePhase,
  exportPageList, expCount, zipName,
};
