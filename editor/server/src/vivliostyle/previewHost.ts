// =============================================================================
// previewHost.ts — 画面内プレビューを opaque オリジンへ隔離するビューアホストページ
// =============================================================================
// これまで画面内プレビューは `@vivliostyle/core` を **アプリ本体の document** に直接描画して
// いた。テンプレの JS は正当なコンテンツ(列幅自動調整など)で動かす必要があるのに、そこで
// 動かせばアプリと同一オリジン = セッション cookie も承認 API も射程に入る。だから今までは
// プレビューだけ script を落としており、「PDF では JS が効き、プレビューでは効かない」という
// 見た目の食い違いが残っていた。
//
// 本モジュールはその不整合を「**除去でなく隔離**」で解く。サーバがビューアホストページを
// 配信し、web はそれを `sandbox="allow-scripts"`(= `allow-same-origin` なし)の iframe の
// src に置く。子は opaque オリジンになり、親の DOM にも cookie にも触れない。
//
// ── なぜ srcdoc / blob ではなくサーバ配信なのか(実測に基づく判断) ──
// srcdoc 文書も blob 文書も**親応答の CSP を継承する**(sandbox 属性は CSP の免除にならない)。
// 本番の全域 CSP は `script-src 'self' 'unsafe-eval' <index.html のハッシュ>` で
// `'unsafe-inline'` を持たないため、テンプレの inline JS は**原理的に**動かせない — 内容が
// 利用者由来の可変文字列で事前ハッシュ不能であり、`'unsafe-inline'` をハッシュと併記しても
// ブラウザは無視する(実測)。全域 CSP を `'unsafe-inline'` 化するのは SPA 本体の script 注入
// 防御を捨てる話なので採らない。
// 一方**ネットワーク応答の文書は親 CSP を継承せず、自分の応答ヘッダの CSP に従う**(実測)。
// よって「この経路だけ緩い CSP」を持てる。前例は `/api/docs`(`openapi/docsRoutes.ts`)。
//
// ── ビューアバンドルの載せ方 ──
// **ホストページへインライン内蔵する。** opaque オリジンの子が発するサブリソース要求は
// site-for-cookies が空 = cross-site 扱いになり、SameSite=Lax のセッション cookie が
// **付かない**(実測: index.html のナビゲーションには付き 200、子からの `<script src>` は
// cookie 欠落)。認証オン配備(rest / lan)では `<script src="vivliostyle.js">` が 401 になり
// プレビューが簡易表示へ黙って劣化する。子に「認証付きの取りに行く」をさせない —
// これはテンプレ JS・フォントを親が文書へ埋めるのと同じ原則(`previewSelfContain.ts`)で、
// 認証や cookie 属性(SameSite=None は Secure 必須で平文 LAN 運用と衝突)は一切緩めない。
// バンドルに `</script` が現れる将来版では inline が成立しないため、その時だけ従来の
// `<script src>` 形へ倒す(fail closed。配信ルートは保険として残す)。
import fs from 'node:fs/promises';
import path from 'node:path';
import {
  PREVIEW_HOST_BASE,
  PREVIEW_MSG_CMD,
  PREVIEW_MSG_DOC,
  PREVIEW_MSG_ERROR,
  PREVIEW_MSG_READY,
  PREVIEW_MSG_STATE,
  resolveServedAssetPath,
} from '@editor/shared';
import type { FastifyInstance } from 'fastify';
import { config } from '../config.js';
import { requireAuth } from '../middleware/auth.js';
import { resolveServedAssetSource } from './docAssets.js';

