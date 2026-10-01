// =============================================================================
// fundImageLayer.ts — 編集画面の canvas にファンド別画像を CSS で差す(GrapesJS への配線)
// =============================================================================
// 何を差すかの判断は `fundImages.ts`(純関数)が持ち、ここは canvas の DOM を走査して canvas
// 専用の `<style>` を書き直すだけ。属性もモデルも触らないので、保存内容(getHtml/getCss)には
// 何も載らない。GrapesJS の image component にならない `<img>`(Jinja のブロックにまとめた
// 範囲の中など)も、DOM の走査なので同じ規則で表示される。
//
// `content:url()` の画像は `load` イベントを出さないので、ページ境界・幾何の再計測は 2 つの
// 契機で起こす。1 つは親 window での先読み(`Image` + `decode()`)の完了で、早めに確定させる
// 補助。ただし配信は `no-store` なので、canvas 側の取得は先読みとは別のリクエストになりうり、
// 先読みが済んだ時点で canvas の画像が描画済みとは限らない。そこで本命として canvas の body を
// `ResizeObserver` で見張り、画像が描画されて大きさが変わったところで測り直す。

import type { Editor } from 'grapesjs';
import { type FundImageContext, fundImageCss, needsFundImageWarning } from './fundImages';

/** canvas の head に置く差し替え用 `<style>` の目印。 */
export const FUND_IMAGE_STYLE_ATTR = 'data-fund-images';

/** このモジュールが editor に求める面(テストで最小の偽物を渡せるよう絞る)。 */
export type FundImageHost = Pick<Editor, 'on' | 'Canvas'>;

export interface FundImageLayerOptions {
  /** 現在の本文の種類とファンドコード(読み込みのたびに変わりうるので関数で受ける)。 */
  getContext: () => FundImageContext;
  /** 差した画像の読み込みが済んだ(ページ境界・幾何を測り直す契機)。 */
  onImagesReady: () => void;
  /** 値入り本文の解けない参照の有無が変わった。 */
  onWarningChange: (on: boolean) => void;
  /** 画像の先読み(テストで差し替える)。既定は `Image` + `decode()`。 */
  preload?: (url: string) => Promise<void>;
  /** 走査の間引き(テストで同期にする)。既定は rAF で 1 フレーム 1 回。 */
  schedule?: (cb: () => void) => void;
  /** canvas の body の大きさが変わった(画像の描画完了などで測り直す契機)。 */
  onCanvasResize?: () => void;
  /**
   * body の監視に使う `ResizeObserver`(テストで偽物を注入する)。既定は canvas の window の
   * もの。どちらも無い環境(jsdom)では監視しない。
   */
  ResizeObserver?: typeof ResizeObserver;
}

export interface FundImageLayer {
  /** canvas を走査して規則と警告を作り直す。 */
  refresh(): void;
  /** body の監視を外す(editor の破棄時)。 */
  destroy(): void;
}

function defaultPreload(url: string): Promise<void> {
  const img = new Image();
  img.src = url;
  return typeof img.decode === 'function' ? img.decode() : Promise.resolve();
}

/**
 * canvas にファンド別画像の差し替え層を張る。走査の契機は読み込み時と、component の追加・
 * 削除・更新(属性変更を含む)の後。テキスト入力中は高頻度で発火するので 1 フレームへ集約する。
 */
