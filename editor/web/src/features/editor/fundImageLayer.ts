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
//
// テンプレの CSS の `url()`(フォント・背景画像)も同じ理由で canvas では解けないので、
// `canvasCssAssets.ts` が作る複製を、もう 1 枚の canvas 専用 `<style>` に置く。こちらは head では
// なく body の末尾に置く: GrapesJS は CSS 規則の入れ物を body の中(本文の後ろ)に置くので、
// head に置くと同じ `@font-face`・同じセレクタの規則に負ける。走査のたびに末尾にあるかを確かめ、
// 後ろに要素が足されていたら末尾へ戻す。本文の `<style>` も同じ `<style>` に複製する(参照元は
// 文書の位置)。本文の `<style>` は GrapesJS が canvas に置かない(`bodyStyle.ts`)ので、`url()` の
// 規則だけでなく全規則を複製する。並びは「本文の `<style>` → テンプレの CSS」。
//
// GrapesJS が canvas に描く元の `@font-face` は、描く直前(`css:mount:before`)に取得先を無効にする
// (`canvasFontFaceSrcDisabled`)。複製を後ろに置くだけでは、複製の読み込みに失敗したときなどに
// Chromium が元の規則へ取りに行く。
//
// 配信ルートは SVG の検査で弾いた画像を理由なしの 404 にするので、先読みに失敗した画像だけを
// 画像の確認(`inspect`)へ 1 回にまとめて問い合わせ、`svg_rejected` を理由付きで警告欄に足す。
// 成功した画像は問い合わせず、同じ参照は 2 度問い合わせない(結果は document をまたいで使う)。

import type { FundAssetInspectResult, FundAssetRef, Result } from '@editor/shared';
import { isOk } from '@editor/shared';
import type { Editor } from 'grapesjs';
import {
  cssImageIssues,
  type ImageRefIssue,
  type SvgRejectedImage,
  svgRejectedImages,
  svgRejectedMessage,
} from '@/lib/assetWarnings';
import { type FundImageRef, fundImageUrl } from '@/lib/fundImages';
import {
  canvasCssAssetCopy,
  canvasCssFullCopy,
  canvasFontFaceSrcDisabled,
} from './canvasCssAssets';
import {
  type FundImageContext,
  fundImageCss,
  fundImageWarnings,
  resolveFundImageSrc,
} from './fundImages';

/** canvas の head に置く差し替え用 `<style>` の目印。 */
export const FUND_IMAGE_STYLE_ATTR = 'data-fund-images';

/** canvas の body 末尾に置く、CSS の url() 規則の複製用 `<style>` の目印。 */
export const CANVAS_CSS_ASSET_ATTR = 'data-canvas-css-assets';

/** このモジュールが editor に求める面(テストで最小の偽物を渡せるよう絞る)。 */
export type FundImageHost = Pick<Editor, 'on' | 'Canvas'>;

