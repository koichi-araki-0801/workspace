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
  FONT_MIME,
  HL_DEL,
  HL_INS,
  PREVIEW_HOST_BASE,
  PREVIEW_MARK_COLORS,
  PREVIEW_MAX_PART_KEYS,
  PREVIEW_MSG_CMD,
  PREVIEW_MSG_DOC,
  PREVIEW_MSG_ERROR,
  PREVIEW_MSG_MARKS,
  PREVIEW_MSG_PART_CLICK,
  PREVIEW_MSG_PART_PAGES,
  PREVIEW_MSG_READY,
  PREVIEW_MSG_STATE,
  REVIEW_GHOST_ATTR,
  REVIEW_KEEP_ATTR,
  REVIEW_KEEP_TEXT,
  REVIEW_NO_ATTR,
  resolveServedRoutePath,
} from '@editor/shared';
import type { FastifyInstance } from 'fastify';
import { config } from '../config.js';
import { requireAuth } from '../middleware/auth.js';
import { bundleSafeToInline } from '../util/inlineBundle.js';
import { isFundImagePath, resolveServedAssetSource } from './docAssets.js';

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
 *    同梱資産(この接頭辞から配る `css/fonts/`)。外部ホストは許さない。
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

/**
 * 資産の拡張子 → Content-Type。許可リスト外の拡張子はそもそも解決器が弾く。フォントは web が
 * data URI にするときと同じ shared の表を使う。
 */
const CONTENT_TYPES: Readonly<Record<string, string>> = {
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  ...FONT_MIME,
};

/** 読み込んだバンドルのキャッシュ(765KB を毎回読まない)。 */
let bundleCache: string | null = null;

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
 * 埋め込むのは shared の定数(メッセージ種別・目印の属性名と文言・色)だけ。
 *
 * 責務は 5 つ:
 *  1. 親から受けた文書文字列を**子の中で** blob 化して `loadDocument` する。親が作った
 *     blob URL は opaque オリジンから読めない(実測: `URL scheme "blob" is not supported`)
 *     ので、blob 化は必ず子側で行う。
 *  2. `nav` / `readystatechange` を購読して状態を親へ返す。
 *  3. ページ送り・ズーム・変更箇所ジャンプ(`gotoAnchor`)・パーツへの移動(`gotoPart`)
 *     命令を受ける。
 *  4. **フィット計算を子で完結させる**。iframe は親のコンテナを 100% で埋めるので、
 *     `window.innerWidth/Height` がそのままコンテナ寸法になる。往復通信が要らないぶん
 *     リサイズ追随が親子の往復に律速されない。
 *  5. 承認タブの紙面(`review: true` で送られた文書)にだけ、番号札・判定の枠・空き枠・
 *     却下の札・文字の差分の色を描き(`decorate`)、パーツの押下と番号 → 物理ページを返す。
 *
 * ── 紙面の目印の描き方(5) ──
 * Vivliostyle は文書の `style` 属性を描画済みの要素へ写さず、カスケードを解いた結果を
 * 描画済みの要素の inline style に書く。描画済みの要素は live で、`display`・`position` を
 * 書くと組み直さずにその場で組版が動く。だから書く値を要素で分ける。
 *  - ホストが作る札(番号札・却下の札)と空き枠 `[data-review-ghost]` には `display`・
 *    `visibility`・`opacity`・`position`・`z-index`・`clip-path` を `!important` で書き、申請者
 *    CSS に消されないようにする。空き枠の点線は `outline`(高さを変えない)。
 *  - 申請者の要素の断片には判定の色の `outline` と選択中の `box-shadow`、`.cmp-ins` /
 *    `.cmp-del` には `color` と `background-color` だけを書く(どれも組版を動かさない)。
 * Vivliostyle は display:none の要素を描画済みの DOM に**出さない**(実測)ので、空き枠だけは
 * 利用者スタイルシート(`userStyleSheet`。利用者の重要宣言は著者の `!important` に勝つ。実測)
 * で残す。申請者の要素を display:none で消す CSS は紙面の目印も消せるが、判定の正典は親画面の
 * 右欄の文字の差分で、こちらは申請者 CSS が届かない。札は表示中のページだけに描く(表示して
 * いないページの断片は `getBoundingClientRect` が 0 になり、座標を取れない)。
 */