export function attachFundImages(host: FundImageHost, opts: FundImageLayerOptions): FundImageLayer {
  const preload = opts.preload ?? defaultPreload;
  const schedule = opts.schedule ?? ((cb: () => void) => requestAnimationFrame(cb));
  let styleEl: HTMLStyleElement | null = null;
  let lastCss = '';
  let lastWarning = false;
  let pending = false;
  /** この document で先読みを始めた URL(document が変われば数え直す)。 */
  const preloaded = new Set<string>();
  /** canvas の document ごとに 1 つの body 監視。document が替われば外して作り直す。 */
  let observer: ResizeObserver | null = null;
  let observedDoc: Document | null = null;
  let observedBody: HTMLElement | null = null;
  /** 最後に見た body の大きさ。同じ大きさでは測り直さない(測り直しが大きさを変えない限り止まる)。 */
  let lastSize = '';

  const disconnect = (): void => {
    observer?.disconnect();
    observer = null;
    observedDoc = null;
    observedBody = null;
    lastSize = '';
  };

  const observeBody = (doc: Document): void => {
    if (!opts.onCanvasResize) return;
    const body = doc.body;
    if (!body) return;
    if (observer && observedDoc === doc) {
      if (observedBody === body) return;
      // load で body が差し替わったら、同じ observer の監視先を移す。
      observer.disconnect();
      observer.observe(body);
      observedBody = body;
      lastSize = '';
      return;
    }
    disconnect();
    const RO = opts.ResizeObserver ?? doc.defaultView?.ResizeObserver;
    if (!RO) return;
    const onResize = opts.onCanvasResize;
    observer = new RO((entries) => {
      const rect = entries[entries.length - 1]?.contentRect;
      if (!rect) return;
      const size = `${rect.width}x${rect.height}`;
      if (size === lastSize) return;
      lastSize = size;
      onResize();
    });
    observer.observe(body);
    observedDoc = doc;
    observedBody = body;
  };

  const ensureStyle = (doc: Document): HTMLStyleElement => {
    if (styleEl?.isConnected && styleEl.ownerDocument === doc) return styleEl;
    styleEl = doc.createElement('style');
    styleEl.setAttribute(FUND_IMAGE_STYLE_ATTR, '');
    doc.head.appendChild(styleEl);
    lastCss = '';
    preloaded.clear();
    return styleEl;
  };

  const refresh = (): void => {
    const doc = host.Canvas.getDocument();
    if (!doc?.head) return;
    const srcs = Array.from(doc.querySelectorAll('img'), (img) => img.getAttribute('src') ?? '');
    const ctx = opts.getContext();
    const { css, urls } = fundImageCss(srcs, ctx);
    const el = ensureStyle(doc);
    observeBody(doc);
    // 同じ内容なら書き直さない(書き直すと no-store の画像を取り直して表示がちらつく)。
    if (css !== lastCss) {
      el.textContent = css;
      lastCss = css;
    }
    const fresh = urls.filter((u) => !preloaded.has(u));
    for (const u of fresh) preloaded.add(u);
    if (fresh.length > 0) {
      void Promise.allSettled(fresh.map((u) => preload(u))).then(() => opts.onImagesReady());
    }
    const warning = needsFundImageWarning(srcs, ctx);
    if (warning !== lastWarning) {
      lastWarning = warning;
      opts.onWarningChange(warning);
    }
  };

  const scheduleRefresh = (): void => {
    if (pending) return;
    pending = true;
    schedule(() => {
      pending = false;
      refresh();
    });
  };

  host.on('load', refresh);
  host.on('canvas:frame:load', refresh);
  host.on('component:add', scheduleRefresh);
  host.on('component:remove', scheduleRefresh);
  host.on('component:update', scheduleRefresh);
  return { refresh, destroy: disconnect };
}

/** GrapesJS の image view の、ここで使う面だけ。 */
interface ImageViewLike {
  model: { get(key: string): unknown };
}

/**
 * image の view を拡張し、差し替え対象の `src` では読み込み失敗時の代替画像処理(`onError` で
 * `el.src` を差し替える)を止める。差し替わると `img[src="…"]` のセレクタが外れて画像が出ない。
 * component の生成より前(`init` の中)で呼ぶこと。
 */
export function registerFundImageView(ed: Editor, isTarget: (src: string) => boolean): void {
  const dc = ed.DomComponents;
  const base = dc.getType('image')?.view as unknown as
    | { prototype: { onError(this: ImageViewLike): void } }
    | undefined;
  if (base === undefined) return;
  const view = {
    onError(this: ImageViewLike): void {
      const src = this.model.get('src');
      if (typeof src === 'string' && isTarget(src)) return;
      base.prototype.onError.call(this);
    },
  };
  dc.addType('image', { view } as unknown as Parameters<typeof dc.addType>[1]);
}