/**
 * この経路**だけ**に効かせる CSP。全域 CSP(`config.buildCspDirectives`)は変更しない。
 *
 * 1 行ずつ、何をなぜ許したか:
 *  - `default-src 'none'` — 既定は全部止める。以下で明示した面だけを開ける。
 *  - `script-src 'self' 'unsafe-inline' 'unsafe-eval'` — `'self'` はビューアバンドルと
 *    同梱テンプレ JS(どちらもこの接頭辞から配る)。`'unsafe-inline'` が本経路の存在理由で、
 *    テンプレの inline JS は利用者由来の可変文字列でハッシュも nonce も付けられない
 *    (nonce はページ生成のたびに変えられるが、その値は同じ文書の中で任意 script から読めて
 *    しまうので、可変本文を許す用途では `'unsafe-inline'` と等価)。`'unsafe-eval'` は
 *    この構成が実測で通った形をそのまま保つためで、テンプレ JS 側の `new Function` 依存も
 *    ここで吸収する。**緩さの射程は opaque オリジンのこの iframe 内だけ**で、アプリの
 *    オリジン・cookie・API には届かない。
 *  - `style-src 'self' 'unsafe-inline'` — 文書の `<style>`(組版 CSS の本体)が inline。
 *  - `img-src 'self' data: blob:` / `font-src 'self' data:` — 帳票の画像・埋め込みフォントと、
 *    同梱資産(この接頭辞から配る `fonts/`)。外部ホストは許さない。
 *  - `connect-src 'self' blob: data:` — core は文書を `fetch` で取る。文書は子が自分で作る
 *    blob URL(opaque オリジン)なので `blob:` が要る。`data:` は core の内蔵 UA リソース用:
 *    表セル・脚注のある文書で core は `user-agent.xml` を**バンドル埋め込みの
 *    `data:application/xml,…` へ差し替えて XHR する**(fetchInner の同 URL 判定)。ここを
 *    塞ぐと XHR が status 0 で潰れ、parser が null を返して「The target resource is
 *    invalid」でロードが中断する = **表を含む帳票のプレビューが恒久 loading・全ページ
 *    hidden になる**(実測 5/5 再現)。data: への「接続」は自文書内データの復号であり、
 *    外向きの通信先は増えない。
 *  - `frame-ancestors 'self'` — このページを埋め込めるのはアプリ自身だけ。
 *  - `base-uri 'none'` / `form-action 'none'` / `object-src 'none'` — 相対解決の付け替え・
 *    送信・プラグイン面を塞ぐ(テンプレ側の `<base>` はそもそも上流で落ちている)。
 *  - `frame-src 'none'` — 入れ子 iframe を作らせない(sandbox の再委譲を封じる)。
 */
const PREVIEW_HOST_CSP = [
  "default-src 'none'",
  "script-src 'self' 'unsafe-inline' 'unsafe-eval'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "font-src 'self' data:",
  "connect-src 'self' blob: data:",
  "frame-ancestors 'self'",
  "frame-src 'none'",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'none'",
].join('; ');

/** バンドルを配るファイル名(ホストページからの相対参照と対)。 */
const VIEWER_BUNDLE_FILE = 'vivliostyle.js';

/**
 * `@vivliostyle/core` の CJS バンドルの場所。`config.webDist` = `web/dist` の親が web
 * パッケージなので、そこの `node_modules` から引く。**server の依存に足さない**のは、
 * これが web 側の依存(画面のプレビューが使う実装)であり、依存グラフを二重化すると
 * 版が割れたときにプレビューと PDF で別の core が動くため。
 */
const VIEWER_BUNDLE_SOURCE = path.resolve(
  config.webDist,
  '..',
  'node_modules/@vivliostyle/core/lib/vivliostyle.js',
);

/** 資産の拡張子 → Content-Type。許可リスト外の拡張子はそもそも解決器が弾く。 */
const CONTENT_TYPES: Readonly<Record<string, string>> = {
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.ttf': 'font/ttf',
  '.otf': 'font/otf',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
};

/** 読み込んだバンドルのキャッシュ(765KB を毎回読まない)。 */
let bundleCache: string | null = null;

/**
 * バンドルをホストページの inline `<script>` に**そのまま**埋めてよいか。
 *
 * 書き換えはしない(fail closed の判定のみ)。`</script` の `\/` 置換はテンプレ JS
 * (`inlineDocScripts.ts`)では安全側だが、minified バンドルには `a</b/…`(比較 + 正規表現
 * リテラル)のような、置換すると構文が壊れる形が原理上ありうる。危険な字面を含む版が
 * 来たら inline を諦めて従来の `<script src>` 配信へ倒す(v2.43.1 は inline 可を確認済み)。
 *
 *  - `</script` — raw text の終端。1 つでもあれば要素がそこで閉じる。
 *  - `<!--` の後、対応する `-->` より前に `<script` — script data の二重エスケープ状態に
 *    入り、こちらが付ける終了タグが終了タグとして扱われなくなる。
 */
