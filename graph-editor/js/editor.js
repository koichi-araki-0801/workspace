import { CONFIG, WHITE, BLACK, DEFAULT_LEADER_STYLE, EMPTY_LIST_HTML, INSPECTOR_EMPTY_HTML, LEGEND_HTML, INSPECTOR_ACTIONS } from "./constants.js";
import { clampPointToBox, parseTranslate } from "./geom.js";
import { escapeHtml, round, createSvgEl, safeGetBBox, formatCoords, sanitizeSvg, hasFsAccess, SVG_PICKER_TYPES } from "./utils.js";
import { drawIcons, showToast } from "./icons.js";
import { LabelState } from "./label-state.js";

// ---------------------------------------------------------------------------
// エディタ本体 (セッション状態 + ライフサイクル + 描画オーケストレーション)
// ---------------------------------------------------------------------------

class Editor {
  constructor(dom) {
    this.dom = dom;

    // 現在の編集セッション状態
    this.name = null;        // 読込中のファイル名 (表示用。同定には使わない)
    this.currentId = null;   // 読込中アイテムの id (同名ファイルを取り違えないため)
    this.svg = null;         // インライン SVG ルート要素
    this.overlay = null;     // ハンドル等を入れる <g> (保存時に除去)
    this.labels = [];        // LabelState の配列
    this.selected = null;    // 選択中ラベル状態
    this.history = [];       // Undo 用スナップショット
    this.redoStack = [];     // Redo 用スナップショット (新規操作で破棄)
    this.phase = 1;          // ウィザード手順 (1=開く / 2=調整 / 3=保存)
    this.zoom = 1;
    this.baseW = 0;
    this.baseH = 0;
    this._pie = null;        // パイ中心・半径のキャッシュ {cx,cy,r}
    this._leaderStyle = null;// 新規 leader 用 stroke 属性のキャッシュ
    this._sliceByName = null;// data-name → スライス<path> の Map (遅延構築)
    this._sliceAnchor = null;// data-name → 中心角リム点 {x,y}|null のキャッシュ
    this.items = [];         // 読み込んだファイル群 (メモリ保持) … {id, name, content, edited?}
    this._itemSeq = 0;       // items に振る一意 id の採番 (同名でも区別する)
    this._loadSeq = 0;       // load() 再入の後勝ち判定 (fonts.ready 待ちのレース回避)

    // 描画スケジューラ (rAF + dirty フラグ)
    this._dirty = { dom: false, overlay: false, inspector: false };
    this._frame = 0;         // rAF ハンドル (0=未予約)
    // インスペクタの構造再構築判定 + 座標表示の参照キャッシュ
    this._inspSig = null;
    this._inspCoordEl = null;
    // オーバーレイのハンドル要素キャッシュ + 構造再構築判定
    this._handles = [];
    this._overlaySig = null;
  }

  // -------------------------------------------------------------------------
  // 共通
  // -------------------------------------------------------------------------

  setStatus(msg, kind = "") {
    if (this.dom.status) {
      this.dom.status.textContent = msg;
      this.dom.status.className = "skip-note" + (kind ? " " + kind : "");
    }
    // 完了/失敗はトーストでも通知
    if (kind === "ok" || kind === "err") showToast(msg);
  }

  // -------------------------------------------------------------------------
  // ウィザード（手順の切替）
  // -------------------------------------------------------------------------

  /** 手順 n (1=開く / 2=調整 / 3=保存) へ切替え、ステップバー/画面/フッターを更新 */
  goPhase(n) {
    n = Math.max(1, Math.min(3, n));
    // ファイル未読込なら 2・3 へは進めない
    if (n >= 2 && !this.svg) { showToast("先に SVG を開いてください"); n = 1; }
    this.phase = n;
    const screens = { 1: this.dom.scOpen, 2: this.dom.scEdit, 3: this.dom.scSave };
    for (const [k, el] of Object.entries(screens)) { if (el) el.classList.toggle("on", +k === n); }
    // ステップバー
    if (this.dom.stepbar) {
      this.dom.stepbar.querySelectorAll(".step").forEach((st) => {
        const sn = +st.dataset.step;
        st.classList.toggle("active", sn === n);
        st.classList.toggle("done", sn < n);
      });
    }
    // フッターのボタン
    if (this.dom.btnBack) this.dom.btnBack.disabled = n === 1;
    if (this.dom.btnNext) {
      const last = n === 3;
      this.dom.btnNext.style.display = last ? "none" : "";
      this.dom.btnNext.disabled = n === 1 && !this.svg;
    }
    if (this.dom.navHint) this.dom.navHint.style.display = n === 2 ? "" : "none";
    this.updateChrome();
  }

  /** マウスイベント client 座標 → SVG ユーザー単位。
   *  inv (逆 CTM) を渡すと getScreenCTM 呼び出しを省ける (ドラッグ中の reflow 回避)。 */
  toSvgPoint(evt, inv) {
    const pt = this.svg.createSVGPoint();
    pt.x = evt.clientX;
    pt.y = evt.clientY;
    return pt.matrixTransform(inv || this.svg.getScreenCTM().inverse());
  }

  // -------------------------------------------------------------------------
  // 円幾何 / leader スタイル (セッション状態に依存)
  // -------------------------------------------------------------------------

  /** 円(パイ)の中心・半径を slice パスから推定 (リーダー後付けの既定座標に使用) */
  getPieGeometry() {
    if (this._pie) return this._pie;
    let geom = null;
    const slicePath = this.svg && this.svg.querySelector("#slices .slice path, #slices path");
    if (slicePath) {
      const d = slicePath.getAttribute("d") || "";
      const m = d.match(/M\s*(-?\d*\.?\d+)[ ,]+(-?\d*\.?\d+)/);
      const a = d.match(/A\s*(-?\d*\.?\d+)[ ,]+(-?\d*\.?\d+)/);
      if (m && a) {
        geom = { cx: parseFloat(m[1]), cy: parseFloat(m[2]), r: parseFloat(a[1]) };
      }
    }
    if (!geom) {
      geom = { cx: this.baseW / 2, cy: this.baseH / 2, r: Math.min(this.baseW, this.baseH) * CONFIG.pieRadiusRatio };
    }
    this._pie = geom;
    return geom;
  }