export interface FundImageLayerOptions {
  /** 現在の本文の種類とファンドコード(読み込みのたびに変わりうるので関数で受ける)。 */
  getContext: () => FundImageContext;
  /** 差した画像の読み込みが済んだ(ページ境界・幾何を測り直す契機)。 */
  onImagesReady: () => void;
  /** 警告欄の文(`{{` の残る参照・配信されない参照・会社フォルダ不一致)が変わった。 */
  onWarningsChange: (messages: string[]) => void;
  /**
   * 画像が配信されるかの確認(`FundAssetRepository.inspect`)。先読みに失敗した画像の理由を
   * 知るために使う。省略時は問い合わせない。
   */
  inspect?: (refs: readonly FundAssetRef[]) => Promise<Result<FundAssetInspectResult[]>>;
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

/** 複製する CSS 1 本と、その参照を解く基準の論理パス。 */
export interface CssAssetSource {
  css: string;
  /** テンプレの CSS は `TEMPLATE_CSS_FROM`、本文の `<style>` は `DOC_DIR`。 */
  from: string;
  /**
   * 全規則を複製する(`canvasCssFullCopy`)。canvas に元の規則が無い本文の `<style>` で立てる。
   * 省略時は `url()` の規則だけ(`canvasCssAssetCopy`)。
   */
  whole?: boolean;
}

export interface FundImageLayer {
  /** canvas を走査して規則と警告を作り直す。 */
  refresh(): void;
  /**
   * 本文の `<style>` とテンプレの CSS を受け取り、複製を作り直す(canvas の CSS を入れ替える
   * たび・本文の `<style>` が増減するたびに呼ぶ)。複製は渡した順に並ぶ。
   */
  setCss(sources: readonly CssAssetSource[]): void;
  /** body の監視を外し、以後の走査を止める(editor の破棄時。破棄より前に呼ぶ)。 */
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
  let lastWarnings = '';
  let pending = false;
  /** この document で先読みを始めた URL(document が変われば数え直す)。 */
  const preloaded = new Set<string>();
  /** canvas の document ごとに 1 つの body 監視。document が替われば外して作り直す。 */
  let observer: ResizeObserver | null = null;
  let observedDoc: Document | null = null;
  let observedBody: HTMLElement | null = null;
  /** 最後に見た body の大きさ。同じ大きさでは測り直さない(測り直しが大きさを変えない限り止まる)。 */
  let lastSize = '';
  /**
   * 破棄済み。editor の破棄は Canvas を外したうえで component:remove を出すので、その契機で
   * 予約された走査が後から canvas を読みに行かないよう止める。
   */
  let destroyed = false;
  /** 現在の CSS の url() 規則の複製と、それを作った入力(同じ入力なら作り直さない)。 */
  let cssInput: readonly CssAssetSource[] = [];
  let cssCompany: string | null = null;
  let cssCopy = '';
  let cssIssues: Array<[string, ImageRefIssue]> = [];
  let assetEl: HTMLStyleElement | null = null;
  let lastAssetCss: string | null = null;
  /** 確認を問い合わせた参照(結果の成否を問わず 2 度は問い合わせない)。 */
  const inspected = new Set<string>();
  /** SVG の検査で配信しないと分かった参照。警告に出すのは canvas に今ある参照の分だけ。 */
  const rejected = new Map<string, SvgRejectedImage>();
  /** 直近の走査の、確認とは別の警告と、canvas にある差し替え対象の参照。 */
  let baseWarnings: string[] = [];
  let currentRefs = new Set<string>();

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

  /** 複製を body の末尾に置く。複製が一度も無いうちは要素を作らない。 */
  const syncAssetStyle = (doc: Document): void => {
    const body = doc.body;
    if (!body) return;
    if (cssCopy === '' && assetEl === null) return;
    if (assetEl === null || assetEl.ownerDocument !== doc) {
      assetEl = doc.createElement('style');
      assetEl.setAttribute(CANVAS_CSS_ASSET_ATTR, '');
      lastAssetCss = null;
    }
    if (body.lastElementChild !== assetEl) body.appendChild(assetEl);
    if (cssCopy !== lastAssetCss) {
      assetEl.textContent = cssCopy;
      lastAssetCss = cssCopy;
    }
  };

  /** 入力の CSS ごとに複製と画像の問題を作り、渡された順に連結する。 */
  const rebuildCssCopy = (companyCode: string | null): void => {
    cssCompany = companyCode;
    cssCopy = cssInput
      .map(({ css, from, whole }) =>
        whole
          ? canvasCssFullCopy(css, companyCode, from)
          : canvasCssAssetCopy(css, companyCode, from),
      )
      .filter((copy) => copy !== '')
      .join('\n');
    cssIssues = cssInput.flatMap(({ css, from }) => cssImageIssues(css, from, companyCode));
  };

  /** 会社コードが変わったときだけ複製を作り直す(走査は高頻度なので CSS の分割を毎回しない)。 */
  const updateCssCopy = (companyCode: string | null): void => {
    if (cssInput.length === 0 || companyCode === cssCompany) return;
    rebuildCssCopy(companyCode);
  };

  const emitWarnings = (): void => {
    const svg = svgRejectedMessage(
      [...rejected].filter(([key]) => currentRefs.has(key)).map(([, img]) => img),
    );
    const warnings = svg === null ? baseWarnings : [...baseWarnings, svg];
    const key = warnings.join('\n');
    if (key !== lastWarnings) {
      lastWarnings = key;
      opts.onWarningsChange(warnings);
    }
  };