function bundleSafeToInline(bundle: string): boolean {
  const lower = bundle.toLowerCase();
  if (lower.includes('</script')) return false;
  for (let at = lower.indexOf('<!--'); at !== -1; at = lower.indexOf('<!--', at + 4)) {
    const close = lower.indexOf('-->', at + 4);
    const open = lower.indexOf('<script', at + 4);
    if (open !== -1 && (close === -1 || open < close)) return false;
  }
  return true;
}

/**
 * ビューアバンドルを classic script として読める形にして返す。
 *
 * npm 同梱の実体は CJS(`"use strict";…module.exports=…`)で、`<script>` で直に読むと
 * `module` 未定義で落ちる。IIFE で `module` を用意し、結果を `window.Vivliostyle` へ置く
 * だけの薄いラッパを被せる(この形で実 Chromium での起動・組版・ページ送り・ズームが
 * 通ることを実測済み)。
 */
async function viewerBundle(): Promise<string> {
  if (bundleCache !== null) return bundleCache;
  const raw = await fs.readFile(VIEWER_BUNDLE_SOURCE, 'utf8');
  bundleCache = `(function(){var module={exports:{}};var exports=module.exports;\n${raw}\n;window.Vivliostyle=module.exports;})();`;
  return bundleCache;
}

/**
 * iframe 内で動くブートスクリプト。**固定文字列**(利用者入力を 1 バイトも埋めない)で、
 * 埋め込むのは shared のメッセージ種別定数だけ。
 *
 * 責務は 4 つ:
 *  1. 親から受けた文書文字列を**子の中で** blob 化して `loadDocument` する。親が作った
 *     blob URL は opaque オリジンから読めない(実測: `URL scheme "blob" is not supported`)
 *     ので、blob 化は必ず子側で行う。
 *  2. `nav` / `readystatechange` を購読して状態を親へ返す。
 *  3. ページ送り・ズーム命令を受ける。
 *  4. **フィット計算を子で完結させる**。iframe は親のコンテナを 100% で埋めるので、
 *     `window.innerWidth/Height` がそのままコンテナ寸法になる。往復通信が要らないぶん
 *     リサイズ追随が親子の往復に律速されない。
 */
