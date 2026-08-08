// =============================================================================
// renderHost.ts — Jinja コンパイルを opaque オリジンへ隔離するレンダーホストページ
// =============================================================================
// 承認画面・比較画面は他人(申請者)が書いたテンプレ本文を nunjucks で描画する。nunjucks は
// **サンドボックスではなくコンパイラ**で、`{{ range.constructor("…")() }}` は `new Function`
// へ到達する。これを承認者のページオリジンのメインスレッドで走らせてはならない —
// 走った JS は承認者のセッション(HttpOnly cookie は同一オリジン fetch へ自動で付く)のまま
// `/api/review-requests/:id/approve` を叩ける = 申請者が自分の申請を自分で通せる。
//
// 直し方は「コンパイルを止める」ではなく「**コンパイルする場所を移す**」。ここが移した先の
// 配信面で、web はこのページを `sandbox="allow-scripts"`(= `allow-same-origin` なし)の
// iframe の src に置く。子は opaque オリジンになり、親の DOM にも cookie にも API にも
// 届かない。作法は `vivliostyle/previewHost.ts` をそのまま踏襲する — 定数ページ /
// バンドルのページ内蔵 + fail-closed 検査 / `onSend` による経路専用 CSP /
// fastify-plugin を通さない register / `requireAuth`。
//
// ── なぜ srcdoc / blob ではなくサーバ配信なのか ──
// srcdoc 文書も blob 文書も**親応答の CSP を継承する**(sandbox 属性は CSP の免除にならない)。
// 全域 CSP は `script-src 'self' 'unsafe-eval' <ハッシュ>` で `'unsafe-inline'` を持たないため
// ブートスクリプトを inline で置けない。**ネットワーク応答の文書は自分の応答ヘッダの CSP に
// 従う**ので、サーバから配ればこの経路だけ緩い CSP を持てる(前例: `/api/docs`・preview-host)。
//
// ── プレビュー隔離との違い: 子はネットワークへ一切出ない ──
// preview-host は組版のために画像・フォント・内蔵 UA リソースを引くので `connect-src` や
// `img-src` を開けざるを得ないが、ここでやるのは「文字列 → 文字列」の変換だけで、外部から
// 引くものが 1 つも無い。だから `connect-src 'none'` まで閉じられる。これが本経路の要点で、
// 万一 nunjucks の脱出を許しても**持ち出し先が無い**(取れる情報は親が既に子へ渡した
// テンプレ本文と sample data だけ)。
import fs from 'node:fs/promises';
import path from 'node:path';
import {
  RENDER_BOOT_ERROR_ID,
  RENDER_HOST_BASE,
  RENDER_MSG_ERROR,
  RENDER_MSG_READY,
  RENDER_MSG_REQ,
  RENDER_MSG_RES,
} from '@editor/shared';
import type { FastifyInstance } from 'fastify';
import { config } from '../config.js';
import { requireAuth } from '../middleware/auth.js';

