// =============================================================================
// editor-io.js — SVG 読込 / 保存 (bake) / ファイル選択・ドロップ (Editor から分離)
// =============================================================================
// `editor.js` の `Editor` インスタンス (`ed`) を第 1 引数に取るファイル I/O 群。
// 開く = `<input type=file>` + D&D / 保存 = ダウンロード固定 (VDI 方針。`hasFsAccess()`
// は常に false — utils.js 参照) という入出力の関所を本モジュールに集める。

import { CONFIG } from "./constants.js";
import { parseTranslate } from "./geom.js";
import { round, createSvgEl, safeGetBBox, sanitizeSvg, hasFsAccess, SVG_PICKER_TYPES } from "./utils.js";
import { LabelState } from "./label-state.js";

// ── 1. SVG 読込 & セットアップ (メモリ上の `content` を直接インライン挿入) ──

async function load(ed, item) {
  if (!item || typeof item.content !== "string") return;
  const seq = ++ed._loadSeq; // この呼び出しの世代 (後勝ち判定用)
  ed.name = item.name;
  ed.currentId = item.id;
  ed.history = [];
  ed.redoStack = [];
  ed.selected = null;
  ed.zoom = 1;
  ed._pie = null;
  ed._leaderStyle = null;
  ed._sliceByName = null;
  ed._sliceAnchor = null;
  // 別ファイルへ切替えるので構造シグネチャ / 参照キャッシュをリセット
  ed._inspSig = null;
  ed._overlaySig = null;
  ed._handles = [];

  // 接続前にサニタイズした `<svg>` を取り込んでインライン挿入 (フォント込みで描画)
  const clean = sanitizeSvg(item.content);
  if (!clean) {
    ed.dom.canvas.replaceChildren();
    ed.setStatus(`${item.name}: SVG を解釈できませんでした`, "err");
    ed.svg = null;
    ed.updateToolbar();
    return;
  }
  ed.dom.canvas.replaceChildren(document.importNode(clean, true));
  const svg = ed.dom.canvas.querySelector("svg");
  ed.svg = svg;

  // ベースサイズを `viewBox` から取得
  const vb = (svg.getAttribute("viewBox") || `0 0 ${CONFIG.defaultViewBox.w} ${CONFIG.defaultViewBox.h}`).split(/\s+/).map(Number);
  ed.baseW = vb[2] || CONFIG.defaultViewBox.w;
  ed.baseH = vb[3] || CONFIG.defaultViewBox.h;
  ed.applyZoom();

  // 編集画面(手順2)を表示してから `getBBox` を測る。非表示(`display:none`)のままだと
  // `getBBox` が 0 を返し、ヒット領域や引出線の既定座標が崩れるため必ず先に表示する。
  ed.goPhase(2);

  // 埋め込みフォントの読込を待ってから `getBBox` (正確なヒット領域のため)
  try {
    await document.fonts.ready;
  } catch {
    /* fonts API 非対応でも続行 */
  }
  // await 中に別ファイルが読み込まれていたら後勝ち。古い継続は中断する。
  if (seq !== ed._loadSeq) return;

  // 各ラベルにヒット領域を付与 + 状態構築
  ed.labels = [];
  const labelGroups = svg.querySelectorAll("#labels > g.label");
  labelGroups.forEach((g) => {
    const s = new LabelState(g, ed);
    ed.labels.push(s);
    attachHitArea(ed, s);
  });

  // ハンドル用オーバーレイ `<g>` (最前面)
  const overlay = createSvgEl("g", { id: "editor-overlay", "data-editor": "1" });
  svg.appendChild(overlay);
  ed.overlay = overlay;

  // 背景クリックで選択解除
  svg.addEventListener("pointerdown", (e) => {
    if (e.target === svg || e.target.closest("#slices")) ed.selectLabel(null);
  });

  ed.markDirty({ overlay: true, inspector: true });
  ed.flushNow();
  ed.updateToolbar();
  ed.highlightActiveInList();
  ed.setStatus(`${item.name}  (ラベル ${ed.labels.length} 個)`);
}

/** ラベルにドラッグ用の透明ヒット矩形 (`<rect>`) を追加 */
function attachHitArea(ed, s) {
  const bbox = safeGetBBox(s.text);
  const pad = CONFIG.hitPadding;
  const rect = createSvgEl("rect", {
    class: "label-hit", "data-editor-hit": "1",
    x: bbox.x - pad, y: bbox.y - pad,
    width: bbox.width + pad * 2, height: bbox.height + pad * 2,
  });
  s._hitRect = rect;
  // `text` と同じ transform を適用して追従させる
  s.syncHit();
  rect.addEventListener("pointerdown", (e) => ed.startTextDrag(e, s));
  // 最前面 (glyph の隙間も含めて bbox 全体を掴めるよう `text` の上に重ねる)
  s.g.appendChild(rect);
}

// ── 2. 保存 (baking → ダウンロード) ──

async function save(ed) {
  if (!ed.svg) return;
  // 保留中の描画を確定させてから DOM を読む
  ed.flushNow();
  const out = bakeSvg(ed);
  const markSaved = () => {
    const it = ed.items.find((i) => i.id === ed.currentId);
    if (it) it.edited = true;
    ed.renderList();
    ed.highlightActiveInList();
  };
  if (hasFsAccess()) {
    ed.setStatus("保存先を選択してください…");
    try {
      const handle = await window.showSaveFilePicker({
        suggestedName: ed.name || "edited.svg",
        types: SVG_PICKER_TYPES,
      });
      const w = await handle.createWritable();
      await w.write(out);
      await w.close();
      ed.setStatus(`保存しました → ${handle.name}`, "ok");
      markSaved();
    } catch (e) {
      if (e && e.name === "AbortError") ed.setStatus("保存をキャンセルしました");
      else ed.setStatus(`保存に失敗しました: ${e}`, "err");
    }
  } else {
    // 非対応ブラウザ: `Blob` をダウンロード (ブラウザの保存先へ)
    downloadSvg(out, ed.name || "edited.svg");
    ed.setStatus("ダウンロードフォルダに保存しました", "ok");
    markSaved();
  }
}