const BOOT_SCRIPT = `(function(){
  var MSG_DOC=${JSON.stringify(PREVIEW_MSG_DOC)};
  var MSG_CMD=${JSON.stringify(PREVIEW_MSG_CMD)};
  var MSG_READY=${JSON.stringify(PREVIEW_MSG_READY)};
  var MSG_STATE=${JSON.stringify(PREVIEW_MSG_STATE)};
  var MSG_ERROR=${JSON.stringify(PREVIEW_MSG_ERROR)};
  // ズームの範囲/刻み/フィット余白は編集画面(useGrapes.ts)に合わせる。
  var ZOOM_MIN=0.4, ZOOM_MAX=1.4, ZOOM_STEP=0.1, FIT_MARGIN=32;
  var V=window.Vivliostyle, viewer=null, blobUrl=null, errTimer=null;
  var currentPage=1, pageCount=0, atFirst=true, atLast=false, zoom=1, userZoomed=false, ready=false;
  // 親のオリジンは opaque な子からは指定できないため '*' 固定。運ぶのはページ番号と倍率の
  // 数値だけで、親が既に持っていない情報は 1 つも含まない。
  function post(type,extra){
    var m={type:type};
    if(extra)for(var k in extra)m[k]=extra[k];
    parent.postMessage(m,'*');
  }
  function sendState(){
    post(MSG_STATE,{state:{currentPage:currentPage,pageCount:pageCount,atFirst:atFirst,
      atLast:atLast,zoom:zoom,ready:ready}});
  }
  function clampZoom(z){return Math.min(ZOOM_MAX,Math.max(ZOOM_MIN,Math.round(z*100)/100));}
  // ready(= readyState COMPLETE)前に setOptions({zoom}) を呼ばない。core のコマンドループは
  // 「needRefresh かつ currentPage===null」の分岐で continueLoop されず**恒久停止**する
  // (bundle 原文: else if(s.needRefresh) s.currentPage&&s.showCurrent(...)。kick はコマンド
  // スロット占有で無効化され回復不能)。currentPage が null でありうるのは初回 showCurrent
  // 前だけで、COMPLETE は必ずその後 — この ready ガードで停止条件を構造的に踏めなくする。
  // フィットの初回適用は COMPLETE 時(readystatechange ハンドラ)からで、組版中はズーム 1 の
  // まま表示される(親のローダーが被さっており視覚差は出ない)。
  function applyFit(){
    if(!ready||userZoomed||!viewer)return;
    var sizes=viewer.getPageSizes?viewer.getPageSizes():null;
    var ps=sizes&&(sizes[currentPage-1]||sizes[0]);
    if(!ps||!(ps.width>0)||!(ps.height>0))return;
    var w=window.innerWidth-FIT_MARGIN, h=window.innerHeight-FIT_MARGIN;
    if(w<=0||h<=0)return;
    zoom=clampZoom(Math.min(w/ps.width,h/ps.height));
    viewer.setOptions({zoom:zoom,fitToScreen:false});
    sendState();
  }
  function setZoom(z){
    if(!ready||!viewer)return;
    userZoomed=true;zoom=clampZoom(z);
    viewer.setOptions({zoom:zoom,fitToScreen:false});
    sendState();
  }
  function load(html){
    try{
      if(blobUrl){URL.revokeObjectURL(blobUrl);blobUrl=null;}
      if(errTimer){clearTimeout(errTimer);errTimer=null;}
      if(viewer&&viewer.cleanup)viewer.cleanup();
      viewer=null;
      currentPage=1;pageCount=0;atFirst=true;atLast=false;zoom=1;userZoomed=false;ready=false;
      var vp=document.getElementById('vp');
      vp.innerHTML='';
      if(!html){sendState();return;}
      blobUrl=URL.createObjectURL(new Blob([html],{type:'text/html'}));
      // renderAllPages: 総ページ数と現在位置を推定値でなく実レイアウトの整数で得る。
      // autoResize は**切る**。iframe 化でペインの伸縮が子 window の resize になり、
      // core の resize 再レンダ(全ページ
      // 破棄 + 再組版)を親レイアウトの確定のたびに踏む。この経路は途中キャンセルと
      // sizeIsGood() の早期 return の組で「loading のまま・全ページ hidden」に置き去りに
      // しうる形をしており(bundle 原文の静的確認。resize() は readyState を復元せずに早期
      // return する)、そもそも帳票のページ寸法は @page が決めるため viewport 再レイアウトは
      // 不要。リサイズ追随は自前の zoom フィット(下の resize リスナ → applyFit)で行う。
      viewer=new V.CoreViewer({viewportElement:vp},
        {autoResize:false,renderAllPages:true,pageViewMode:V.PageViewMode.SINGLE_PAGE,fitToScreen:false});
      viewer.addListener('nav',function(p){
        if(typeof p.epageCount==='number'&&p.epageCount>0)pageCount=Math.max(1,Math.round(p.epageCount));
        if(typeof p.epage==='number')currentPage=Math.max(1,Math.round(p.epage)+1);
        if(typeof p.first==='boolean')atFirst=p.first;
        if(typeof p.last==='boolean')atLast=p.last;
        applyFit();sendState();
      });
      viewer.addListener('readystatechange',function(){
        if(viewer&&viewer.readyState===V.ReadyState.COMPLETE){ready=true;applyFit();sendState();}
      });
      // 文書ロードの失敗を親へ伝える。core は致命的なロード失敗(例: 内蔵リソースの取得
      // 不能)を 'error' イベントで通知し、readyState は loading のまま**永久に止まる** —
      // 通知しないと「組版済みなのに全ページ hidden + ローダー 30 秒」の黙った劣化になる。
      // ただし 'error' はログ経由の警告(画像 404 等、組版は続行できるもの)でも飛ぶため、
      // 即フォールバックにせず「猶予後も COMPLETE に達していない」場合だけ致命と判定する。
      viewer.addListener('error',function(e){
        if(ready||errTimer)return;
        var msg=String((e&&e.content&&e.content.messages&&e.content.messages[0])||'vivliostyle load error');
        errTimer=setTimeout(function(){errTimer=null;if(!ready)post(MSG_ERROR,{message:msg});},3000);
      });
      viewer.loadDocument({url:blobUrl});
      sendState();
    }catch(e){post(MSG_ERROR,{message:String(e&&e.message||e)});}
  }
  function command(cmd,page){
    if(!viewer)return;
    try{
      if(cmd==='prevPage'){if(!atFirst&&currentPage>1)viewer.navigateToPage(V.Navigation.PREVIOUS);}
      else if(cmd==='nextPage'){if(!atLast&&currentPage<pageCount)viewer.navigateToPage(V.Navigation.NEXT);}
      else if(cmd==='goToPage'){
        // page が数値でない形は捨てる(NaN を丸めても NaN で、EPAGE 指定が壊れる)。
        if(typeof page!=='number'||!isFinite(page))return;
        var t=Math.min(Math.max(Math.round(page),1),pageCount||1);
        viewer.navigateToPage(V.Navigation.EPAGE,t-1);
      }
      else if(cmd==='zoomIn')setZoom(zoom+ZOOM_STEP);
      else if(cmd==='zoomOut')setZoom(zoom-ZOOM_STEP);
      else if(cmd==='fit'){userZoomed=false;applyFit();}
    }catch(e){post(MSG_ERROR,{message:String(e&&e.message||e)});}
  }
  // 親からのメッセージだけを受ける。子から見た parent は 1 つしかないので、これで
  // 発信元は一意に決まる(逆向きの検証は親が event.source の同一性で行う)。
  window.addEventListener('message',function(e){
    if(e.source!==parent)return;
    var d=e.data;
    if(!d||typeof d.type!=='string')return;
    if(d.type===MSG_DOC)load(typeof d.html==='string'?d.html:'');
    else if(d.type===MSG_CMD)command(d.cmd,d.page);
  });
  // ブラウザズーム/ペイン幅の変化に追随する。iframe がコンテナを 100% で埋めるので、
  // ここで測る window 寸法がそのまま利用可能領域になる(親との往復は不要)。
  var pending=false;
  window.addEventListener('resize',function(){
    if(pending)return;pending=true;
    requestAnimationFrame(function(){pending=false;applyFit();});
  });
  if(!V){post(MSG_ERROR,{message:'vivliostyle bundle unavailable'});return;}
  post(MSG_READY);
})();`;