/**
 * この経路**だけ**に効かせる CSP。全域 CSP(`config.buildCspDirectives`)は変更しない。
 *
 * 1 行ずつ、何をなぜ許したか:
 *  - `default-src 'none'` — 既定は全部止める。以下で明示した面だけを開ける。
 *  - `script-src 'self' 'unsafe-inline' 'unsafe-eval'` — `'unsafe-inline'` はブートスクリプトと
 *    内蔵バンドル用(どちらもこちらが書いた固定文字列で、利用者由来のバイトは 1 つも無い)。
 *    `'unsafe-eval'` は nunjucks が**コンパイラである**以上必須で、これを許すこと自体が
 *    この iframe の存在理由 — 緩さの射程は opaque オリジンのこの子の中だけに閉じる。
 *    `'self'` は内蔵できない版が来たときの `<script src>` fallback のため。
 *  - **`connect-src 'none'`** — ここが preview-host との決定的な差。子がやるのは文字列変換
 *    だけで外部から引くものが無いため、外向きの通信面を全部閉じられる。仮に nunjucks の
 *    脱出を許しても、取れた情報の**持ち出し口が無い**(`fetch`/XHR/WebSocket/sendBeacon が
 *    すべて CSP で落ちる)。隔離を「動かさない」でなく「出られない」で成立させる要。
 *  - `img-src 'none'` / `style-src 'none'` / `font-src` 省略 — 描画結果は文字列として親へ
 *    返すだけで、この子は何も**表示しない**。表示しないなら見た目の資源は 1 つも要らない。
 *  - `frame-ancestors 'self'` — このページを埋め込めるのはアプリ自身だけ。
 *  - `base-uri 'none'` / `form-action 'none'` / `object-src 'none'` — 相対解決の付け替え・
 *    送信・プラグイン面を塞ぐ(`form-action` は CSP で `connect-src` に掛からない
 *    ナビゲーション型の持ち出し経路なので、別途明示で閉じる必要がある)。
 *  - `frame-src 'none'` — 入れ子 iframe を作らせない(sandbox の再委譲を封じる)。
 */
const RENDER_HOST_CSP = [
  "default-src 'none'",
  "script-src 'self' 'unsafe-inline' 'unsafe-eval'",
  "connect-src 'none'",
  "img-src 'none'",
  "style-src 'none'",
  "frame-ancestors 'self'",
  "frame-src 'none'",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'none'",
].join('; ');

/** バンドルを配るファイル名(ホストページからの相対参照と対)。 */
const NUNJUCKS_BUNDLE_FILE = 'nunjucks.js';

/**
 * nunjucks のブラウザ用**フルビルド**の場所。`nunjucks-slim` ではなく `nunjucks.min.js` を
 * 使うのは、slim にはコンパイラが入っておらず precompile 済みテンプレしか描画できないため
 * (こちらが受け取るのは生の Jinja 文字列)。
 *
 * `config.webDist` = `web/dist` の親が web パッケージなので、そこの `node_modules` から引く。
 * **server の依存に足さない**のは、これが web 側の依存(画面が使っている実装)であり、
 * 依存グラフを二重化すると版が割れて「隔離側と非隔離側で挙動が違う」を招くため。
 */
const NUNJUCKS_BUNDLE_SOURCE = path.resolve(
  config.webDist,
  '..',
  'node_modules/nunjucks/browser/nunjucks.min.js',
);

/** 読み込んだバンドルのキャッシュ(90KB を毎回読まない)。 */
let bundleCache: string | null = null;

/**
 * バンドルをホストページの inline `<script>` に**そのまま**埋めてよいか。
 *
 * 判定のみで書き換えはしない(fail closed)。`</script` の `\/` 置換は minified バンドルでは
 * `a</b/…`(比較 + 正規表現リテラル)のような、置換すると構文が壊れる形が原理上ありうる。
 * 危険な字面を含む版が来たら inline を諦めて `<script src>` 配信へ倒す
 * (nunjucks 3.2.4 は inline 可を確認済み)。
 *
 * 判定は `previewHost.bundleSafeToInline` と**同じ規則**:
 *  - `</script` — raw text の終端。1 つでもあれば要素がそこで閉じる。
 *  - `<!--` の後、対応する `-->` より前に `<script` — script data の二重エスケープ状態に
 *    入り、こちらが付ける終了タグが終了タグとして扱われなくなる。
 *
 * 共通化しないのは、片方の版が壊れたときにもう一方を道連れにしないため(2 つの独立した
 * バンドルを、それぞれの経路の責任で判定する)。
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
 * nunjucks バンドルを読む。npm 同梱の実体は UMD で、`module`/`exports` が無いブラウザでは
 * `window.nunjucks` へ自分を置く = `<script>` で直に読める(vivliostyle の CJS と違って
 * ラッパは要らない)。中身は 1 バイトも書き換えない。
 */
