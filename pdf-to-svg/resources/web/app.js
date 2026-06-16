// PdfToSvg フロントエンド。モックの 4 ステップ状態機械を踏襲しつつ、データ・
// ページ描画・編集・書き出しを Python バックエンド (window.rpc) に接続する。
(function () {
  "use strict";

  var app = document.getElementById("app");

  // ---- アイコン ----
  function svg(p, w, sw) {
    return '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="' +
      (sw || 1.7) + '" stroke-linecap="round" stroke-linejoin="round"' +
      (w ? ' style="width:' + w + 'px;height:' + w + 'px"' : "") + ">" + p + "</svg>";
  }
  var fileIcon = '<path d="M6 3.5A1.5 1.5 0 0 1 7.5 2h6L19 7.5v13A1.5 1.5 0 0 1 17.5 22h-10A1.5 1.5 0 0 1 6 20.5V3.5Z"/><path d="M13 2v6h6"/>';
  var xIcon = '<path d="m6 6 12 12M18 6 6 18"/>';
  var chevD = '<path d="m10 6 6 6-6 6"/>';
  var checkD = "m4.5 12.5 5 5 10-11";
  var ckMark = svg('<path d="' + checkD + '"/>', 11, 2.4);
  var checkDot = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="' + checkD + '"/></svg>';
  var skipDot = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 8l4 4-4 4M15 8v8"/></svg>';

  // ---- 状態 ----
  var FILES = [], PAGES = [], FILE_START = [], TOTAL = 0;
  var changed2 = [], changed3 = [], status2 = [], status3 = [];
  var phase = 1, page = 0, guarding = false;
  var filterFor = { 2: "all", 3: "pending" };
  var selFor = { 2: {}, 3: {} };       // ページレール選択 (global idx -> true)
  var collapsed = {};                  // step:fi -> true
  var tool = "select";                 // 手順3 ツール
  var cropDrag = null;                 // クロップ範囲ドラッグ中の状態 {origin,rubber}
  var elSel = {};                      // 'fi:pi' -> {elId:true}  (要素選択)
  var svgCache = {};                   // 'fi:pi' -> {svg,width,height,cropped}

  var FILTERS = [
    { v: "pending", t: "要確認" }, { v: "all", t: "すべて" },
    { v: "reviewed", t: "確認済み" }, { v: "skipped", t: "スキップ" }, { v: "none", t: "変更なし" },
  ];
  var STAT = { reviewed: "確認済み", skipped: "スキップ", pending: "要確認", none: "変更なし" };

  function statusArr() { return phase === 2 ? status2 : status3; }
  function changedArr() { return phase === 2 ? changed2 : changed3; }
  function selSet() { return (selFor[phase] = selFor[phase] || {}); }
  function pkey() { var pg = PAGES[page]; return pg.fileIndex + ":" + pg.pageInFile; }
  function curElSel() { var k = pkey(); return (elSel[k] = elSel[k] || {}); }

  function counts(arr) {
    var c = { done: 0, skip: 0, pend: 0, none: 0 };
    arr.forEach(function (s) {
      if (s === "reviewed") c.done++; else if (s === "skipped") c.skip++;
      else if (s === "pending") c.pend++; else c.none++;
    });
    return c;
  }
  function statusOfCur() { return statusArr()[page]; }
  function pass(st, filt) { return filt === "all" ? true : st === filt; }
  function selKeys() { var s = selSet(); return Object.keys(s).filter(function (k) { return s[k]; }); }
  function selCount() { return selKeys().length; }
  function clearSel() { var s = selSet(); Object.keys(s).forEach(function (k) { delete s[k]; }); }
  function initStatus(ch) { return ch.map(function (c) { return c ? "pending" : "none"; }); }

  // ---- ファイル入出力 (File System Access API) ----
  // http://127.0.0.1 は secure context のため showOpenFilePicker 等が使える。
  // 非対応ブラウザでは <input type=file> / <a download> へフォールバックする。
  function hasFsOpen() { return typeof window.showOpenFilePicker === "function"; }
  function hasFsSave() { return typeof window.showSaveFilePicker === "function"; }

  async function pickPdfFiles() {
    if (hasFsOpen()) {
      try {
        var handles = await window.showOpenFilePicker({
          multiple: true,
          types: [{ description: "PDF", accept: { "application/pdf": [".pdf"] } }],
        });
        return await Promise.all(handles.map(function (h) { return h.getFile(); }));
      } catch (e) { if (e && e.name === "AbortError") return []; throw e; }
    }
    return new Promise(function (resolve) {
      var inp = document.createElement("input");
      inp.type = "file"; inp.accept = ".pdf,application/pdf"; inp.multiple = true;
      inp.addEventListener("change", function () { resolve([].slice.call(inp.files)); });
      inp.click();
    });
  }

  async function uploadPdf(name, buf) {
    var res = await fetch("/upload?name=" + encodeURIComponent(name), {
      method: "POST",
      headers: { "Content-Type": "application/octet-stream" },
      body: buf,
    });
    var j = await res.json();
    if (!j.ok) throw new Error(j.error || "アップロードに失敗しました");
    return j.data;
  }

  function downloadBlob(name, text, mime) {
    var url = URL.createObjectURL(new Blob([text], { type: mime || "application/octet-stream" }));
    var a = document.createElement("a");
    a.href = url; a.download = name; document.body.appendChild(a); a.click();
    setTimeout(function () { a.remove(); URL.revokeObjectURL(url); }, 1000);
  }

  // 1 ファイルを保存。成功で true、ユーザーがキャンセルしたら false。FSA 非対応は download。
  async function saveTextFile(suggestedName, text, descr, mime, ext) {
    if (hasFsSave()) {
      try {
        var accept = {}; accept[mime] = [ext];
        var h = await window.showSaveFilePicker({ suggestedName: suggestedName, types: [{ description: descr, accept: accept }] });
        var w = await h.createWritable(); await w.write(text); await w.close();
        return true;
      } catch (e) { if (e && e.name === "AbortError") return false; throw e; }
    }
    downloadBlob(suggestedName, text, mime); return true;
  }

  // 1 ファイルを開いて File を返す。キャンセルで null。
  async function pickOneFile(descr, mime, ext) {
    if (hasFsOpen()) {
      try {
        var accept = {}; accept[mime] = [ext];
        var hs = await window.showOpenFilePicker({ multiple: false, types: [{ description: descr, accept: accept }] });
        return await hs[0].getFile();
      } catch (e) { if (e && e.name === "AbortError") return null; throw e; }
    }
    return new Promise(function (resolve) {
      var inp = document.createElement("input");
      inp.type = "file"; inp.accept = ext + "," + mime;
      inp.addEventListener("change", function () { resolve(inp.files[0] || null); });
      inp.click();
    });
  }

  // 保存先フォルダを選ぶ。FSA: ディレクトリハンドル / 非対応: "download" / キャンセル: null。
  async function pickSaveDir() {
    if (typeof window.showDirectoryPicker === "function") {
      try { return await window.showDirectoryPicker({ mode: "readwrite" }); }
      catch (e) { if (e && e.name === "AbortError") return null; throw e; }
    }
    return "download";
  }

  async function writeIntoDir(dir, name, text) {
    if (dir === "download") { downloadBlob(name, text, "image/svg+xml"); return; }
    var h = await dir.getFileHandle(name, { create: true });
    var w = await h.createWritable(); await w.write(text); await w.close();
  }

  // ---- 読み込み ----
  function applyState(st) {
    FILES = st.files; PAGES = st.pages; TOTAL = st.total;
    changed2 = st.changed2; changed3 = st.changed3;
    status2 = initStatus(changed2); status3 = initStatus(changed3);
    FILE_START = []; var s = 0;
    FILES.forEach(function (f, i) { FILE_START[i] = s; s += f.pages; });
    svgCache = {}; elSel = {};
    if (page >= TOTAL) page = 0;
  }

  async function reloadState() { applyState(await rpc("state")); }

  async function doLoad() {
    var files = await pickPdfFiles();
    if (!files || !files.length) { render(); return; }
    for (var i = 0; i < files.length; i++) {
      setHint("読み込み中 " + (i + 1) + "/" + files.length + ": " + esc(files[i].name));
      var buf = await files[i].arrayBuffer();
      await uploadPdf(files[i].name, buf);
    }
    await reloadState();
    renderFileCards();
    render();
  }

  // ---- (1) ファイルカード ----
  function renderFileCards() {
    document.getElementById("filelist-count").textContent =
      FILES.length + " ファイル・" + TOTAL + " ページ";
    document.getElementById("file-cards").innerHTML = FILES.map(function (f) {
      return '<div class="file-card"><div class="fic">' + svg(fileIcon, 20) +
        '</div><div class="fmeta"><div class="fname">' + esc(f.name) + '</div><div class="fsub">' +
        f.pages + " ページ" + (f.size ? " ・ " + f.size : "") + "</div></div></div>";
    }).join("");
  }
  function esc(s) { return String(s).replace(/[&<>"]/g, function (c) {
    return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]; }); }

  // ---- ページ SVG ----
  async function ensureSvg(fi, pi) {
    var k = fi + ":" + pi;
    if (!svgCache[k]) svgCache[k] = await rpc("pageSvg", { fileIndex: fi, pageInFile: pi });
    return svgCache[k];
  }
  function invalidate(fi, pi) { delete svgCache[fi + ":" + pi]; }

  function scalePage(svgEl, w, h, editorEl) {
    var avW = Math.max(120, editorEl.clientWidth - 90);
    var avH = Math.max(120, editorEl.clientHeight - 96);
    var sc = Math.min(avW / w, avH / h);
    sc = Math.max(0.05, Math.min(sc, 3));
    svgEl.style.width = (w * sc) + "px";
    svgEl.style.height = (h * sc) + "px";
  }

  // host に現在ページの SVG を載せる。token で古い await を破棄。
  async function mountPage(host, editorEl, withSelect) {
    var pg = PAGES[page];
    var token = pg.fileIndex + ":" + pg.pageInFile + ":" + Date.now();
    host.dataset.token = token;
    var data = await ensureSvg(pg.fileIndex, pg.pageInFile);
    if (host.dataset.token !== token) return; // ページが変わった
    host.classList.remove("empty");
    host.innerHTML = data.svg;
    var svgEl = host.querySelector("svg");
    if (svgEl) scalePage(svgEl, data.width, data.height, editorEl);
    if (withSelect) { drawSelBoxes(host); }
  }

  // ---- 左：ページ一覧 (モック踏襲) ----
  function buildRail(navId) {
    var arr = statusArr(); var filt = filterFor[phase]; var sel = selSet(); var c = counts(arr);
    var html = "";
    html += '<div class="pl-head">';
    html += '<div class="pl-title">全 <b>' + TOTAL + "</b> ページ　要確認 <b>" + c.pend + "</b></div>";
    html += '<select class="pl-filter">' + FILTERS.map(function (f) {
      return '<option value="' + f.v + '"' + (f.v === filt ? " selected" : "") + ">" + f.t + "</option>"; }).join("") + "</select>";
    var visSelectable = [];
    PAGES.forEach(function (pg, g) { if (pass(arr[g], filt) && arr[g] !== "none") visSelectable.push(g); });
    var allSel = visSelectable.length > 0 && visSelectable.every(function (g) { return sel[g]; });
    html += '<label class="pl-all"><span class="ck' + (allSel ? " on" : "") + '" data-all="1">' + (allSel ? ckMark : "") + "</span>表示中をすべて選択</label>";
    html += '<button class="pl-skipall" data-skipall="1">' + svg('<path d="M9 8l4 4-4 4M15 8v8"/>', 15, 1.9) + "未確認をまとめてスキップ</button>";
    if (PAGES.length) {
      var curFile = FILES[PAGES[page].fileIndex];
      html += '<div class="pl-range"><div class="rg-lab">範囲で指定（' + esc(curFile.name) + "）</div>" +
        '<div class="rg-row"><input class="rg-from" type="number" min="1" max="' + curFile.pages + '" placeholder="1"> 〜 ' +
        '<input class="rg-to" type="number" min="1" max="' + curFile.pages + '" placeholder="' + curFile.pages + '"> ページを</div>' +
        '<div class="rg-row"><select class="rg-act"><option value="skipped">スキップ</option><option value="reviewed">確認済みに</option></select>' +
        '<button class="rg-go" data-rg="1">適用</button></div></div>';
    }
    html += "</div>";
    if (selCount() > 0) {
      html += '<div class="pl-selbar"><span><b>' + selCount() + "</b> 件を選択中</span><div class=\"selrow\">" +
        '<button data-bulk="done">確認済み</button><button data-bulk="skip">スキップ</button><button data-bulk="clear">解除</button></div></div>';
    }
    html += '<div class="pl-body">';
    var g = 0, anyRow = false;
    FILES.forEach(function (f, fi) {
      var idxs = [];
      for (var p = 0; p < f.pages; p++) { var gg = g + p; if (pass(arr[gg], filt)) idxs.push(gg); }
      if (idxs.length === 0) { g += f.pages; return; }
      anyRow = true;
      var key = phase + ":" + fi; var isColl = !!collapsed[key];
      var selectable = idxs.filter(function (i) { return arr[i] !== "none"; });
      var fileSel = selectable.length > 0 && selectable.every(function (i) { return sel[i]; });
      html += '<div class="pl-file' + (isColl ? " collapsed" : "") + '">' +
        '<span class="ck' + (fileSel ? " on" : "") + '" data-fileck="' + fi + '">' + (fileSel ? ckMark : "") + "</span>" +
        '<span class="fname" data-fcoll="' + fi + '">' + svg(fileIcon, 13).replace("<svg", '<svg class="fic"') + esc(f.name) + "</span>" +
        '<span class="fcount">' + idxs.length + "</span>" +
        '<span class="fchev" data-fcoll="' + fi + '">' + svg(chevD, 15) + "</span></div>";
      if (!isColl) {
        idxs.forEach(function (gg) {
          var off = gg - g; var st = arr[gg];
          var cls = st === "reviewed" ? "done" : (st === "skipped" ? "skipped" : (st === "pending" ? "pending" : "none"));
          var dot = st === "reviewed" ? checkDot : (st === "skipped" ? skipDot : (off + 1));
          var ckbox = st !== "none"
            ? '<span class="ck row-ck' + (sel[gg] ? " on" : "") + '" data-ck="' + gg + '">' + (sel[gg] ? ckMark : "") + "</span>"
            : '<span style="width:17px;flex:none"></span>';
          html += '<div class="pg-row2 ' + cls + (gg === page ? " current" : "") + '" data-g="' + gg + '">' +
            ckbox + '<span class="dot">' + dot + '</span><span class="lbl">' + (off + 1) + " ページ</span>" +
            '<span class="tg t-' + cls + '">' + STAT[st] + "</span></div>";
        });
      }
      g += f.pages;
    });
    if (!anyRow) html += '<div class="empty-note" style="padding:48px 16px"><div class="ei">' + svg('<path d="' + checkD + '"/>', 24, 2) + '</div><div class="et">このフィルタに該当するページはありません</div></div>';
    html += "</div>";
    document.getElementById(navId).innerHTML = html;
    wireRail(navId, visSelectable);
  }

  function wireRail(navId, visSelectable) {
    var nav = document.getElementById(navId);
    var arr = statusArr(); var sel = selSet();
    nav.querySelector(".pl-filter").addEventListener("change", function () { filterFor[phase] = this.value; render(); });
    nav.querySelector("[data-all]").addEventListener("click", function () {
      var allSel = visSelectable.length > 0 && visSelectable.every(function (g) { return sel[g]; });
      visSelectable.forEach(function (g) { if (allSel) delete sel[g]; else sel[g] = true; });
      render();
    });
    nav.querySelector("[data-skipall]").addEventListener("click", function () {
      for (var g = 0; g < TOTAL; g++) if (arr[g] === "pending") arr[g] = "skipped";
      tryNext(); // 全スキップ後はそのまま次のステップへ進む
    });
    var rg = nav.querySelector("[data-rg]");
    if (rg) rg.addEventListener("click", function () {
      var fi = PAGES[page].fileIndex; var start = FILE_START[fi]; var fp = FILES[fi].pages;
      var from = parseInt(nav.querySelector(".rg-from").value, 10) || 1;
      var to = parseInt(nav.querySelector(".rg-to").value, 10) || fp;
      if (from > to) { var t = from; from = to; to = t; }
      from = Math.max(1, Math.min(fp, from)); to = Math.max(1, Math.min(fp, to));
      var act = nav.querySelector(".rg-act").value;
      for (var pp = from; pp <= to; pp++) { var gg = start + (pp - 1); if (arr[gg] !== "none") arr[gg] = act; }
      render();
    });
    var selbar = nav.querySelector(".pl-selbar");
    if (selbar) selbar.querySelectorAll("[data-bulk]").forEach(function (b) {
      b.addEventListener("click", function () {
        var k = b.dataset.bulk;
        if (k === "clear") clearSel();
        else { selKeys().forEach(function (g) { arr[+g] = k === "done" ? "reviewed" : "skipped"; }); clearSel(); }
        render();
      });
    });
    nav.querySelectorAll("[data-fileck]").forEach(function (el) {
      el.addEventListener("click", function (e) {
        e.stopPropagation();
        var fi = +el.dataset.fileck; var start = FILE_START[fi]; var idxs = [];
        for (var p = 0; p < FILES[fi].pages; p++) { var gg = start + p; if (pass(arr[gg], filterFor[phase]) && arr[gg] !== "none") idxs.push(gg); }
        var allSel = idxs.length > 0 && idxs.every(function (g) { return sel[g]; });
        idxs.forEach(function (g) { if (allSel) delete sel[g]; else sel[g] = true; });
        render();
      });
    });
    nav.querySelectorAll("[data-fcoll]").forEach(function (el) {
      el.addEventListener("click", function (e) {
        e.stopPropagation(); collapsed[phase + ":" + el.dataset.fcoll] = !collapsed[phase + ":" + el.dataset.fcoll]; render();
      });
    });
    nav.querySelectorAll(".row-ck").forEach(function (el) {
      el.addEventListener("click", function (e) {
        e.stopPropagation(); var g = +el.dataset.ck; if (sel[g]) delete sel[g]; else sel[g] = true; render();
      });
    });
    nav.querySelectorAll(".pg-row2").forEach(function (r) {
      r.addEventListener("click", function () { page = +r.dataset.g; render(); });
    });
  }

  function renderSummary(id, arr) {
    var c = counts(arr);
    document.getElementById(id).innerHTML =
      '<span class="si"><span class="d pend"></span>要確認 <b>' + c.pend + "</b></span>" +
      '<span class="si"><span class="d done"></span>確認済み <b>' + c.done + "</b></span>" +
      '<span class="si"><span class="d skip"></span>スキップ <b>' + c.skip + "</b></span>" +
      '<span class="si"><span class="d pend" style="background:var(--border-strong)"></span>変更なし <b>' + c.none + "</b></span>";
  }

  // ---- 確認ペイン (手順2) ----
  async function renderConfirm() {
    var el = document.getElementById("confirm-dyn");
    var ed2 = app.querySelector('[data-screen="2"] .editor');
    if (!changed2[page]) {
      ed2.classList.add("nochange");
      el.innerHTML = noChangeNote("このページに置換はありません");
      return;
    }
    ed2.classList.remove("nochange");
    var pg = PAGES[page];
    var token = pg.fileIndex + ":" + pg.pageInFile;
    var data = await rpc("planPage", { fileIndex: pg.fileIndex, pageInFile: pg.pageInFile });
    if (token !== PAGES[page].fileIndex + ":" + PAGES[page].pageInFile) return; // ページが変わった
    var rows = data.changes.map(function (ch) {
      return '<div class="change-row" data-el="' + ch.elId + '"><span class="loc">' + esc(ch.loc) + '</span><span class="pair"><span class="from">' +
        esc(ch.source) + "</span>" + svg('<path d="M4 12h15M13 6l6 6-6 6"/>', 15) + '<span class="to">' + esc(ch.target) + "</span></span>" +
        svg(chevD, 16).replace("currentColor", "var(--faint)") + "</div>";
    }).join("");
    el.innerHTML =
      '<div class="confirm-banner"><span class="ic">' + svg('<path d="' + checkD + '"/>', 22, 2.2) + '</span><div><div class="t">このページで ' +
      data.changes.length + ' 件を置換</div><div class="s">表ヘッダ等の用語を辞書で置換しました</div></div></div>' +
      '<div style="display:flex;flex-direction:column;min-height:0;flex:1;"><div class="field-label">変更の一覧（クリックで該当箇所へ）</div><div class="change-list">' +
      rows + "</div></div>";
    el.querySelectorAll(".change-row[data-el]").forEach(function (row) {
      row.addEventListener("click", function () { flashElement("doc-master", row.dataset.el); });
    });
  }
  function noChangeNote(msg) {
    return '<div class="empty-note"><div class="ei">' + svg('<circle cx="12" cy="12" r="9"/><path d="M8 12h8"/>', 24) +
      '</div><div class="et">' + esc(msg) + "</div></div>";
  }

  function flashElement(hostId, elId) {
    var host = document.getElementById(hostId);
    var svgEl = host.querySelector("svg"); if (!svgEl) return;
    var target = svgEl.querySelector('[data-el="' + elId + '"]'); if (!target) return;
    var hb = host.getBoundingClientRect(); var tb = target.getBoundingClientRect();
    var box = document.createElement("div");
    box.className = "sel-box";
    box.style.left = (tb.left - hb.left - 3) + "px"; box.style.top = (tb.top - hb.top - 3) + "px";
    box.style.width = (tb.width + 6) + "px"; box.style.height = (tb.height + 6) + "px";
    box.style.transition = "opacity .9s ease"; host.appendChild(box);
    setTimeout(function () { box.style.opacity = "0"; }, 350);
    setTimeout(function () { box.remove(); }, 1300);
  }

  // ---- 削除ペイン (手順3) ----
  async function renderTrim() {
    var el = document.getElementById("trim-dyn");
    var ed3 = app.querySelector('[data-screen="3"] .editor');
    ed3.classList.remove("nochange");
    var pg = PAGES[page];
    var token = pg.fileIndex + ":" + pg.pageInFile;
    var data = await rpc("removedList", { fileIndex: pg.fileIndex, pageInFile: pg.pageInFile });
    if (token !== PAGES[page].fileIndex + ":" + PAGES[page].pageInFile) return; // ページが変わった
    var n = data.removed.length;
    var head = '<div class="field-label">このページで削除した要素（' + n + "）" + (data.cropped ? " ・ クロップあり" : "") + "</div>";
    if (n === 0 && !data.cropped) {
      el.innerHTML = head + '<div class="empty-note" style="flex:1"><div class="et" style="color:var(--faint)">要素を選んで「削除」、または「クロップ」で残す範囲を指定します。</div></div>';
      return;
    }
    var rows = data.removed.map(function (r) {
      return '<div class="removed-row"><span class="ric">' + svg('<path d="M4 7h16M6 7v12.5A1.5 1.5 0 0 0 7.5 21h9a1.5 1.5 0 0 0 1.5-1.5V7"/>', 15) +
        '</span><span class="rlabel">' + esc(r.label) + '</span><button class="pa-link" data-restore="' + r.elId + '">戻す</button></div>';
    }).join("");
    el.innerHTML = head + '<div class="change-list">' + rows + "</div>";
    el.querySelectorAll("[data-restore]").forEach(function (b) {
      b.addEventListener("click", async function () {
        await rpc("undo"); // 直近の削除を取り消す簡易対応
        await afterEdit();
      });
    });
  }

  // ---- 手順3 エディタ操作 ----
  function drawSelBoxes(host) {
    host.querySelectorAll(".sel-box").forEach(function (b) { b.remove(); });
    var svgEl = host.querySelector("svg"); if (!svgEl) return;
    var sel = curElSel(); var hb = host.getBoundingClientRect();
    Object.keys(sel).forEach(function (id) {
      var t = svgEl.querySelector('[data-el="' + id + '"]'); if (!t) return;
      var tb = t.getBoundingClientRect();
      var box = document.createElement("div"); box.className = "sel-box";
      box.style.left = (tb.left - hb.left - 2) + "px"; box.style.top = (tb.top - hb.top - 2) + "px";
      box.style.width = (tb.width + 4) + "px"; box.style.height = (tb.height + 4) + "px";
      host.appendChild(box);
    });
  }

  function clientToPage(svgEl, clientX, clientY) {
    var r = svgEl.getBoundingClientRect();
    var vb = svgEl.viewBox.baseVal;
    return {
      x: vb.x + (clientX - r.left) / r.width * vb.width,
      y: vb.y + (clientY - r.top) / r.height * vb.height,
    };
  }

  // 選択モードのクリック結線のみ。SVG は mountPage で毎回差し替わるため漏れない。
  // crop ドラッグのリスナーは wireStatic で一度だけ張る (多重登録防止)。
  function wireTrimStage() {
    if (tool !== "select") return;
    var host = document.getElementById("trim-stage");
    var svgEl = host.querySelector("svg"); if (!svgEl) return;
    svgEl.addEventListener("click", function (e) {
      var t = e.target.closest("[data-el]"); if (!t) return;
      var id = t.getAttribute("data-el"); var sel = curElSel();
      if (sel[id]) delete sel[id]; else sel[id] = true;
      drawSelBoxes(host);
    });
  }

  // crop ツール: ドラッグした矩形に重なる要素を範囲削除。リスナーは起動時に一度だけ設置し、
  // イベント時に phase/tool を判定する (render の度に張り直さない)。
  function installCropDrag() {
    var host = document.getElementById("trim-stage");
    host.addEventListener("mousedown", function (e) {
      if (phase !== 3 || tool !== "crop") return;
      if (!host.querySelector("svg")) return;
      var rubber = document.createElement("div"); rubber.className = "crop-rubber"; host.appendChild(rubber);
      cropDrag = { origin: { x: e.clientX, y: e.clientY }, rubber: rubber };
      e.preventDefault();
    });
    window.addEventListener("mousemove", function (e) {
      if (!cropDrag) return;
      var hb = host.getBoundingClientRect();
      var x1 = Math.min(cropDrag.origin.x, e.clientX), y1 = Math.min(cropDrag.origin.y, e.clientY);
      var x2 = Math.max(cropDrag.origin.x, e.clientX), y2 = Math.max(cropDrag.origin.y, e.clientY);
      cropDrag.rubber.style.left = (x1 - hb.left) + "px"; cropDrag.rubber.style.top = (y1 - hb.top) + "px";
      cropDrag.rubber.style.width = (x2 - x1) + "px"; cropDrag.rubber.style.height = (y2 - y1) + "px";
    });
    window.addEventListener("mouseup", async function (e) {
      if (!cropDrag) return;
      var d = cropDrag; cropDrag = null; d.rubber.remove();
      var svgEl = host.querySelector("svg"); if (!svgEl) return;
      var a = clientToPage(svgEl, d.origin.x, d.origin.y);
      var b = clientToPage(svgEl, e.clientX, e.clientY);
      var x = Math.min(a.x, b.x), y = Math.min(a.y, b.y);
      var w = Math.abs(a.x - b.x), h = Math.abs(a.y - b.y);
      if (w < 4 || h < 4) return;
      var pg = PAGES[page];
      await rpc("deleteRegion", { fileIndex: pg.fileIndex, pageInFile: pg.pageInFile, rect: { x: x, y: y, w: w, h: h } });
      await afterEdit();
    });
  }

  async function afterEdit() {
    var pg = PAGES[page];
    invalidate(pg.fileIndex, pg.pageInFile);
    curElSel(); elSel[pkey()] = {};
    render();
  }

  // ---- ページ単位アクション ----
  function pageActHTML() {
    var st = statusOfCur();
    if (st === "none") return '<div class="pa-prompt" style="margin:0">このページは変更がないため操作は不要です</div>';
    if (st === "reviewed") return '<div class="pa-badge good">' + svg('<path d="' + checkD + '"/>', 17) + 'このページは確認済み</div><button class="pa-link" data-pa="reset">取り消す</button>';
    if (st === "skipped") return '<div class="pa-badge warn">' + svg('<path d="M9 8l4 4-4 4M15 8v8"/>', 17) + 'このページはスキップ</div><button class="pa-link" data-pa="review">確認する</button>';
    return '<div class="pa-prompt">' + (phase === 2 ? "このページの置換を確認、または不要ならスキップ" : "このページを確認、または不要ならスキップ") + "</div>" +
      '<div class="pa-btns"><button class="btn ghost" data-pa="skip">スキップ</button><button class="btn primary" data-pa="done">' + (phase === 2 ? "確認しました" : "確認しました") + "</button></div>";
  }
  function nextPending(arr) {
    for (var i = page + 1; i < TOTAL; i++) if (arr[i] === "pending") return i;
    for (var j = 0; j < page; j++) if (arr[j] === "pending") return j;
    return -1;
  }
  function onPageAct(actv) {
    var arr = statusArr();
    if (actv === "done") { arr[page] = "reviewed"; var n1 = nextPending(arr); if (n1 >= 0) page = n1; }
    else if (actv === "skip") { arr[page] = "skipped"; var n2 = nextPending(arr); if (n2 >= 0) page = n2; }
    else { arr[page] = "pending"; }
    render();
  }
  function renderPageAct() {
    var el = document.getElementById(phase === 2 ? "pageact-2" : "pageact-3");
    el.innerHTML = pageActHTML();
    el.querySelectorAll("[data-pa]").forEach(function (b) { b.addEventListener("click", function () { onPageAct(b.dataset.pa); }); });
  }
  function pageLabel() { var pg = PAGES[page]; return "<b>" + esc(FILES[pg.fileIndex].name) + "</b> ・ " + (pg.pageInFile + 1) + " ページ"; }

  // ---- 辞書ペイン ----
  var dictState = { entries: [], onlyHeaders: true };
  async function loadDict() {
    dictState = await rpc("dictList");
    renderDict();
  }
  function renderDict() {
    document.getElementById("dict-count").textContent = "登録済みの用語（" + dictState.entries.length + "）";
    document.getElementById("dict-rows").innerHTML = dictState.entries.map(function (m) {
      return '<div class="dict-row" data-id="' + m.id + '"><span class="src">' + esc(m.source) + '</span><span class="arr">' +
        svg('<path d="M4 12h15"/><path d="m13 6 6 6-6 6"/>', 14) + '</span><span class="tgt">' + esc(m.target) + "</span>" +
        '<button class="iconbtn" data-del="' + m.id + '" title="削除" style="width:26px;height:26px">' + svg(xIcon, 15) + "</button></div>";
    }).join("");
    document.getElementById("dict-rows").querySelectorAll("[data-del]").forEach(function (b) {
      b.addEventListener("click", async function () {
        dictState = await rpc("dictDelete", { id: +b.dataset.del }); renderDict();
      });
    });
    var chk = document.getElementById("chk-headers");
    chk.querySelector(".box").classList.toggle("on", !!dictState.onlyHeaders);
  }

  // 手順2 のパネルタブ切替 (タブクリック・機能1 の双方から使う)
  function activateTab(name) {
    app.querySelectorAll(".panel-tab").forEach(function (t) {
      t.setAttribute("aria-selected", t.dataset.tab === name ? "true" : "false");
    });
    app.querySelectorAll('[data-screen="2"] .tabpane').forEach(function (p) {
      p.classList.toggle("on", p.dataset.pane === name);
    });
    if (name === "dict") loadDict();
  }

  // 機能1: 手順2 のページ上の文字クリック → 「元の語」に取り込む
  function wireConfirmPick() {
    var host = document.getElementById("doc-master");
    var svgEl = host.querySelector("svg");
    if (!svgEl) return;
    svgEl.addEventListener("click", function (e) {
      var t = e.target.closest("[data-el]");
      if (!t || t.tagName.toLowerCase() !== "text") return;
      var txt = (t.textContent || "").trim();
      if (!txt) return;
      activateTab("dict");
      document.getElementById("dict-src").value = txt;
      document.getElementById("dict-tgt").focus();
      flashElement("doc-master", t.getAttribute("data-el"));
    });
  }

  // ---- 描画 ----
  function setHint(html) { document.getElementById("nav-hint").innerHTML = html; }

  function render() {
    var steps = [].slice.call(app.querySelectorAll("#stepbar .step"));
    var screens = [].slice.call(app.querySelectorAll(".screen"));
    var btnBack = document.getElementById("btn-back");
    var btnNext = document.getElementById("btn-next");
    var btnExport = document.getElementById("btn-export");
    var ctxText = document.getElementById("ctx-text");
    var guard = document.getElementById("guard");

    screens.forEach(function (s) { s.classList.toggle("on", +s.dataset.screen === phase); });
    steps.forEach(function (st) {
      var n = +st.dataset.step; var done = n < phase, active = n === phase;
      st.classList.toggle("done", done); st.classList.toggle("active", active);
      st.classList.toggle("future", !done && !active); st.classList.toggle("clickable", n <= phase);
      st.querySelector(".n").innerHTML = done ? ckMark : n;
    });
    if (guarding && (phase === 2 || phase === 3)) {
      var gpend = counts(statusArr()).pend;
      if (gpend === 0) guarding = false;            // 未確認0 → ガードを閉じる
      else document.getElementById("guard-n").textContent = gpend; // 件数を最新に
    }
    guard.hidden = !guarding;
    btnBack.style.visibility = phase === 1 ? "hidden" : "visible";
    btnNext.style.display = phase < 4 ? "" : "none";
    btnExport.style.display = phase === 4 ? "" : "none";
    btnNext.childNodes[0].nodeValue = phase === 3 ? "書き出しへ" : "次へ";
    btnNext.disabled = (phase === 1 && TOTAL === 0);
    btnNext.style.opacity = btnNext.disabled ? ".5" : "";

    if (phase === 1) {
      setHint(TOTAL ? "「次へ」で用語の置換に進みます" : "変換するPDFを選びます");
      ctxText.textContent = TOTAL ? FILES.length + " ファイル・" + TOTAL + " ページ" : "ファイル未選択";
    } else if (phase === 4) {
      setHint("内容を確認して書き出します。");
      ctxText.textContent = FILES.length + " ファイル・" + TOTAL + " ページ";
      refreshExport();
      var s2 = counts(status2), s3 = counts(status3);
      document.getElementById("export-summary").innerHTML =
        FILES.length + "ファイル・全" + TOTAL + "ページ<br/>用語：確認 " + s2.done + " / スキップ " + s2.skip +
        "　削除：確認 " + s3.done + " / スキップ " + s3.skip;
    } else {
      var task = phase === 2 ? "用語の置換" : "不要範囲の削除";
      var c = counts(statusArr());
      setHint(task + " — 要確認 <b>" + c.pend + "</b> / 確認済み <b>" + c.done + "</b> / スキップ <b>" + c.skip + "</b>");
      var pg = PAGES[page];
      ctxText.textContent = FILES[pg.fileIndex].name + " ・ " + (pg.pageInFile + 1) + "/" + FILES[pg.fileIndex].pages + " ページ";
    }

    if (phase === 2 && TOTAL) {
      buildRail("pagenav"); renderSummary("sum-2", status2); renderPageAct();
      document.getElementById("pgnav-2").innerHTML = pageLabel();
      mountPage(document.getElementById("doc-master"), app.querySelector('[data-screen="2"] .editor'), false).then(wireConfirmPick);
      renderConfirm();
    }
    if (phase === 3 && TOTAL) {
      buildRail("pagenav-3"); renderSummary("sum-3", status3); renderPageAct();
      document.getElementById("pgnav-3").innerHTML = pageLabel();
      var ed3 = app.querySelector('[data-screen="3"] .editor');
      ed3.classList.toggle("tool-crop", tool === "crop");
      ed3.classList.toggle("tool-select", tool === "select");
      mountPage(document.getElementById("trim-stage"), ed3, true).then(wireTrimStage);
      renderTrim();
    }
  }

  // ---- ナビゲーション ----
  var expMode = "all", expFile = 0;   // 書き出しモード: page/all/noskip/spec, 指定ファイル
  function firstPending(arr) { for (var i = 0; i < TOTAL; i++) if (arr[i] === "pending") return i; return 0; }
  function advancePhase() { guarding = false; if (phase === 2) { phase = 3; page = 0; } else if (phase === 3) phase = 4; clearSel(); render(); }
  function tryNext() {
    if (phase === 1) { if (!TOTAL) return; phase = 2; page = 0; guarding = false; render(); return; }
    if (phase === 2 || phase === 3) {
      var pend = counts(statusArr()).pend;
      if (pend > 0) { guarding = true; document.getElementById("guard-n").textContent = pend; render(); return; }
      advancePhase();
    }
  }
  function back() {
    guarding = false;
    if (phase === 2) phase = 1; else if (phase === 3) { phase = 2; page = 0; } else if (phase === 4) { phase = 3; page = 0; }
    render();
  }

  function wireStatic() {
    installCropDrag();
    document.getElementById("btn-pick").addEventListener("click", doLoad);
    document.getElementById("dropzone").addEventListener("click", function (e) {
      if (e.target.closest("#btn-pick")) return; doLoad();
    });
    document.getElementById("btn-back").addEventListener("click", back);
    document.getElementById("btn-next").addEventListener("click", tryNext);
    document.getElementById("btn-undo").addEventListener("click", async function () { await rpc("undo"); await afterEdit(); });
    document.getElementById("btn-redo").addEventListener("click", async function () { await rpc("redo"); await afterEdit(); });
    document.getElementById("guard-back").addEventListener("click", function () { guarding = false; page = firstPending(statusArr()); render(); });
    document.getElementById("guard-skip").addEventListener("click", function () {
      var arr = statusArr(); for (var i = 0; i < TOTAL; i++) if (arr[i] === "pending") arr[i] = "skipped"; advancePhase();
    });
    app.querySelectorAll("#stepbar .step").forEach(function (st) {
      st.addEventListener("click", function () {
        var n = +st.dataset.step; if (n > phase || !TOTAL) return;
        guarding = false; phase = n; if (n === 2 || n === 3) page = 0; clearSel(); render();
      });
    });
    // タブ
    app.querySelectorAll("[data-tab]").forEach(function (el) {
      el.addEventListener("click", function () { activateTab(el.dataset.tab); });
    });
    // 手順3 ツール
    app.querySelectorAll(".float-tools [data-tool]").forEach(function (b) {
      b.addEventListener("click", function () {
        tool = b.dataset.tool;
        app.querySelectorAll(".float-tools [data-tool]").forEach(function (x) { x.setAttribute("aria-pressed", x === b ? "true" : "false"); });
        render();
      });
    });
    document.getElementById("btn-deletesel").addEventListener("click", async function () {
      var pg = PAGES[page]; if (!pg) return;
      var ids = Object.keys(curElSel()); if (!ids.length) return;
      await rpc("applyDelete", { fileIndex: pg.fileIndex, pageInFile: pg.pageInFile, elIds: ids }); await afterEdit();
    });
    // 辞書
    document.getElementById("dict-add").addEventListener("click", async function () {
      var src = document.getElementById("dict-src"); var tgt = document.getElementById("dict-tgt");
      if (!src.value.trim()) return;
      dictState = await rpc("dictAdd", { source: src.value, target: tgt.value });
      src.value = ""; tgt.value = ""; renderDict();
    });
    document.getElementById("chk-headers").addEventListener("click", async function () {
      dictState.onlyHeaders = !dictState.onlyHeaders;
      await rpc("setOnlyHeaders", { value: dictState.onlyHeaders }); renderDict();
    });
    document.getElementById("btn-reapply").addEventListener("click", async function () {
      var r = await rpc("reapplyDict");
      await reloadState();
      setHint("辞書を再適用しました（" + r.count + " 件置換）");
      render();
    });
    document.getElementById("btn-dict-export").addEventListener("click", async function () {
      var r = await rpc("dictJson");
      var ok = await saveTextFile("dictionary.json", r.json, "JSON", "application/json", ".json");
      if (!ok) return;
      setHint("辞書を書き出しました（" + (r.count || 0) + " 件）");
    });
    document.getElementById("btn-dict-import").addEventListener("click", async function () {
      var f = await pickOneFile("JSON", "application/json", ".json");
      if (!f) return;
      var text = await f.text();
      var r = await rpc("dictImportJson", { json: text });
      dictState = r; renderDict();
      setHint("辞書を読み込みました（" + (r.imported || 0) + " 件）");
    });
    // 書き出し範囲
    app.querySelectorAll(".segment [data-mode]").forEach(function (b) {
      b.addEventListener("click", function () { expMode = b.dataset.mode; refreshExport(); });
    });
    document.getElementById("exp-file").addEventListener("change", function () { expFile = +this.value; refreshExport(); });
    document.getElementById("exp-spec").addEventListener("input", refreshExport);
    document.getElementById("btn-export").addEventListener("click", doExport);
    // ショートカット
    window.addEventListener("keydown", function (e) {
      if (e.ctrlKey && e.key.toLowerCase() === "z") { rpc("undo").then(afterEdit); }
      else if (e.ctrlKey && (e.key.toLowerCase() === "y")) { rpc("redo").then(afterEdit); }
    });
    // 進捗
    window.onProgress(function (msg) { setHint(esc(msg)); });
  }
  // "1-5, 8" → [1,2,3,4,5,8]（1始まり・昇順ユニーク・1..max にクランプ）
  function parseSpec(text, maxPages) {
    var got = {};
    String(text || "").split(",").forEach(function (tok) {
      tok = tok.trim(); if (!tok) return;
      var m = tok.match(/^(\d+)\s*-\s*(\d+)$/);
      var a, b;
      if (m) { a = +m[1]; b = +m[2]; } else if (/^\d+$/.test(tok)) { a = b = +tok; } else return;
      if (a > b) { var t = a; a = b; b = t; }
      a = Math.max(1, a); b = Math.min(maxPages, b);
      for (var n = a; n <= b; n++) got[n] = true;
    });
    return Object.keys(got).map(Number).sort(function (x, y) { return x - y; });
  }

  // 現在のモードで書き出す [{fileIndex, pageInFile}] を返す
  function exportPageList() {
    if (expMode === "all") return PAGES.slice();
    if (expMode === "noskip") {
      return PAGES.filter(function (pg, g) { return status2[g] !== "skipped" && status3[g] !== "skipped"; });
    }
    if (expMode === "spec") {
      var fi = expFile; if (!FILES[fi]) return [];
      return parseSpec(document.getElementById("exp-spec").value, FILES[fi].pages)
        .map(function (n) { return { fileIndex: fi, pageInFile: n - 1 }; });
    }
    return []; // page モードは exportPage を使うため対象外
  }

  function expCount() { return expMode === "page" ? (TOTAL ? 1 : 0) : exportPageList().length; }

  function refreshExport() {
    app.querySelectorAll(".segment [data-mode]").forEach(function (b) {
      b.setAttribute("aria-pressed", b.dataset.mode === expMode ? "true" : "false");
    });
    var specRow = document.getElementById("exp-spec-row");
    if (specRow) specRow.style.display = expMode === "spec" ? "flex" : "none";
    var sel = document.getElementById("exp-file");
    if (sel) {
      sel.innerHTML = FILES.map(function (f, i) {
        return '<option value="' + i + '">' + esc(f.name) + "（" + f.pages + "ページ）</option>";
      }).join("");
      if (expFile >= FILES.length) expFile = 0;
      sel.value = String(expFile);
    }
    document.getElementById("exp-num").textContent = expCount();
  }

  async function doExport() {
    if (expMode === "page") {
      var pg = PAGES[page] || { fileIndex: 0, pageInFile: 0 };
      var one = await rpc("exportSvg", { fileIndex: pg.fileIndex, pageInFile: pg.pageInFile });
      var ok = await saveTextFile(one.name, one.svg, "SVG", "image/svg+xml", ".svg");
      if (!ok) return;
      setHint('<b style="color:var(--good-ink)">1個のSVGを書き出しました。</b>');
      return;
    }
    var list = exportPageList();
    if (!list.length) { setHint("書き出す対象のページがありません。"); return; }
    var dir = await pickSaveDir();
    if (dir === null) return; // キャンセル
    var n = 0;
    for (var i = 0; i < list.length; i++) {
      setHint("書き出し中 " + (i + 1) + "/" + list.length);
      var item = await rpc("exportSvg", list[i]);
      await writeIntoDir(dir, item.name, item.svg);
      n++;
    }
    setHint('<b style="color:var(--good-ink)">' + n + "個のSVGを書き出しました。</b>");
  }

  // ---- ライフサイクル (サーバ常駐管理) ----
  // app.py は「窓を閉じた時の /quit ビーコン」＋「/ping ハートビート途絶を見張る
  // watchdog」でサーバを終了する設計。クライアントがこれらを送らないと、Edge の
  // コールド再起動で起動プロセスが早期終了した際にサーバが落ちて初回起動が空白になる。
  function startLifecycle() {
    // 生存ハートビート: last_seen を定期更新し、開いている間は watchdog に殺させない。
    setInterval(function () {
      fetch("/ping", { method: "POST", keepalive: true }).catch(function () {});
    }, 10000);
    // 窓を閉じる時の終了ビーコン。beforeunload ではなく pagehide + sendBeacon が確実。
    // 最小化でも hidden になる visibilitychange は使わない (最小化でサーバを殺さないため)。
    // ビーコン不達でもハートビート途絶 watchdog がバックストップになる。
    window.addEventListener("pagehide", function () {
      try { navigator.sendBeacon("/quit"); } catch (e) {}
    });
  }

  // ---- 起動 ----
  window.__rpcReady.then(function () {
    wireStatic();
    render();
    startLifecycle();
  });
})();