/**
 * ビューアホストページを組み立てる。テンプレ由来の文字列は 1 バイトも含まず(埋めるのは
 * 自前のバンドルと boot だけ)、文書は起動後に postMessage で受け取る。
 *
 * `viewerScriptTag` はバンドルの載せ方(inline / `<script src>` fallback)だけを差し替える
 * — 分岐は `hostPage()` に集約し、ページの骨格はここ 1 箇所に保つ。
 */
function buildHostPage(viewerScriptTag: string): string {
  return `<!doctype html>
<html lang="ja">
<head>
<meta charset="utf-8">
<title>preview</title>
<style>
  /* 下地は**透明**にして、親コンテナの 「--canvas-backdrop」(テーマ変数)を透かす。ここに
     具体的な色を書くと、iframe はアプリの CSS を持たないためダークテーマへ追随できない。
     vivliostyle が screen 時に注入する viewport 背景(#aaaaaa)も同じ理由で透明へ上書きする。 */
  html,body{margin:0;padding:0;height:100%;background:transparent;}
  #vp{height:100%;width:100%;}
  [data-vivliostyle-viewer-viewport]{background:transparent;}
  /* アプリ本体へ描画していた頃に要った「真ん中のグレー」対策(Tailwind base の
     「*{border-color:var(--border)}」 が組版結果へ漏れる)は、iframe 化で前提ごと消えたので
     持ち込まない。 */
</style>
</head>
<body>
<div id="vp"></div>
${viewerScriptTag}
<script>${BOOT_SCRIPT}</script>
</body>
</html>`;
}

/** 組み立て済みホストページのキャッシュ(バンドル読取と安全判定を毎回やらない)。 */
let hostPageCache: string | null = null;