  /** data-name → スライス<path> の Map を一度だけ構築 (属性エスケープ回避のため走査) */
  _sliceMap() {
    if (this._sliceByName) return this._sliceByName;
    const map = new Map();
    const slices = this.svg ? this.svg.querySelectorAll("#slices g.slice") : [];
    slices.forEach((g) => {
      const name = g.getAttribute("data-name");
      const path = g.querySelector("path");
      if (name != null && path && !map.has(name)) map.set(name, path);
    });
    this._sliceByName = map;
    return map;
  }

  /** 指定ラベル名のスライスの「中心角リム点」を返す。leader 円側アンカーの固定先。
   *  楔形パス (M中心 L始点 A終点 Z) は両直線脚が半径 r で等長のため、円弧中点 =
   *  パス全長の中央 = 中心角リム点になる (getPointAtLength(total/2))。
   *  スライス未発見/楔形でない (例: 100% 単一スライスは L 無し+2連 A) 場合は null。 */
  sliceMidAnchor(name) {
    if (!this._sliceAnchor) this._sliceAnchor = new Map();
    if (this._sliceAnchor.has(name)) return this._sliceAnchor.get(name);
    let anchor = null;
    const path = this._sliceMap().get(name);
    const d = path && (path.getAttribute("d") || "");
    // 楔形 (M…L…A…) のみ対象。それ以外は中心角が定義できないので退避。
    if (path && /M[^A-Za-z]*L[^A-Za-z]*A/.test(d)) {
      try {
        const total = path.getTotalLength();
        if (total > 0) {
          const p = path.getPointAtLength(total / 2);
          anchor = { x: p.x, y: p.y };
        }
      } catch { anchor = null; }
    }
    this._sliceAnchor.set(name, anchor);
    return anchor;
  }

  /** 既存 leader から stroke 系属性を借用 (無ければ既定値) */
  leaderStyleTemplate() {
    if (this._leaderStyle) return this._leaderStyle;
    const style = { ...DEFAULT_LEADER_STYLE };
    const existing = this.svg && this.svg.querySelector('#labels path[fill="none"]');
    if (existing) {
      for (const k of Object.keys(style)) {
        const v = existing.getAttribute(k);
        if (v != null) style[k] = v;
      }
    }
    this._leaderStyle = style;
    return style;
  }

  /** リーダー後付け時の既定 2 点 [リム上アンカー, ラベル端点] を算出。
   *  bbox 省略時は getBBox。ドラッグ中は開始時 bbox を渡し reflow を避ける。 */
  defaultLeaderPts(s, bbox) {
    const { cx, cy, r } = this.getPieGeometry();
    if (!bbox) bbox = safeGetBBox(s.text, { x: cx, y: cy, width: 0, height: 0 });
    const left = bbox.x + s.textTx.x;
    const top = bbox.y + s.textTx.y;
    const right = left + bbox.width;
    const bottom = top + bbox.height;
    // ラベル矩形上で中心に最も近い点 = 端点
    const endpoint = {
      x: Math.max(left, Math.min(cx, right)),
      y: Math.max(top, Math.min(cy, bottom)),
    };
    // アンカー = スライス中心角リム点 (固定)。未取得時のみ中心→端点 方向のリム点へ退避。
    let anchor = this.sliceMidAnchor(s.name);
    if (!anchor) {
      let dx = endpoint.x - cx;
      let dy = endpoint.y - cy;
      const len = Math.hypot(dx, dy);
      if (len < CONFIG.vecEpsilon) { dx = 1; dy = 0; }
      const ux = dx / (len || 1);
      const uy = dy / (len || 1);
      anchor = { x: cx + ux * r, y: cy + uy * r };
    }
    return [anchor, endpoint];
  }

  /** leader 末尾(端点)を必ずラベル外枠上へ置く。アンカー/曲げ点は保持。
   *  手前の点をラベル矩形へクランプ = 外枠上の最近点。bbox は素の getBBox 値。 */
  snapEndpointToFrame(s, bbox) {
    const n = s.leaderPts.length;
    if (n < 2) return;
    const left = bbox.x + s.textTx.x;
    const top = bbox.y + s.textTx.y;
    const box = { left, top, right: left + bbox.width, bottom: top + bbox.height };
    s.leaderPts[n - 1] = clampPointToBox(s.leaderPts[n - 2], box);
  }

  /** ラベル移動後の leader 追従。既存 leader を持ち円外なら端点を外枠上へ
   *  再スナップ(アンカー/曲げ点は保持)、それ以外は位置駆動ルール。
   *  basePts 指定時はそれを基準に復元 (ドラッグ中の連続適用用)。 */
  followLeaderAfterMove(s, bbox, basePts) {
    const pts = basePts || s.leaderPts;
    if (pts.length >= 2 && this.isOutsideRim(s, bbox)) {
      s.leaderPts = pts.map((q) => ({ ...q })); // アンカー/曲げ点を保持
      this.snapEndpointToFrame(s, bbox);
      if (s.whiteType) s.fill = BLACK;
    } else {
      this.applyRimLeaderRule(s, bbox);
    }
  }

  /** ラベル(text bbox)の中心点 (textTx 反映)。bbox 省略時は getBBox。 */
  labelCenterPoint(s, bbox) {
    let b = bbox;
    if (!b) {
      b = safeGetBBox(s.text, null);
      if (!b) return null;
    }
    return { x: b.x + b.width / 2 + s.textTx.x, y: b.y + b.height / 2 + s.textTx.y };
  }

