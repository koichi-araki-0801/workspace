import { SVG_NS, CONFIG } from "./constants.js";

    // ---------------------------------------------------------------------------
    // 純粋ユーティリティ (状態を持たない)
    // ---------------------------------------------------------------------------

    // parsePath / buildPath / parseTranslate は lib/leader_geom.cjs へ移設 (冒頭で分割代入)。

    function escapeHtml(s) {
      return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
    }

    function round(n) {
      return Math.round(n * CONFIG.roundPrecision) / CONFIG.roundPrecision;
    }

    /** SVG 要素を生成し属性をまとめて設定する (値は setAttribute へ渡り文字列化される)。 */
    function createSvgEl(tag, attrs = {}) {
      const el = document.createElementNS(SVG_NS, tag);
      for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v);
      return el;
    }

    /** getBBox は detached/未レイアウト時に例外を投げる。失敗時は fallback を返す。 */
    function safeGetBBox(el, fallback = { x: 0, y: 0, width: 0, height: 0 }) {
      try {
        return el.getBBox();
      } catch {
        return fallback;
      }
    }

    /** トグルボタンの active クラス文字列 ("on" or "") */
    const onClass = (cond) => (cond ? "on" : "");

    /** インスペクタの移動量表示 (構築時と読出し更新で同一文字列を使う) */
    const formatCoords = (tx) => `移動量 dx ${tx.x.toFixed(1)} / dy ${tx.y.toFixed(1)} px`;

    // normColor は lib/leader_geom.cjs へ移設 (冒頭で分割代入)。

    /** 未信頼 SVG を DOM 接続前に無害化する (多層防御)。
     *  innerHTML 経由では <script> は実行されないが、<image onerror> 等のインライン
     *  イベント属性は発火しうる。接続前に DOMParser で組み立て、<script> 要素・on* 属性・
     *  javascript: な href を除去した <svg> 要素を返す。解釈不能なら null。 */
    function sanitizeSvg(svgText) {
      const doc = new DOMParser().parseFromString(svgText, "image/svg+xml");
      const root = doc.documentElement;
      if (!root || root.nodeName === "parsererror" || root.querySelector("parsererror")) return null;
      if (root.nodeName.toLowerCase() !== "svg") return null;
      const strip = (el) => {
        for (const attr of [...el.attributes]) {
          const name = attr.name.toLowerCase();
          if (name.startsWith("on")) el.removeAttribute(attr.name);
          else if ((name === "href" || name === "xlink:href") && /^\s*javascript:/i.test(attr.value)) el.removeAttribute(attr.name);
        }
      };
      root.querySelectorAll("script").forEach((el) => el.remove());
      strip(root);
      const walker = doc.createTreeWalker(root, NodeFilter.SHOW_ELEMENT);
      let node;
      while ((node = walker.nextNode())) strip(node);
      return root;
    }

    // File System Access API が使えるか (Chromium 系 + secure context=localhost)。
    function hasFsAccess() {
      return typeof window.showOpenFilePicker === "function" && typeof window.showSaveFilePicker === "function";
    }

    // 開く/保存ダイアログのファイル種別フィルタ。
    const SVG_PICKER_TYPES = [{ description: "SVG ファイル", accept: { "image/svg+xml": [".svg"] } }];

    // 編集で変化し Undo/リセット対象となるフィールドと、その複製方法を一元定義。
    // LabelState.snapshot / apply の双方がこれを参照するため、項目追加はここ 1 箇所で済む。
    const STATE_FIELDS = {
      textTx: (v) => ({ ...v }),
      leaderPts: (v) => v.map((p) => ({ ...p })),
      leaderVisible: (v) => v,
      fill: (v) => v,
      lineCount: (v) => v,    // 1 | 2 (1行化/2行化)
      nameScaleX: (v) => v,   // 名前の横圧縮率 (長体)。1=圧縮なし
    };

export { escapeHtml, round, createSvgEl, safeGetBBox, onClass, formatCoords, sanitizeSvg, hasFsAccess, SVG_PICKER_TYPES, STATE_FIELDS };