/** バンドル内蔵のホストページ。内蔵できない版のときだけ `<script src>` 形へ倒す。 */
async function hostPage(): Promise<string> {
  if (hostPageCache !== null) return hostPageCache;
  const bundle = await viewerBundle();
  hostPageCache = bundleSafeToInline(bundle)
    ? buildHostPage(`<script>${bundle}</script>`)
    : buildHostPage(`<script src="${VIEWER_BUNDLE_FILE}"></script>`);
  return hostPageCache;
}

/**
 * ビューアホストページと、その相対参照が指す資産を配る。
 *
 * `app.register(previewHostRoutes, { prefix: '/api' })` のように fastify-plugin を通さずに
 * 登録する = 独自コンテキストになり、下の `onSend` はここで登録したルートにだけ掛かる
 * (`openapi/docsRoutes.ts` と同じ作法)。helmet は `onRequest` でヘッダを置くので、
 * `onSend` の上書きが必ず勝つ。
 *
 * 認証は必須(`requireAuth`)。セッション cookie は SameSite=Lax で、同一サイトの iframe の
 * src リクエストにも付くことを実測済み。
 */
export async function previewHostRoutes(app: FastifyInstance): Promise<void> {
  app.addHook('onSend', async (_request, reply) => {
    reply.header('content-security-policy', PREVIEW_HOST_CSP);
    // helmet の既定 `Cross-Origin-Resource-Policy: same-origin` をこの経路だけ緩める。
    // sandbox 付き iframe の中は opaque オリジンで、そこから出る classic `<script src>` や
    // font の取得は我々のオリジンから見て cross-origin の no-cors 要求になり、
    // `same-origin`(`same-site` でも同じ)の CORP が弾く(実測:
    // `ERR_BLOCKED_BY_RESPONSE.NotSameOrigin`)。通常運転では子は何も取りに来ない
    // (バンドルはページ内蔵・テンプレ資産は親が文書へ埋める)が、fallback の
    // `<script src>` 形と、認証オフ環境での未内蔵資産の graceful degradation のために開ける。
    //
    // 開けても外部サイトからは読めない: セッション cookie は SameSite=Lax で cross-site の
    // subresource 要求には付かず、認証必須のこのルートは 401 になる。ページを外部から
    // 埋め込む経路も CSP の `frame-ancestors 'self'` で塞いである。
    reply.header('cross-origin-resource-policy', 'cross-origin');
  });

  app.get(`${PREVIEW_HOST_BASE}/index.html`, { preHandler: requireAuth }, async (_req, reply) => {
    // `no-store`: CSP や boot を差し替えた版が古いまま残ると原因不明の「プレビューだけ
    // 壊れている」になる。バンドル内蔵で 765KB あるが同一マシン内の配信で、組版のたびでは
    // なく画面を開いたとき 1 回なので毎回配って構わない。
    return reply
      .header('Cache-Control', 'no-store')
      .type('text/html; charset=utf-8')
      .send(await hostPage());
  });

  // ビューアバンドルと同梱資産(`css/` `js/` `fonts/`)。パスの解決は
  // `resolveServedAssetPath`(配信ルート相対への正規化)+ `resolveServedAssetSource`
  // (許可リスト・深さ・シンボリックリンク)の 2 段で、PDF 経路と同じ物差しを使う。
  app.get<{ Params: { '*': string } }>(
    `${PREVIEW_HOST_BASE}/*`,
    { preHandler: requireAuth },
    async (request, reply) => {
      const raw = request.params['*'] ?? '';
      if (raw === VIEWER_BUNDLE_FILE) {
        return reply
          .header('Cache-Control', 'no-store')
          .type('text/javascript; charset=utf-8')
          .send(await viewerBundle());
      }
      const rel = resolveServedAssetPath(raw);
      // 存在しない/許可外は 404 本文なしで返す(組版側は 404 を静かに無視する)。
      if (rel === undefined) return reply.code(404).send();
      const source = await resolveServedAssetSource(rel);
      if (source === undefined) return reply.code(404).send();
      return reply
        .type(CONTENT_TYPES[path.extname(source).toLowerCase()] ?? 'application/octet-stream')
        .send(await fs.readFile(source));
    },
  );
}