  /** ラベル中心が円周の外にあるか。bbox 省略時は getBBox。 */
  isOutsideRim(s, bbox) {
    const { cx, cy, r } = this.getPieGeometry();
    const c = this.labelCenterPoint(s, bbox);
    if (!c) return false;
    return Math.hypot(c.x - cx, c.y - cy) > r;
  }

  // leader 状態モデル:
  //   _auto=true  … 位置駆動で生成された leader。円外で生成/端点追従し、円内で除去する。
  //   _auto=false … ユーザー管理の leader (ファイル由来 / 手動追加 / 頂点や曲げ点を手動編集)。
  //                 位置ルールは削除も可視性の強制もしない (ユーザーの意思を保持)。
  /** 位置駆動の leader ルール: 円外なら自動 leader を確保・円内なら自動分のみ除去。
   *  白文字タイプは円外で黒・円内で白に切替 (視認性)。bbox 省略時は getBBox。 */
  applyRimLeaderRule(s, bbox) {
    if (this.isOutsideRim(s, bbox)) {
      if (s.leaderPts.length === 0 || s._auto) {
        // 自動 leader を (再)生成。生成分だけ可視を強制する。
        s.leaderPts = this.defaultLeaderPts(s, bbox);
        s._auto = true;
        s.leaderVisible = true;
      }
      // 手動 leader (_auto=false) は pts も可視性も触れない。
      if (s.whiteType) s.fill = BLACK;
    } else {
      if (s._auto) {
        // 自動生成分のみ除去。手動 leader は保持する。
        s.leaderPts = [];
        s.leaderVisible = false;
        s._auto = false;
      }
      if (s.whiteType) s.fill = WHITE;
    }
  }

  // -------------------------------------------------------------------------
  // 描画スケジューラ
  // -------------------------------------------------------------------------

  /** 描画要求を dirty フラグへ立て、1 フレーム最大 1 回の flush を予約する */
  markDirty(flags) {
    Object.assign(this._dirty, flags);
    if (!this._frame) this._frame = requestAnimationFrame(() => this._flush());
  }

  _flush() {
    this._frame = 0;
    const d = this._dirty;
    this._dirty = { dom: false, overlay: false, inspector: false };
    if (d.dom && this.selected) this.selected.renderToDom();
    if (d.overlay) this._syncOverlay();
    if (d.inspector) this._renderInspector();
  }

  /** 保留中の描画を同期的に確定させる (保存前の DOM 読出しや、即時反映が要る操作で使用) */
  flushNow() {
    if (this._frame) { cancelAnimationFrame(this._frame); this._frame = 0; }
    this._flush();
  }

  /** 全ラベルの状態を実 DOM へ反映 (Undo/読込時の一括同期) */
  renderAllToDom() {
    for (const s of this.labels) s.renderToDom();
  }

  // -------------------------------------------------------------------------
  // Undo 履歴 (全ラベルのスナップショット)
  // -------------------------------------------------------------------------

  pushHistory() {
    this.history.push(this.labels.map((s) => s.snapshot()));
    if (this.history.length > CONFIG.historyLimit) this.history.shift();
    // 新規操作は redo の分岐履歴を破棄 (一般的な Undo/Redo の挙動)
    this.redoStack = [];
    this.updateToolbar();
  }

  undo() {
    if (!this.history.length) return;
    // 復元前の現在状態を redo へ退避
    this.redoStack.push(this.labels.map((s) => s.snapshot()));
    const snap = this.history.pop();
    this.labels.forEach((s, i) => s.apply(snap[i]));
    this.renderAllToDom();
    this.markDirty({ overlay: true, inspector: true });
    this.flushNow();
    this.updateToolbar();
  }

  redo() {
    if (!this.redoStack.length) return;
    // 復元前の現在状態を undo へ積み戻す (undo と対称)
    this.history.push(this.labels.map((s) => s.snapshot()));
    if (this.history.length > CONFIG.historyLimit) this.history.shift();
    const snap = this.redoStack.pop();
    this.labels.forEach((s, i) => s.apply(snap[i]));
    this.renderAllToDom();
    this.markDirty({ overlay: true, inspector: true });
    this.flushNow();
    this.updateToolbar();
  }

  updateToolbar() {
    this.dom.btnUndo.disabled = this.history.length === 0;
    if (this.dom.btnRedo) this.dom.btnRedo.disabled = this.redoStack.length === 0;
    this.dom.btnReset.disabled = !this.svg;
    this.dom.btnSave.disabled = !this.svg;
  }

  // -------------------------------------------------------------------------
  // オーバーレイ (ハンドル) 描画 — 構造変化時のみ再構築、通常は座標更新
  // -------------------------------------------------------------------------

  handleSize() {
    // ズームに依らず一定の見かけサイズになるよう SVG 単位を補正
    return CONFIG.handleScreenRadius / this.zoom;
  }

  /** ハンドル構成 (選択ラベル・表示状態・頂点数) を表すシグネチャ */
  _overlaySignature() {
    const s = this.selected;
    if (!s || !this.overlay || !s.leaderVisible || !s.leaderPts.length) return "none";
    return `${this.labels.indexOf(s)}|${s.leaderPts.length}`;
  }

  _syncOverlay() {
    const sig = this._overlaySignature();
    if (sig !== this._overlaySig) {
      this._buildOverlay();
      this._overlaySig = sig;
    } else {
      this._positionHandles();
    }
  }