/** FS Access API 非対応時のフォールバック保存 (`Blob` ダウンロード) */
function downloadSvg(text, name) {
  const blob = new Blob([text], { type: "image/svg+xml" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = /\.svg$/i.test(name) ? name : `${name}.svg`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/** 編集を恒久座標へ焼き込み、エディタ専用要素を除去したクリーン SVG 文字列を返す */
function bakeSvg(ed) {
  const clone = ed.svg.cloneNode(true);

  // エディタ専用要素を除去
  clone.querySelectorAll("[data-editor], [data-editor-hit]").forEach((el) => el.remove());
  // 選択ハイライト等の編集専用クラスを除去
  clone.querySelectorAll(".is-selected").forEach((el) => el.classList.remove("is-selected"));

  // 表示用に付けた width/height (ズーム) を元サイズへ戻す
  clone.setAttribute("width", `${ed.baseW}px`);
  clone.setAttribute("height", `${ed.baseH}px`);

  // 各ラベル: `text` の transform を `x`/`y` へ焼き込み、非表示 leader を除去
  clone.querySelectorAll("#labels > g.label").forEach((g) => {
    const text = g.querySelector("text");
    if (text) {
      const t = parseTranslate(text.getAttribute("transform"));
      if (t.x || t.y) {
        const x = parseFloat(text.getAttribute("x") || "0") + t.x;
        const y = parseFloat(text.getAttribute("y") || "0") + t.y;
        text.setAttribute("x", round(x));
        text.setAttribute("y", round(y));
        text.querySelectorAll("tspan").forEach((ts) => {
          if (ts.hasAttribute("x")) ts.setAttribute("x", round(parseFloat(ts.getAttribute("x")) + t.x));
          // `dy` は相対値なので不変
        });
        text.removeAttribute("transform");
      }
    }
    const path = g.querySelector("path");
    if (path) {
      if (path.style.display === "none") {
        path.remove();
      } else {
        // 表示用に付けた `display` だけ消す。入力 SVG 由来の他の inline style は保持。
        path.style.removeProperty("display");
        if (!path.getAttribute("style")) path.removeAttribute("style");
      }
    }
  });

  const xml = new XMLSerializer().serializeToString(clone);
  return `<?xml version="1.0" encoding="UTF-8"?>\n${xml}`;
}

// ── 3. ファイル選択 / ドロップ (開く) ──

async function openFiles(ed) {
  ed.setStatus("ファイルを選択してください…");
  let files = [];
  if (hasFsAccess()) {
    let handles;
    try {
      handles = await window.showOpenFilePicker({ multiple: true, types: SVG_PICKER_TYPES });
    } catch (e) {
      if (e && e.name === "AbortError") { ed.setStatus("ファイルが選択されませんでした"); return; }
      ed.setStatus(`読込に失敗しました: ${e}`, "err");
      return;
    }
    for (const h of handles) {
      try {
        const file = await h.getFile();
        files.push({ name: file.name, content: await file.text() });
      } catch (e) {
        files.push({ name: h.name || "(no name)", content: "", error: String(e) });
      }
    }
  } else {
    files = await pickFilesFallback();
  }
  if (!files || !files.length) {
    ed.setStatus("ファイルが選択されませんでした");
    return;
  }
  await addAndOpen(ed, files);
}

/** ドラッグ＆ドロップされた .svg ファイルを取り込む (手順1 のドロップゾーン) */
async function handleDrop(ed, dt) {
  if (!dt) return;
  const dropped = [...(dt.files || [])].filter((f) => /\.svg$/i.test(f.name) || f.type === "image/svg+xml");
  if (!dropped.length) { ed.setStatus("SVG ファイルをドロップしてください"); return; }
  const files = [];
  for (const file of dropped) {
    try { files.push({ name: file.name, content: await file.text() }); }
    catch (e) { files.push({ name: file.name, content: "", error: String(e) }); }
  }
  await addAndOpen(ed, files);
}

/** 取得済みファイル群を items へ登録し、先頭を開いて手順2 へ進む (openFiles / D&D 共通) */
async function addAndOpen(ed, files) {
  // 同名でも別ファイルとして区別したいので `name` で重複排除せず、各々へ一意 `id` を振る。
  const added = files.map((f) => {
    const it = { ...f, id: ++ed._itemSeq, edited: false };
    ed.items.push(it);
    return it;
  });
  ed.renderList();
  await load(ed, added[0]);
  ed.goPhase(2);
}

/** FS Access API 非対応時のフォールバック: `<input type=file>` で複数選択 */
function pickFilesFallback() {
  return new Promise((resolve) => {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = ".svg,image/svg+xml";
    input.multiple = true;
    input.style.display = "none";
    let done = false;
    const finish = async () => {
      if (done) return;
      done = true;
      const out = [];
      for (const file of [...(input.files || [])]) {
        out.push({ name: file.name, content: await file.text() });
      }
      input.remove();
      resolve(out);
    };
    input.addEventListener("change", finish);
    // キャンセル検知 (`focus` が戻り `files` が空なら空配列で解決)
    window.addEventListener("focus", () => setTimeout(() => {
      if (!done && (!input.files || !input.files.length)) { done = true; input.remove(); resolve([]); }
    }, 500), { once: true });
    document.body.appendChild(input);
    input.click();
  });
}

export { load, save, bakeSvg, openFiles, handleDrop };