async function nunjucksBundle(): Promise<string> {
  if (bundleCache !== null) return bundleCache;
  bundleCache = await fs.readFile(NUNJUCKS_BUNDLE_SOURCE, 'utf8');
  return bundleCache;
}

/**
 * iframe 内で動くブートスクリプト。**固定文字列**(利用者入力を 1 バイトも埋めない)で、
 * 埋め込むのは shared のメッセージ種別定数だけ。
 *
 * 責務は 3 つ:
 *  1. nunjucks の Environment を 1 つ作る(`autoescape: true` / `throwOnUndefined: false` は
 *     web の `nunjucksRender.ts` と同じ設定 — 隔離しても描画結果は変えない)。
 *  2. **多層防御**の適用(下記)。
 *  3. REQ を 1 件受けて `renderString` の結果を RES で返す。例外は ERROR で返して親へ
 *     投げっぱなしにしない(親は `id` で自分の要求と突き合わせる)。
 *
 * ── 多層防御: なぜ隔離だけで終わらせないのか ──
 * 主防御は opaque オリジン + `connect-src 'none'` で、これは「脱出しても何もできない」形。
 * ただし脱出そのものは安く塞げるので塞ぐ。
 *
 * **塞ぐ対象は「経路の全列挙」で数える。** nunjucks がテンプレの字面から外部の値へ触る
 * 経路は 3 本あり、1 本でも数え落とすと関門をすり抜ける。当初は 1. と 2. だけを包んでおり、
 * **3. のフィルタ解決だけが素通りする形**があった。`{{ 1|valueOf }}` が
 * `Object.prototype.valueOf.call(context, 1)` として解決されて **Context そのもの**を返し、
 * そこから `context.env` → `env.getFilter("constructor")`(= `Object`)→ `Function` と辿って
 * 任意 JS が実行できた。`"constructor"` が**文字列引数**でありプロパティ参照ではないため、
 * 1. の名前遮断には掛からない。経路の列挙は `renderHost.test.ts` が固定する。
 *
 *  1. **プロパティ参照** — `runtime.memberLookup` / `runtime.contextOrFrameLookup` を包み、
 *     `constructor` / `__proto__` / `prototype` を `undefined` にする。コンパイル済み
 *     テンプレートは `Template.render` が渡す **runtime モジュールそのもの**を経由して
 *     これらを呼ぶ(`src/environment.js` の `rootRenderFunc(env, ctx, frame, globalRuntime, cb)`)
 *     ので、モジュール上の関数を差し替えれば全テンプレートに効く。`a.constructor` も
 *     `a[名前]` の動的キーも同じ関門を通る。
 *  2. **グローバル参照** — `env.globals` を `Object.create(null)` へ置き換える。`globals()` が
 *     返す `range` / `cycler` / `joiner` は帳票テンプレでは使わないうえ、`range.constructor`
 *     が実際に脱出経路になる。**素の `{}` では足りない** — `Context.lookup` は
 *     `name in this.env.globals` で引くため、Object.prototype 由来の `constructor` が
 *     そのままグローバルとして見えてしまう(だから null プロトタイプにする)。
 *  3. **フィルタ解決** — `env.filters` を own-property だけの null プロトタイプ表へ差し替える。
 *     `environment.js` の `this.filters = {}` は素のオブジェクトリテラルで、`getFilter` は
 *     継承プロパティも引くため `valueOf` / `constructor` などが**フィルタとして解決できて
 *     しまう**。フィルタ適用は `compileFilter` が `env.getFilter(名前).call(...)` を吐く経路で
 *     1. の関門を**通らない**ので、ここを別に閉じる必要がある。
 * どれも帳票テンプレの正当な構文(変数・`for`・`if`・フィルタ)には触れない
 * (`replace` / `sort` / `join` / `upper` / `string` / `length` の不変を実測で確認済み)。
 */