  /** ハンドル円を作り直す (頂点数・選択が変わった時だけ呼ばれる) */
  _buildOverlay() {
    if (this.overlay) this.overlay.replaceChildren();
    this._handles = [];
    const s = this.selected;
    if (!s || !this.overlay) return;
    if (!(s.leaderVisible && s.leaderPts.length)) return;
    const r = this.handleSize();
    const last = s.leaderPts.length - 1;
    s.leaderPts.forEach((p, i) => {
      // 先頭=アンカー: 橙, 末尾=端点: 緑, 中間: 青
      const color = i === 0 ? "#ffb84c" : i === last ? "#57c878" : "#4c9aff";
      const c = this._circle(p.x, p.y, r, color);
      // 円側アンカー (i===0) はスライス中心角に固定 → ドラッグ不可。端点/曲げ点のみ可動。
      if (i === 0) {
        c.style.cursor = "not-allowed";
      } else {
        c.style.cursor = "move";
        c.addEventListener("pointerdown", (e) => this.startLeaderDrag(e, s, i));
      }
      this.overlay.appendChild(c);
      this._handles.push(c);
    });
  }

  /** 既存ハンドル円の cx/cy (+ズーム時の r/stroke) だけを更新 */
  _positionHandles() {
    const s = this.selected;
    if (!s || !this._handles.length) return;
    const r = this.handleSize();
    const sw = 1 / this.zoom;
    s.leaderPts.forEach((p, i) => {
      const c = this._handles[i];
      if (!c) return;
      c.setAttribute("cx", p.x);
      c.setAttribute("cy", p.y);
      c.setAttribute("r", r);
      c.setAttribute("stroke-width", sw);
    });
  }

  _circle(x, y, r, color) {
    return createSvgEl("circle", {
      cx: x, cy: y, r, fill: color,
      stroke: "#1e1f22", "stroke-width": 1 / this.zoom, "data-editor": "1",
    });
  }

  // -------------------------------------------------------------------------
  // ドラッグ操作
  // -------------------------------------------------------------------------

  /** ドラッグの定型処理: pointermove/up を配線し、初回の実移動時に一度だけ
   *  pushHistory する。onMove(dx, dy) には開始点からの累積移動量を渡す。 */
  onDrag(evt, onMove) {
    // 逆 CTM はドラッグ中ほぼ不変 (ズーム/スクロールしない) なので開始時に1回だけ取得
    const inv = this.svg.getScreenCTM().inverse();
    const start = this.toSvgPoint(evt, inv);
    let pushed = false;
    const move = (e) => {
      const p = this.toSvgPoint(e, inv);
      const dx = p.x - start.x;
      const dy = p.y - start.y;
      if (!pushed && (dx || dy)) { this.pushHistory(); pushed = true; }
      onMove(dx, dy);
    };
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      window.removeEventListener("pointercancel", up);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
    window.addEventListener("pointercancel", up);
  }

  startTextDrag(evt, s) {
    evt.preventDefault();
    evt.stopPropagation();
    this.selectLabel(s);
    const txStart = { ...s.textTx };
    // ドラッグ開始時の leader 状態 (円外で元から leader を持つ場合の追従/復元に使用)
    const startPts = s.leaderPts.map((p) => ({ ...p }));
    // bbox は transform 非依存 (= ドラッグ中不変) なので開始時に1回だけ取得し reflow を避ける
    const bbox = safeGetBBox(s.text, null);

    this.onDrag(evt, (dx, dy) => {
      s.textTx = { x: txStart.x + dx, y: txStart.y + dy };
      // startPts 基準でアンカー/曲げ点を保持しつつ端点を毎フレーム外枠へ再スナップ
      this.followLeaderAfterMove(s, bbox, startPts);
      this.markDirty({ dom: true, overlay: true, inspector: true });
    });
  }

  startLeaderDrag(evt, s, index) {
    evt.preventDefault();
    evt.stopPropagation();
    this.selectLabel(s);
    s._auto = false; // 手動で頂点を動かしたら以後は位置駆動で上書きしない
    const ptStart = { ...s.leaderPts[index] };

    this.onDrag(evt, (dx, dy) => {
      s.leaderPts[index] = { x: ptStart.x + dx, y: ptStart.y + dy };
      this.markDirty({ dom: true, overlay: true });
    });
  }

  // -------------------------------------------------------------------------
  // 選択 & インスペクタ
  // -------------------------------------------------------------------------

  selectLabel(s) {
    if (this.selected === s) return;
    if (this.selected) this.selected.g.classList.remove("is-selected");
    this.selected = s;
    if (s) s.g.classList.add("is-selected");
    this.markDirty({ overlay: true, inspector: true });
    this.flushNow();
  }

  /** スライス(扇形)の塗り色を data-name から引く。見つからなければ既定。 */
  sliceColor(name) {
    const path = this._sliceMap().get(name);
    const c = path && (path.getAttribute("fill") || (path.style && path.style.fill));
    return c && c !== "none" ? c : "var(--sunk)";
  }