  /** 先読みに失敗した参照のうち、まだ問い合わせていないものを 1 回で問い合わせる。 */
  const inspectFailed = async (refs: readonly FundImageRef[]): Promise<void> => {
    const fresh = refs.filter((ref) => !inspected.has(refKey(ref)));
    if (opts.inspect === undefined || fresh.length === 0) return;
    for (const ref of fresh) inspected.add(refKey(ref));
    let res: Result<FundAssetInspectResult[]>;
    try {
      res = await opts.inspect(fresh);
    } catch {
      return;
    }
    // 問い合わせの失敗は警告にしない(理由が分からないだけで、編集は続けられる)。一時的な失敗でも
    // 同じ画面では問い合わせ直さない(先読みの失敗のたびに問い合わせが重なるのを避ける)。開き直せば
    // もう一度問い合わせる。
    if (destroyed || !isOk(res)) return;
    const found = svgRejectedImages(res.value);
    if (found.length === 0) return;
    for (const img of found) rejected.set(refKey(img.ref), img);
    emitWarnings();
  };

  const refreshIn = (doc: Document | null | undefined): void => {
    if (destroyed) return;
    if (!doc?.head) return;
    const srcs = Array.from(doc.querySelectorAll('img'), (img) => img.getAttribute('src') ?? '');
    const ctx = opts.getContext();
    updateCssCopy(ctx.companyCode);
    const { css, urls } = fundImageCss(srcs, ctx);
    const el = ensureStyle(doc);
    observeBody(doc);
    syncAssetStyle(doc);
    // 同じ内容なら書き直さない(書き直すと no-store の画像を取り直して表示がちらつく)。
    if (css !== lastCss) {
      el.textContent = css;
      lastCss = css;
    }
    const refOfUrl = new Map<string, FundImageRef>();
    for (const src of srcs) {
      const ref = resolveFundImageSrc(src, ctx);
      if (ref !== null) refOfUrl.set(fundImageUrl(ref), ref);
    }
    currentRefs = new Set([...refOfUrl.values()].map(refKey));
    const fresh = urls.filter((u) => !preloaded.has(u));
    for (const u of fresh) preloaded.add(u);
    if (fresh.length > 0) {
      void Promise.allSettled(fresh.map((u) => preload(u))).then((settled) => {
        opts.onImagesReady();
        const failed = fresh.flatMap((u, i) => {
          const ref = settled[i]?.status === 'rejected' ? refOfUrl.get(u) : undefined;
          return ref === undefined ? [] : [ref];
        });
        void inspectFailed(failed);
      });
    }
    baseWarnings = fundImageWarnings(srcs, ctx, cssIssues);
    emitWarnings();
  };

  const refresh = (): void => {
    if (!destroyed) refreshIn(host.Canvas.getDocument());
  };

  const scheduleRefresh = (): void => {
    if (pending || destroyed) return;
    pending = true;
    schedule(() => {
      pending = false;
      refresh();
    });
  };

  host.on('load', refresh);
  host.on('canvas:frame:load', refresh);
  // body が描かれた直後(GrapesJS が CSS 規則の入れ物を置いたのと同じタスクの中)に複製を置き、
  // 描画とフォントの読み込みが始まる前に入れておく。document は `Canvas.getDocument()` に頼らず
  // イベントの window から取る(canvas の view が揃う前でも取れる)。
  host.on('canvas:frame:load:body', (ev?: { window?: Window }) => refreshIn(ev?.window?.document));
  // GrapesJS が規則を canvas の `<style>` に書く直前に、元の `@font-face` の取得先を無効にする
  // (描き直しのたびに通る。モデルは変えないので保存内容には影響しない)。
  host.on('css:mount:before', (props: { css: string }) => {
    props.css = canvasFontFaceSrcDisabled(props.css);
  });
  host.on('component:add', scheduleRefresh);
  host.on('component:remove', scheduleRefresh);
  host.on('component:update', scheduleRefresh);
  const destroy = (): void => {
    destroyed = true;
    disconnect();
  };

  const setCss = (sources: readonly CssAssetSource[]): void => {
    cssInput = sources;
    rebuildCssCopy(opts.getContext().companyCode);
    refresh();
  };

  return { refresh, setCss, destroy };
}

/** 参照の同一性の鍵(`dir` の null と空文字を区別する)。 */
function refKey(ref: FundImageRef): string {
  return JSON.stringify([ref.dir, ref.file]);
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