const BOOT_SCRIPT = `(function(){
  var MSG_READY=${JSON.stringify(RENDER_MSG_READY)};
  var MSG_REQ=${JSON.stringify(RENDER_MSG_REQ)};
  var MSG_RES=${JSON.stringify(RENDER_MSG_RES)};
  var MSG_ERROR=${JSON.stringify(RENDER_MSG_ERROR)};
  var BOOT_ERROR_ID=${JSON.stringify(RENDER_BOOT_ERROR_ID)};
  // 親のオリジンは opaque な子からは指定できないため '*' 固定。運ぶのは親が自分で寄越した
  // テンプレの描画結果だけで、親が既に持っていない情報は 1 つも含まない。
  function post(m){parent.postMessage(m,'*');}
  var NJ=window.nunjucks;
  if(!NJ){post({type:MSG_ERROR,id:BOOT_ERROR_ID,error:'nunjucks bundle unavailable'});return;}
  // プロパティ参照の関門。名前は完全一致で弾く(前方一致にすると正当な語まで巻き込み、
  // 部分一致にすると素通りが出る)。
  var BLOCKED=['constructor','__proto__','prototype'];
  var RT=NJ.runtime;
  var origMember=RT.memberLookup, origLookup=RT.contextOrFrameLookup;
  RT.memberLookup=function(obj,val){
    if(BLOCKED.indexOf(String(val))!==-1)return undefined;
    return origMember(obj,val);
  };
  RT.contextOrFrameLookup=function(context,frame,name){
    if(BLOCKED.indexOf(String(name))!==-1)return undefined;
    return origLookup(context,frame,name);
  };
  var env=new NJ.Environment(undefined,{autoescape:true,throwOnUndefined:false});
  env.globals=Object.create(null);
  // フィルタ解決の関門(上記 3.)。組み込みフィルタを own-property だけの null プロトタイプ表へ
  // 移し替える。継承を断つので getFilter('valueOf') は「未知のフィルタ」として落ちる。
  // (この文字列はテンプレートリテラルの中なので、コメントにもバッククォートを書けない)
  var ownFilters=Object.create(null);
  var names=Object.getOwnPropertyNames(env.filters);
  for(var i=0;i<names.length;i++)ownFilters[names[i]]=env.filters[names[i]];
  env.filters=ownFilters;
  // 親からのメッセージだけを受ける。子から見た parent は 1 つしかないので、これで発信元は
  // 一意に決まる(逆向きの検証は親が event.source の同一性で行う)。
  window.addEventListener('message',function(e){
    if(e.source!==parent)return;
    var d=e.data;
    if(!d||d.type!==MSG_REQ)return;
    var id=typeof d.id==='number'?d.id:BOOT_ERROR_ID;
    if(typeof d.template!=='string'){
      post({type:MSG_ERROR,id:id,error:'template must be a string'});return;
    }
    // 子は状態を持たない: 1 要求 1 応答で、要求の間に何も覚えない。覚えると、ある申請の
    // テンプレが仕込んだ副作用を次の申請の描画へ持ち越せてしまう。
    try{
      var ctx=(d.data&&typeof d.data==='object')?d.data:{};
      post({type:MSG_RES,id:id,html:env.renderString(d.template,ctx)});
    }catch(err){
      post({type:MSG_ERROR,id:id,error:String(err&&err.message||err)});
    }
  });
  post({type:MSG_READY});
})();`;

/**
 * レンダーホストページを組み立てる。テンプレ由来の文字列は 1 バイトも含まず(埋めるのは
 * nunjucks バンドルと boot だけ)、テンプレは起動後に postMessage で受け取る。
 *
 * `<body>` は空。この子は**何も表示しない**(描画結果は文字列として親へ返す)ので、
 * スタイルも viewport も要らない — `style-src 'none'` はその裏返しである。
 */
function buildHostPage(bundleScriptTag: string): string {
  return `<!doctype html>
<html lang="ja">
<head>
<meta charset="utf-8">
<title>render</title>
</head>
<body>
${bundleScriptTag}
<script>${BOOT_SCRIPT}</script>
</body>
</html>`;
}