  /** 選択中ラベルの右パネル本体 HTML（モック「案A」準拠のセグメント UI）。
   *  各セグメントボタンは data-act を持ち、_buildInspector が INSPECTOR_ACTIONS へ配線する。 */
  _inspectorBodyHtml(s) {
    const hasLeader = s.leaderPts.length >= 2;
    const hasBend = s.leaderPts.length >= 3;
    const pct = s.percentText ? ` ${escapeHtml(s.percentText)}` : "";
    // 引出線: 「表示」は leader が無ければ追加(leaderAdd)、有れば表示(leaderOn)。
    const showAct = hasLeader ? "leaderOn" : "leaderAdd";
    return `
<div class="selname"><span class="sw" style="background:${this.sliceColor(s.name)}"></span><span class="nm">${escapeHtml(s.name)}${pct}</span></div>

<div class="ctl">
  <div class="clab"><i data-ic="leader"></i>引出線</div>
  <div class="segment" data-ctl="leader">
    <button data-act="${showAct}" aria-pressed="${s.leaderVisible}">表示</button>
    <button data-act="leaderOff" aria-pressed="${!s.leaderVisible}">非表示</button>
  </div>
</div>

<div class="ctl${hasLeader ? "" : " off"}" data-dep="leader">
  <div class="clab"><i data-ic="bend"></i>曲げ点</div>
  <div class="segment" data-ctl="bent">
    <button data-act="bendAdd" aria-pressed="${hasBend}">あり</button>
    <button data-act="bendRemove" aria-pressed="${!hasBend}">なし</button>
  </div>
</div>

<div class="ctl">
  <div class="clab"><i data-ic="droplet"></i>文字色</div>
  <div class="segment" data-ctl="color">
    <button data-act="insideOff" aria-pressed="${s.fill !== WHITE}"><span class="swdot" style="background:#111"></span>黒</button>
    <button data-act="insideOn" aria-pressed="${s.fill === WHITE}"><span class="swdot" style="background:#fff;box-shadow:0 0 0 1px var(--border-strong)"></span>白</button>
  </div>
</div>

<div class="ctl">
  <div class="clab"><i data-ic="rows"></i>行数</div>
  <div class="segment" data-ctl="lines">
    <button data-act="lines1" aria-pressed="${s.lineCount < 2}">1行</button>
    <button data-act="lines2" aria-pressed="${s.lineCount >= 2}">2行</button>
  </div>
</div>

<div class="ctl">
  <div class="clab"><i data-ic="width"></i>長体 <span class="tech">（横圧縮）</span></div>
  <div class="rng">
    <input type="range" id="scaleRange" min="${CONFIG.condenseMin}" max="1" step="${CONFIG.condenseStep}" value="${s.nameScaleX}">
    <span class="v" id="scaleVal">${Math.round(s.nameScaleX * 100)}%</span>
  </div>
</div>

${LEGEND_HTML}

<div class="panel-reset">
  <button class="btn outline" data-act="resetOne" style="width:100%;justify-content:center"><i data-ic="reset"></i>このラベルをリセット</button>
</div>`;
  }

  /** インスペクタの構造を表すシグネチャ (座標 dx/dy は含めない = 構造再構築の対象外) */
  _inspectorSignature() {
    const s = this.selected;
    if (!s) return "none";
    return [this.labels.indexOf(s), s.leaderPts.length, s.leaderVisible, s.fill === WHITE, s.lineCount, s.nameScaleX].join("|");
  }

  /** 構造シグネチャが変わった時だけパネルを作り直し、毎回 座標表示だけ更新する */
  _renderInspector() {
    const sig = this._inspectorSignature();
    if (sig !== this._inspSig) {
      this._inspSig = sig;
      this._buildInspector();
    }
    this._updateInspectorReadout();
    this._syncRail();
  }

  _buildInspector() {
    const s = this.selected;
    if (!s) {
      this.dom.inspectorBody.innerHTML = INSPECTOR_EMPTY_HTML;
      drawIcons(this.dom.inspectorBody);
      this._inspCoordEl = null;
      return;
    }
    const box = document.createElement("div");
    box.innerHTML = this._inspectorBodyHtml(s);
    box.querySelectorAll("button[data-act]").forEach((btn) => {
      btn.addEventListener("click", () => this.inspectorAction(btn.getAttribute("data-act")));
    });
    // 長体スライダ: ドラッグ中はライブ反映し、操作開始時に 1 度だけ履歴へ積む。
    // インスペクタは再構築しない (markDirty inspector しない) のでドラッグが途切れない。
    const range = box.querySelector("#scaleRange");
    if (range) {
      const valEl = box.querySelector("#scaleVal");
      let pushed = false;
      const begin = () => { pushed = false; };
      range.addEventListener("pointerdown", begin);
      range.addEventListener("keydown", begin);
      range.addEventListener("input", () => {
        if (!this.selected) return;
        if (!pushed) { this.pushHistory(); pushed = true; }
        const v = parseFloat(range.value);
        this.selected.nameScaleX = v;
        if (valEl) valEl.textContent = `${Math.round(v * 100)}%`;
        this.markDirty({ dom: true });
      });
    }
    this.dom.inspectorBody.replaceChildren(box);
    drawIcons(this.dom.inspectorBody);
    this._inspCoordEl = box.querySelector(".coords");
  }

  /** ドラッグ中に毎フレーム変わる dx/dy 表示だけを軽量に更新 */
  _updateInspectorReadout() {
    const s = this.selected;
    if (!s || !this._inspCoordEl) return;
    this._inspCoordEl.textContent = formatCoords(s.textTx);
  }

  inspectorAction(act) {
    const s = this.selected;
    const a = INSPECTOR_ACTIONS[act];
    if (!s || !a || !a.guard(s)) return;
    this.pushHistory();
    a.run(this, s);
    this.markDirty({ dom: true, overlay: true, inspector: true });
  }

  nudge(dx, dy) {
    const s = this.selected;
    if (!s) return;
    this.pushHistory();
    s.textTx = { x: s.textTx.x + dx, y: s.textTx.y + dy };
    // 端点を外枠へ再スナップ。円周を跨いだ場合の自動生成/削除も内包。
    this.followLeaderAfterMove(s, safeGetBBox(s.text, null));
    this.markDirty({ dom: true, overlay: true, inspector: true });
  }

  // -------------------------------------------------------------------------
  // SVG 読込 & セットアップ (メモリ上の content を直接インライン挿入)
  // -------------------------------------------------------------------------