const BOOT_SCRIPT = `(function(){
  var MSG_DOC=${JSON.stringify(PREVIEW_MSG_DOC)};
  var MSG_CMD=${JSON.stringify(PREVIEW_MSG_CMD)};
  var MSG_READY=${JSON.stringify(PREVIEW_MSG_READY)};
  var MSG_STATE=${JSON.stringify(PREVIEW_MSG_STATE)};
  var MSG_ERROR=${JSON.stringify(PREVIEW_MSG_ERROR)};
  var MSG_MARKS=${JSON.stringify(PREVIEW_MSG_MARKS)};
  var MSG_PART_CLICK=${JSON.stringify(PREVIEW_MSG_PART_CLICK)};
  var MSG_PART_PAGES=${JSON.stringify(PREVIEW_MSG_PART_PAGES)};
  var COLORS=${JSON.stringify(PREVIEW_MARK_COLORS)};
  var NO_ATTR=${JSON.stringify(REVIEW_NO_ATTR)}, GHOST_ATTR=${JSON.stringify(REVIEW_GHOST_ATTR)};
  var KEEP_ATTR=${JSON.stringify(REVIEW_KEEP_ATTR)}, KEEP_TEXT=${JSON.stringify(REVIEW_KEEP_TEXT)};
  var INS_CLASS=${JSON.stringify(HL_INS)}, DEL_CLASS=${JSON.stringify(HL_DEL)};
  var MAX_MARK_KEYS=${JSON.stringify(PREVIEW_MAX_PART_KEYS)};
  // 札(ホストが作る要素)の印。値は 'no'(番号札)か 'keep'(却下の札)、FOR_ATTR に番号。
  var BADGE_ATTR='data-review-badge', FOR_ATTR='data-review-for';
  var PC_SEL='[data-vivliostyle-page-container]';
  // 番号は正規形だけ通す(shared の isPreviewPartNo と同じ規則)。
  var PART_NO_RE=/^(0|[1-9][0-9]{0,4})$/;
  // 空き枠を display:none の CSS から残す利用者スタイルシート(承認タブの紙面だけに当てる)。
  var GHOST_USER_CSS='['+GHOST_ATTR+']{display:block !important;visibility:visible !important;opacity:1 !important}';
  // ズームの範囲/刻み/フィット余白は編集画面(useGrapes.ts)に合わせる。
  var ZOOM_MIN=0.4, ZOOM_MAX=1.4, ZOOM_STEP=0.1, FIT_MARGIN=32;
  var V=window.Vivliostyle, viewer=null, blobUrl=null, errTimer=null;
  var currentPage=1, pageCount=0, atFirst=true, atLast=false, zoom=1, userZoomed=false, ready=false;
  // 目印の状態。どれも文書単位で、load() の先頭で捨てる。
  var reviewDoc=false, marks=null, parts=null, saved=new Map();
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
  // ── 紙面の目印 ──
  // 申請者の要素へ書く前の値を覚えておき、表示を切ったときに元へ戻す(Vivliostyle が
  // カスケードを解いて書いた値を消さない)。
  function paint(el,prop,val){
    var rec=saved.get(el);
    if(!rec){rec=Object.create(null);saved.set(el,rec);}
    if(!(prop in rec))rec[prop]=[el.style.getPropertyValue(prop),el.style.getPropertyPriority(prop)];
    el.style.setProperty(prop,val,'important');
  }
  function unpaint(el,prop){
    var rec=saved.get(el);
    if(!rec||!(prop in rec))return;
    var o=rec[prop];delete rec[prop];
    if(o[0])el.style.setProperty(prop,o[0],o[1]);else el.style.removeProperty(prop);
  }
  // ホストが作る要素と空き枠へ、消されないための値と見た目をまとめて書く。
  function paintAll(el,props,keep){
    for(var k in props){if(keep)paint(el,k,props[k]);else el.style.setProperty(k,props[k],'important');}
  }
  var SHOWN={display:'block',visibility:'visible',opacity:'1','clip-path':'none'};
  function isPlain(v){return !!v&&typeof v==='object'&&!Array.isArray(v);}
  // shared の parsePreviewMarks と同じ規則で形を検査する(子は shared を import できない)。
  function parseMarks(v){
    if(!isPlain(v)||!isPlain(v.states)||typeof v.visible!=='boolean')return null;
    if(v.selected!==null&&!(typeof v.selected==='string'&&PART_NO_RE.test(v.selected)))return null;
    var keys=Object.keys(v.states);
    if(keys.length>MAX_MARK_KEYS)return null;
    var states=Object.create(null);
    for(var i=0;i<keys.length;i++){
      var s=v.states[keys[i]];
      if(!PART_NO_RE.test(keys[i])||(s!=='pending'&&s!=='approved'&&s!=='rejected'))return null;
      states[keys[i]]=s;
    }
    return {states:states,selected:v.selected,visible:v.visible};
  }
  function stateOf(no){return (marks&&marks.states[no])||'pending';}
  function marksVisible(){return !marks||marks.visible;}
  // 描画済みの DOM から目印の対象を集める。番号は最初の断片とそのページ、却下の札は
  // 元の要素(data-adapt-eloff。割れた要素の断片で共通)ごとの最後の断片に付ける。
  function collect(){
    var vp=document.getElementById('vp');
    var pcs=vp.querySelectorAll(PC_SEL), pcIndex=new Map();
    for(var i=0;i<pcs.length;i++)pcIndex.set(pcs[i],i);
    var p={pcs:pcs,first:Object.create(null),firstPage:Object.create(null),
      keepLast:Object.create(null),frags:[],ghosts:[],diffs:[]};
    var els=vp.querySelectorAll('['+NO_ATTR+'],['+GHOST_ATTR+'],['+KEEP_ATTR+'],.'+INS_CLASS+',.'+DEL_CLASS);
    for(var j=0;j<els.length;j++){
      var el=els[j], pc=el.closest(PC_SEL);
      if(!pc||!pcIndex.has(pc))continue;
      if(el.classList.contains(INS_CLASS)||el.classList.contains(DEL_CLASS))p.diffs.push(el);
      if(el.hasAttribute(GHOST_ATTR))p.ghosts.push(el);
      else if(el.hasAttribute(NO_ATTR))p.frags.push(el);
      var no=el.getAttribute(NO_ATTR);
      if(no!==null&&PART_NO_RE.test(no)&&!(no in p.first)){p.first[no]=el;p.firstPage[no]=pcIndex.get(pc);}
      if(el.hasAttribute(KEEP_ATTR)&&!el.hasAttribute(GHOST_ATTR)){
        p.keepLast[el.getAttribute('data-adapt-eloff')||('i'+j)]=el;
      }
    }
    parts=p;
    var pages={};
    for(var n in p.firstPage)pages[n]=p.firstPage[n];
    post(MSG_PART_PAGES,{pages:pages});
  }
  // 札の座標系: 札を page container の (0,0) に置いて測り、倍率は幅 100px の物差しで取る。
  // ズームは祖先の transform なので、こうすれば倍率の出どころに依らず断片の左上へ置ける。
  function frameOf(pc){
    var probe=document.createElement('span');
    paintAll(probe,{position:'absolute',left:'0',top:'0',width:'100px',height:'0',display:'block'});
    pc.appendChild(probe);
    var r=probe.getBoundingClientRect();
    pc.removeChild(probe);
    return {x:r.left,y:r.top,s:r.width>0?r.width/100:1};
  }
  function makeBadge(pc,kind,no,text,css){
    var b=document.createElement('span');
    b.setAttribute(BADGE_ATTR,kind);
    if(no!==null)b.setAttribute(FOR_ATTR,no);
    b.textContent=text;
    paintAll(b,SHOWN);
    paintAll(b,css);
    paintAll(b,{position:'absolute','z-index':'2147483647',cursor:'pointer','box-sizing':'border-box',
      'white-space':'nowrap',margin:'0',float:'none',transform:'none',filter:'none'});
    pc.appendChild(b);
    return b;
  }
  function placeBadges(){
    var vp=document.getElementById('vp');
    var old=vp.querySelectorAll('['+BADGE_ATTR+']');
    for(var i=0;i<old.length;i++)old[i].parentNode.removeChild(old[i]);
    if(!parts||!marksVisible())return;
    for(var k=0;k<parts.pcs.length;k++){
      var pc=parts.pcs[k];
      // 表示中のページだけ(display:none のページは矩形が 0 で座標を取れない)。
      if(pc.getClientRects().length===0)continue;
      var f=null;
      for(var no in parts.first){
        if(parts.firstPage[no]!==k)continue;
        f=f||frameOf(pc);
        var r=parts.first[no].getBoundingClientRect();
        var b=makeBadge(pc,'no',no,no,{'min-width':'20px',height:'20px',padding:'0 3px',
          'border-radius':'10px','background-color':COLORS[stateOf(no)],color:'#fff',
          border:'1.5px solid #fff','box-shadow':'0 1px 3px rgba(0,0,0,.3)',
          font:'700 12px/17px sans-serif','text-align':'center'});
        b.style.setProperty('left',((r.left-f.x)/f.s-2)+'px','important');
        b.style.setProperty('top',((r.top-f.y)/f.s-2)+'px','important');
      }
      for(var key in parts.keepLast){
        var el=parts.keepLast[key];
        if(el.closest(PC_SEL)!==pc)continue;
        f=f||frameOf(pc);
        var kr=el.getBoundingClientRect();
        var kb=makeBadge(pc,'keep',el.getAttribute(NO_ATTR),KEEP_TEXT,{font:'10px/1 sans-serif',
          'background-color':'#fff3d6',color:'#7a5a10',border:'1px solid #e6c97a',
          'border-radius':'4px',padding:'2px 5px'});
        kb.style.setProperty('left',((kr.right-f.x)/f.s-4-kb.offsetWidth)+'px','important');
        kb.style.setProperty('top',((kr.bottom-f.y)/f.s+9-kb.offsetHeight)+'px','important');
      }
    }
  }
  // 判定の枠・選択・差分の色・空き枠。幾何に依らないので全ページへまとめて書く。
  function paintMarks(){
    var vis=marksVisible(), i, el;
    for(i=0;i<parts.ghosts.length;i++){
      paintAll(parts.ghosts[i],SHOWN,true);
      paintAll(parts.ghosts[i],{position:'relative','z-index':'1','outline-style':'dashed',
        'outline-width':'1.5px','outline-color':'#b6bcc6','outline-offset':'-2px',color:'#8a909a',
        'background-color':'#f6f7f9','text-align':'center'},true);
    }
    for(i=0;i<parts.frags.length;i++){
      el=parts.frags[i];
      var no=el.getAttribute(NO_ATTR);
      if(vis&&no!==null&&PART_NO_RE.test(no)){
        paint(el,'outline-style','solid');paint(el,'outline-width','1.5px');
        paint(el,'outline-color',COLORS[stateOf(no)]);paint(el,'outline-offset','2px');
        if(marks&&marks.selected===no)paint(el,'box-shadow','0 0 0 4px rgba(59,130,196,.35)');
        else unpaint(el,'box-shadow');
      }else{
        unpaint(el,'outline-style');unpaint(el,'outline-width');unpaint(el,'outline-color');
        unpaint(el,'outline-offset');unpaint(el,'box-shadow');
      }
    }
    for(i=0;i<parts.diffs.length;i++){
      el=parts.diffs[i];
      var ins=el.classList.contains(INS_CLASS);
      if(vis){
        paint(el,'color',ins?'#15803d':'#b91c1c');
        paint(el,'background-color',ins?'rgba(22,163,74,.18)':'rgba(220,38,38,.14)');
      }else{unpaint(el,'color');unpaint(el,'background-color');}
    }
  }
  // 冪等: 自分の札を全部外してから描く。組み直し(ズーム等)で断片が入れ替わっていたら
  // 集め直す。
  function decorate(){
    if(!reviewDoc||!ready)return;
    try{
      if(!parts||(parts.pcs.length>0&&!parts.pcs[0].isConnected))collect();
      paintMarks();
      placeBadges();
    }catch(e){/* 目印は補助。失敗してもプレビューは操作不能へ倒さない */}
  }
  function load(html,review){
    try{
      if(blobUrl){URL.revokeObjectURL(blobUrl);blobUrl=null;}
      if(errTimer){clearTimeout(errTimer);errTimer=null;}
      if(viewer&&viewer.cleanup)viewer.cleanup();
      viewer=null;
      currentPage=1;pageCount=0;atFirst=true;atLast=false;zoom=1;userZoomed=false;ready=false;
      reviewDoc=review===true;marks=null;parts=null;saved=new Map();
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
        applyFit();decorate();sendState();
      });
      viewer.addListener('readystatechange',function(){
        if(viewer&&viewer.readyState===V.ReadyState.COMPLETE){ready=true;applyFit();decorate();sendState();}
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
      if(reviewDoc)viewer.loadDocument({url:blobUrl},{userStyleSheet:[{text:GHOST_USER_CSS}]});
      else viewer.loadDocument({url:blobUrl});
      sendState();
    }catch(e){post(MSG_ERROR,{message:String(e&&e.message||e)});}
  }
  function command(cmd,page,anchor,part){
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
      else if(cmd==='gotoPart'){
        // 番号の最初の断片の page container が並びの何番目かで移る(id は当てにしない。
        // 著者の id は gotoAnchor の形に合うとは限らない)。
        if(!reviewDoc||!ready||typeof part!=='string'||!PART_NO_RE.test(part))return;
        if(!parts)decorate();
        var idx=parts?parts.firstPage[part]:undefined;
        if(typeof idx==='number')viewer.navigateToPage(V.Navigation.EPAGE,idx);
      }
      else if(cmd==='gotoAnchor'){
        // 精査画面の変更箇所ジャンプ。id は文書内の要素 id(review-anchor-<n>)で、
        // navigateToInternalUrl は core の通常のページ内リンク(<a href="#id">)移動と
        // 同じ経路(moveTo→opfView.navigateTo)を辿るため、その要素が属するページへ
        // 遷移する。ここだけ内側 try/catch で個別に囲み、外側の catch(MSG_ERROR
        // 送出→親が簡易表示へ倒す)に載せない。id 不一致・該当要素なし等の失敗は
        // 黙って何もしない(親はマーカー+手動ページ送りのフォールバックを持つ。
        // このコマンド 1 つの失敗でプレビュー全体を操作不能へ倒さない)。
        // フラグメントだけの href(例: '#review-anchor-2')は渡さない。core の navigateTo は
        // それを「変換済みフラグメント」(documentURLTransformer が読み込み URL と id を
        // 合成した形)として復号しようとし、素の id は spine 上の path と解釈されて
        // 見つからず何も起きない(実測: 対象を示すログは出るがページは動かない)。ページ内
        // リンクのクリックは a.href(絶対 URL)を渡すのでこの経路を踏まない — 読み込んだ
        // 文書の URL(blobUrl)を前置して同じ形の絶対 URL にする。
        try{
          if(blobUrl&&typeof anchor==='string'&&/^[A-Za-z0-9_-]+$/.test(anchor)){
            viewer.navigateToInternalUrl(blobUrl+'#'+anchor);
          }
        }catch(e){/* 移動失敗は無視(操作不能へ倒さない) */}
      }
    }catch(e){post(MSG_ERROR,{message:String(e&&e.message||e)});}
  }
  // 親からのメッセージだけを受ける。子から見た parent は 1 つしかないので、これで
  // 発信元は一意に決まる(逆向きの検証は親が event.source の同一性で行う)。
  window.addEventListener('message',function(e){
    if(e.source!==parent)return;
    var d=e.data;
    if(!d||typeof d.type!=='string')return;
    if(d.type===MSG_DOC)load(typeof d.html==='string'?d.html:'',d.review);
    else if(d.type===MSG_CMD)command(d.cmd,d.page,d.anchor,d.part);
    else if(d.type===MSG_MARKS){
      // 文書は組み直さずに描き替える。形の違う値は捨てる(前の marks のまま)。
      var m=parseMarks(d.marks);
      if(m&&reviewDoc){marks=m;decorate();}
    }
  });
  // 紙面のパーツ(または札)が押されたら番号を返す。親は自分の番号の集合で照合する
  // (テンプレ JS がこのメッセージを偽れるため、ここの値を判定の根拠にしない)。
  document.getElementById('vp').addEventListener('click',function(e){
    if(!reviewDoc||!ready)return;
    var t=e.target;
    if(!t||!t.closest)return;
    var b=t.closest('['+BADGE_ATTR+']'), no=b?b.getAttribute(FOR_ATTR):null;
    if(!b){var el=t.closest('['+NO_ATTR+']');no=el?el.getAttribute(NO_ATTR):null;}
    if(no!==null&&PART_NO_RE.test(no))post(MSG_PART_CLICK,{part:no});
  },true);
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

  // ビューアバンドルと同梱資産(`css/`(配下に `css/fonts/`)と `js/`。`images/` は配らない)。
  // 受けるのは**論理ルート相対のパス**で、文書の参照そのものではない — web の
  // `previewSelfContain` が文書基準の参照を `resolveDocAssetPath` で解いてから取りに来る。
  // パスの解決は `resolveServedRoutePath`(復号済みのルート引数の検査)+
  // `resolveServedAssetSource`(許可リスト・深さ・シンボリックリンク)の 2 段で、PDF 経路と
  // 同じ物差しを使う。
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
      const rel = resolveServedRoutePath(raw);
      // 存在しない/許可外は 404 本文なしで返す(組版側は 404 を静かに無視する)。
      if (rel === undefined) return reply.code(404).send();
      // 画像の配信経路は `/api/fund-assets/images/` の 1 本に集める。ここで配ると SVG 検査を
      // 通らない経路ができる(子の画像は親が文書へ埋めるので、子がここへ取りに来る必要も無い)。
      if (isFundImagePath(rel)) return reply.code(404).send();
      const source = await resolveServedAssetSource(rel);
      if (source === undefined) return reply.code(404).send();
      return reply
        .type(CONTENT_TYPES[path.extname(source).toLowerCase()] ?? 'application/octet-stream')
        .send(await fs.readFile(source));
    },
  );
}