/** 組み立て済みホストページのキャッシュ(バンドル読取と安全判定を毎回やらない)。 */
let hostPageCache: string | null = null;

/** バンドル内蔵のホストページ。内蔵できない版のときだけ `<script src>` 形へ倒す。 */
async function hostPage(): Promise<string> {
  if (hostPageCache !== null) return hostPageCache;
  const bundle = await nunjucksBundle();
  hostPageCache = bundleSafeToInline(bundle)
    ? buildHostPage(`<script>${bundle}</script>`)
    : buildHostPage(`<script src="${NUNJUCKS_BUNDLE_FILE}"></script>`);
  return hostPageCache;
}

/**
 * レンダーホストページと、fallback 時にだけ要る nunjucks バンドルを配る。
 *
 * `app.register(renderHostRoutes, { prefix: '/api' })` のように fastify-plugin を通さずに
 * 登録する = 独自コンテキストになり、下の `onSend` はここで登録したルートにだけ掛かる
 * (`openapi/docsRoutes.ts`・`vivliostyle/previewHost.ts` と同じ作法)。helmet は `onRequest`
 * でヘッダを置くので、`onSend` の上書きが必ず勝つ。
 *
 * **同梱資産(`css/` `fonts/` `js/`)は配らない。** preview-host はテンプレの相対参照を
 * 解決するために配る必要があったが、この子は表示をしないので参照する資産が無い。配る面を
 * 持たないこと自体がここでの封じ込めで、ワイルドカードが配るのはバンドル 1 ファイルだけ
 * (許可リストではなく**完全一致 1 件**)。
 *
 * 認証は必須(`requireAuth`)。セッション cookie は SameSite=Lax で、同一サイトの iframe の
 * src リクエストにも付くことを実測済み。
 */
export async function renderHostRoutes(app: FastifyInstance): Promise<void> {
  app.addHook('onSend', async (_request, reply) => {
    reply.header('content-security-policy', RENDER_HOST_CSP);
    // helmet の既定 `Cross-Origin-Resource-Policy: same-origin` をこの経路だけ緩める。
    // sandbox 付き iframe の中は opaque オリジンで、そこから出る classic `<script src>` は
    // 我々のオリジンから見て cross-origin の no-cors 要求になり、`same-origin` の CORP が
    // 弾く(実測: `ERR_BLOCKED_BY_RESPONSE.NotSameOrigin`)。通常運転では子は何も取りに
    // 来ない(バンドルはページ内蔵)ので、これは fallback 経路のためだけの緩和である。
    //
    // 開けても外部サイトからは読めない: セッション cookie は SameSite=Lax で cross-site の
    // subresource 要求には付かず、認証必須のこのルートは 401 になる。ページを外部から
    // 埋め込む経路も CSP の `frame-ancestors 'self'` で塞いである。
    reply.header('cross-origin-resource-policy', 'cross-origin');
  });

  app.get(`${RENDER_HOST_BASE}/index.html`, { preHandler: requireAuth }, async (_req, reply) => {
    // `no-store`: CSP や boot(= 多層防御の本体)を差し替えた版が古いまま残ると、隔離が
    // 効いているつもりで効いていない状態を作る。90KB の同一マシン内配信なので毎回配ってよい。
    return reply
      .header('Cache-Control', 'no-store')
      .type('text/html; charset=utf-8')
      .send(await hostPage());
  });

  // fallback(`<script src>` 形)でだけ引かれるバンドル。**完全一致以外は配らない** —
  // ここに許可リストやパス解決を置くと、配る必要が無いものまで配れる面になる。
  app.get<{ Params: { '*': string } }>(
    `${RENDER_HOST_BASE}/*`,
    { preHandler: requireAuth },
    async (request, reply) => {
      if ((request.params['*'] ?? '') !== NUNJUCKS_BUNDLE_FILE) return reply.code(404).send();
      return reply
        .header('Cache-Control', 'no-store')
        .type('text/javascript; charset=utf-8')
        .send(await nunjucksBundle());
    },
  );
}