  async load(item) {
    if (!item || typeof item.content !== "string") return;
    const seq = ++this._loadSeq; // この呼び出しの世代 (後勝ち判定用)
    this.name = item.name;
    this.currentId = item.id;
    this.history = [];
    this.redoStack = [];
    this.selected = null;
    this.zoom = 1;
    this._pie = null;
    this._leaderStyle = null;
    this._sliceByName = null;
    this._sliceAnchor = null;
    // 別ファイルへ切替えるので構造シグネチャ/参照キャッシュをリセット
    this._inspSig = null;
    this._inspCoordEl = null;
    this._overlaySig = null;
    this._handles = [];

    // 接続前にサニタイズした <svg> を取り込んでインライン挿入 (フォント込みで描画)
    const clean = sanitizeSvg(item.content);
    if (!clean) {
      this.dom.canvas.replaceChildren();
      this.setStatus(`${item.name}: SVG を解釈できませんでした`, "err");
      this.svg = null;
      this.updateToolbar();
      return;
    }
    this.dom.canvas.replaceChildren(document.importNode(clean, true));
    const svg = this.dom.canvas.querySelector("svg");
    this.svg = svg;

    // ベースサイズを viewBox から取得
    const vb = (svg.getAttribute("viewBox") || `0 0 ${CONFIG.defaultViewBox.w} ${CONFIG.defaultViewBox.h}`).split(/\s+/).map(Number);
    this.baseW = vb[2] || CONFIG.defaultViewBox.w;
    this.baseH = vb[3] || CONFIG.defaultViewBox.h;
    this.applyZoom();

    // 編集画面(手順2)を表示してから getBBox を測る。非表示(display:none)のままだと
    // getBBox が 0 を返し、ヒット領域や引出線の既定座標が崩れるため必ず先に表示する。
    this.goPhase(2);

    // 埋め込みフォントの読込を待ってから getBBox (正確なヒット領域のため)
    try {
      await document.fonts.ready;
    } catch {
      /* fonts API 非対応でも続行 */
    }
    // await 中に別ファイルが読み込まれていたら後勝ち。古い継続は中断する。
    if (seq !== this._loadSeq) return;

    // 各ラベルにヒット領域を付与 + 状態構築
    this.labels = [];
    const labelGroups = svg.querySelectorAll("#labels > g.label");
    labelGroups.forEach((g) => {
      const s = new LabelState(g, this);
      this.labels.push(s);
      this.attachHitArea(s);
    });

    // ハンドル用オーバーレイ (最前面)
    const overlay = createSvgEl("g", { id: "editor-overlay", "data-editor": "1" });
    svg.appendChild(overlay);
    this.overlay = overlay;

    // 背景クリックで選択解除
    svg.addEventListener("pointerdown", (e) => {
      if (e.target === svg || e.target.closest("#slices")) this.selectLabel(null);
    });

    this.markDirty({ overlay: true, inspector: true });
    this.flushNow();
    this.updateToolbar();
    this.highlightActiveInList();
    this.setStatus(`${item.name}  (ラベル ${this.labels.length} 個)`);
  }

  /** ラベルにドラッグ用の透明ヒット矩形を追加 */
  attachHitArea(s) {
    const bbox = safeGetBBox(s.text);
    const pad = CONFIG.hitPadding;
    const rect = createSvgEl("rect", {
      class: "label-hit", "data-editor-hit": "1",
      x: bbox.x - pad, y: bbox.y - pad,
      width: bbox.width + pad * 2, height: bbox.height + pad * 2,
    });
    s._hitRect = rect;
    // text と同じ transform を適用して追従させる
    s.syncHit();
    rect.addEventListener("pointerdown", (e) => this.startTextDrag(e, s));
    // 最前面 (glyph の隙間も含めて bbox 全体を掴めるよう text の上に重ねる)
    s.g.appendChild(rect);
  }

  // -------------------------------------------------------------------------
  // ズーム
  // -------------------------------------------------------------------------

  applyZoom() {
    if (!this.svg) return;
    this.svg.setAttribute("width", this.baseW * this.zoom);
    this.svg.setAttribute("height", this.baseH * this.zoom);
  }

  setZoom(z) {
    const prev = this.zoom;
    z = Math.max(CONFIG.zoomMin, Math.min(CONFIG.zoomMax, z));
    if (z === prev) return;
    // 表示中心を保ったまま拡縮 (左上基準だと中心がずれて見づらいため)
    const pane = this.dom.canvas.parentElement; // #canvasPane (スクロール容器)
    const r = z / prev;
    const cx = pane.scrollLeft + pane.clientWidth / 2;
    const cy = pane.scrollTop + pane.clientHeight / 2;
    this.zoom = z;
    this.applyZoom();
    pane.scrollLeft = cx * r - pane.clientWidth / 2;
    pane.scrollTop = cy * r - pane.clientHeight / 2;
    // ハンドルの見かけサイズをズームに追従 (構造不変なので座標/サイズ更新で済む)
    this.markDirty({ overlay: true });
    this.flushNow();
  }

  // -------------------------------------------------------------------------
  // 保存 (baking → ネイティブ保存ダイアログ)
  // -------------------------------------------------------------------------

  async save() {
    if (!this.svg) return;
    // 保留中の描画を確定させてから DOM を読む
    this.flushNow();
    const out = this.bakeSvg();
    const markSaved = () => {
      const it = this.items.find((i) => i.id === this.currentId);
      if (it) it.edited = true;
      this.renderList();
      this.highlightActiveInList();
    };
    if (hasFsAccess()) {
      this.setStatus("保存先を選択してください…");
      try {
        const handle = await window.showSaveFilePicker({
          suggestedName: this.name || "edited.svg",
          types: SVG_PICKER_TYPES,
        });
        const w = await handle.createWritable();
        await w.write(out);
        await w.close();
        this.setStatus(`保存しました → ${handle.name}`, "ok");
        markSaved();
      } catch (e) {
        if (e && e.name === "AbortError") this.setStatus("保存をキャンセルしました");
        else this.setStatus(`保存に失敗しました: ${e}`, "err");
      }
    } else {
      // 非対応ブラウザ: Blob をダウンロード (ブラウザの保存先へ)
      this.downloadSvg(out, this.name || "edited.svg");
      this.setStatus("ダウンロードフォルダに保存しました", "ok");
      markSaved();
    }
  }

  /** FS Access API 非対応時のフォールバック保存 (Blob ダウンロード) */
  downloadSvg(text, name) {
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
  bakeSvg() {
    const clone = this.svg.cloneNode(true);

    // エディタ専用要素を除去
    clone.querySelectorAll("[data-editor], [data-editor-hit]").forEach((el) => el.remove());
    // 選択ハイライト等の編集専用クラスを除去
    clone.querySelectorAll(".is-selected").forEach((el) => el.classList.remove("is-selected"));

    // 表示用に付けた width/height (ズーム) を元サイズへ戻す
    clone.setAttribute("width", `${this.baseW}px`);
    clone.setAttribute("height", `${this.baseH}px`);

    // 各ラベル: text transform を x/y へ焼き込み、非表示 leader を除去
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
            // dy は相対値なので不変
          });
          text.removeAttribute("transform");
        }
      }
      const path = g.querySelector("path");
      if (path) {
        if (path.style.display === "none") {
          path.remove();
        } else {
          // 表示用に付けた display だけ消す。入力 SVG 由来の他の inline style は保持。
          path.style.removeProperty("display");
          if (!path.getAttribute("style")) path.removeAttribute("style");
        }
      }
    });

    const xml = new XMLSerializer().serializeToString(clone);
    return `<?xml version="1.0" encoding="UTF-8"?>\n${xml}`;
  }

  // -------------------------------------------------------------------------
  // ファイル一覧 (メモリ保持) & 開く
  // -------------------------------------------------------------------------

  async openFiles() {
    this.setStatus("ファイルを選択してください…");
    let files = [];
    if (hasFsAccess()) {
      let handles;
      try {
        handles = await window.showOpenFilePicker({ multiple: true, types: SVG_PICKER_TYPES });
      } catch (e) {
        if (e && e.name === "AbortError") { this.setStatus("ファイルが選択されませんでした"); return; }
        this.setStatus(`読込に失敗しました: ${e}`, "err");
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
      files = await this.pickFilesFallback();
    }
    if (!files || !files.length) {
      this.setStatus("ファイルが選択されませんでした");
      return;
    }
    // 同名でも別ファイルとして区別したいので name で重複排除せず、各々へ一意 id を振る。
    const added = files.map((f) => {
      const it = { ...f, id: ++this._itemSeq, edited: false };
      this.items.push(it);
      return it;
    });
    this.renderList();
    await this.load(added[0]);
    // 読込が済んだら「位置を調整」へ進む
    this.goPhase(2);
  }

  /** ドラッグ＆ドロップされた .svg ファイルを取り込む（手順1 のドロップゾーン） */
  async handleDrop(dt) {
    if (!dt) return;
    const dropped = [...(dt.files || [])].filter((f) => /\.svg$/i.test(f.name) || f.type === "image/svg+xml");
    if (!dropped.length) { this.setStatus("SVG ファイルをドロップしてください"); return; }
    const files = [];
    for (const file of dropped) {
      try { files.push({ name: file.name, content: await file.text() }); }
      catch (e) { files.push({ name: file.name, content: "", error: String(e) }); }
    }
    const added = files.map((f) => {
      const it = { ...f, id: ++this._itemSeq, edited: false };
      this.items.push(it);
      return it;
    });
    this.renderList();
    await this.load(added[0]);
    this.goPhase(2);
  }

  /** FS Access API 非対応時のフォールバック: <input type=file> で複数選択 */
  pickFilesFallback() {
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
      // キャンセル検知 (focus が戻り files が空なら空配列で解決)
      window.addEventListener("focus", () => setTimeout(() => {
        if (!done && (!input.files || !input.files.length)) { done = true; input.remove(); resolve([]); }
      }, 500), { once: true });
      document.body.appendChild(input);
      input.click();
    });
  }

  /** ラベルが初期状態から変更されているか (編集済みドット用) */
  isLabelEdited(s) {
    if (!s) return false;
    return JSON.stringify(s.snapshot()) !== JSON.stringify(s.initial);
  }

  /** 左レール: ファイル一覧 + 選択中ファイルのラベル一覧 */
  buildRail() {
    const list = this.dom.list;
    if (!list) return;
    list.replaceChildren();
    if (!this.items.length) {
      list.innerHTML = EMPTY_LIST_HTML;
      drawIcons(list);
      return;
    }
    for (const it of this.items) {
      const isCur = it.id === this.currentId;
      const item = document.createElement("div");
      item.className = "fileitem" + (isCur ? " cur" : "");
      item.dataset.id = it.id;
      let status = "";
      if (it.edited) status = '<span class="rok"><i data-ic="check"></i></span>';
      else if (isCur) status = '<span class="rdot" title="編集中"></span>';
      item.innerHTML = `<span class="rp"></span><span class="rn">${escapeHtml(it.name.replace(/\.svg$/i, ""))}</span>${status}`;
      item.addEventListener("click", (e) => {
        if (e.target.closest(".lblrow")) return;
        if (it.id !== this.currentId) this.load(it);
      });
      list.appendChild(item);
      // 選択中ファイルの直下にラベル一覧
      if (isCur && this.labels.length) {
        const sub = document.createElement("div");
        sub.className = "lblsub";
        sub.innerHTML = this.labels.map((s, i) =>
          `<div class="lblrow${s === this.selected ? " on" : ""}" data-idx="${i}">` +
          `<span class="ld${this.isLabelEdited(s) ? " ed" : ""}"></span>` +
          `<span class="nm">${escapeHtml(s.name)}</span>` +
          (s.percentText ? `<span class="pc">${escapeHtml(s.percentText)}</span>` : "") +
          `</div>`
        ).join("");
        list.appendChild(sub);
        sub.querySelectorAll(".lblrow").forEach((r) =>
          r.addEventListener("click", () => this.selectLabel(this.labels[+r.dataset.idx]))
        );
      }
    }
    drawIcons(list);
  }

  /** 手順1の「開いたファイル」一覧 */
  renderOpenList() {
    const el = this.dom.openList;
    if (!el) return;
    if (this.dom.openCount) this.dom.openCount.textContent = this.items.length ? `${this.items.length} 件` : "";
    el.replaceChildren();
    for (const it of this.items) {
      const card = document.createElement("div");
      card.className = "file-card clickable";
      card.innerHTML =
        `<div class="fic"><i data-ic="file"></i></div>` +
        `<div class="fmeta"><div class="fname">${escapeHtml(it.name)}</div><div class="fsub">${it.edited ? "保存済み" : "未保存"}</div></div>` +
        (it.edited ? '<span class="rok"><i data-ic="check"></i></span>' : "");
      card.addEventListener("click", async () => { await this.load(it); this.goPhase(2); });
      el.appendChild(card);
    }
    drawIcons(el);
  }

  /** トップバー/ページナビ/ズーム%/保存画面 の文言を最新化 */
  updateChrome() {
    if (this.dom.fileChip) this.dom.fileChip.textContent = this.name || "ファイル未選択";
    if (this.dom.pgInfo) {
      if (!this.svg) this.dom.pgInfo.textContent = "ファイル未選択";
      else if (this.selected) this.dom.pgInfo.innerHTML = `選択中：<b>${escapeHtml(this.selected.name)}</b>（ラベル ${this.labels.length} 個）`;
      else this.dom.pgInfo.innerHTML = `ラベル <b>${this.labels.length}</b> 個（クリックで選択）`;
    }
    if (this.dom.zoomLvl) this.dom.zoomLvl.textContent = `${Math.round(this.zoom * 100)}%`;
    if (this.dom.saveName) this.dom.saveName.textContent = this.name || "ファイル未選択";
    if (this.dom.saveSub) this.dom.saveSub.textContent = this.svg ? `ラベル ${this.labels.length} 個` : "—";
  }

  /** レールのラベル行の選択/編集済み表示だけを軽量更新（毎フレーム可） */
  _syncRail() {
    const list = this.dom.list;
    if (!list) return;
    list.querySelectorAll(".lblrow").forEach((r) => {
      const s = this.labels[+r.dataset.idx];
      r.classList.toggle("on", s === this.selected);
      const ld = r.querySelector(".ld");
      if (ld) ld.classList.toggle("ed", this.isLabelEdited(s));
    });
    this.updateChrome();
  }

  /** 互換: 旧 renderList()/highlightActiveInList() の呼び出し元をそのまま活かす */
  renderList() { this.buildRail(); this.renderOpenList(); this.updateChrome(); }
  highlightActiveInList() { this.buildRail(); this.updateChrome(); }

  // -------------------------------------------------------------------------
  // イベント配線
  // -------------------------------------------------------------------------

  bindEvents() {
    // 開く（手順1 ドロップゾーン / レールのボタン）
    if (this.dom.dropzone) {
      this.dom.dropzone.addEventListener("click", () => this.openFiles());
      this.dom.dropzone.addEventListener("dragover", (e) => { e.preventDefault(); this.dom.dropzone.classList.add("dragover"); });
      this.dom.dropzone.addEventListener("dragleave", () => this.dom.dropzone.classList.remove("dragover"));
      this.dom.dropzone.addEventListener("drop", (e) => {
        e.preventDefault();
        this.dom.dropzone.classList.remove("dragover");
        this.handleDrop(e.dataTransfer);
      });
    }
    if (this.dom.btnOpenRail) this.dom.btnOpenRail.addEventListener("click", () => this.openFiles());

    // 保存 / Undo / Redo / 全体リセット / ズーム
    this.dom.btnSave.addEventListener("click", () => this.save());
    this.dom.btnUndo.addEventListener("click", () => this.undo());
    if (this.dom.btnRedo) this.dom.btnRedo.addEventListener("click", () => this.redo());
    this.dom.btnReset.addEventListener("click", () => {
      const it = this.items.find((i) => i.id === this.currentId);
      if (it) this.load(it);
    });
    this.dom.btnZoomIn.addEventListener("click", () => this.setZoom(this.zoom * CONFIG.zoomStep));
    this.dom.btnZoomOut.addEventListener("click", () => this.setZoom(this.zoom / CONFIG.zoomStep));

    // ウィザード遷移（フッター / ステップバー）
    if (this.dom.btnBack) this.dom.btnBack.addEventListener("click", () => this.goPhase(this.phase - 1));
    if (this.dom.btnNext) this.dom.btnNext.addEventListener("click", () => this.goPhase(this.phase + 1));
    if (this.dom.stepbar) {
      this.dom.stepbar.querySelectorAll(".step").forEach((st) => {
        st.addEventListener("click", () => this.goPhase(+st.dataset.step));
      });
    }

    window.addEventListener("keydown", (e) => {
      // Redo: Ctrl+Y / Ctrl+Shift+Z
      if ((e.ctrlKey || e.metaKey) && (e.key.toLowerCase() === "y" || (e.shiftKey && e.key.toLowerCase() === "z"))) {
        e.preventDefault();
        this.redo();
        return;
      }
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "z") {
        e.preventDefault();
        this.undo();
        return;
      }
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "s") {
        e.preventDefault();
        this.save();
        return;
      }
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "o") {
        e.preventDefault();
        this.openFiles();
        return;
      }
      if (e.key === "Escape") {
        this.selectLabel(null);
        return;
      }
      // 入力欄/スライダ(長体)にフォーカス中は矢印をそのコントロールに委ね、ラベル移動はしない
      const ae = document.activeElement;
      if (ae && (ae.tagName === "INPUT" || ae.tagName === "TEXTAREA" || ae.isContentEditable)) return;
      if (!this.selected) return;
      const step = e.shiftKey ? CONFIG.nudgeStepFast : CONFIG.nudgeStep;
      const map = { ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, -step], ArrowDown: [0, step] };
      if (map[e.key]) {
        e.preventDefault();
        this.nudge(map[e.key][0], map[e.key][1]);
      }
    });
  }
}

export { Editor };
