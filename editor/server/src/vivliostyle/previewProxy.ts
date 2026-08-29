// =============================================================================
// previewProxy.ts — リクエストをループバック Vite プレビューサーバへ中継する
// =============================================================================
// **主防御は転送パスの許可リスト(`allowForwardPath`)であり、CSP は多層防御でしかない。**
//
// 上流は素の Vite dev サーバなので、`/@fs/<絶対パス>`(`serveRawFsMiddleware`)・`/@id/`・
// `/__open-in-editor?file=`(サーバ上のエディタプロセスを起動する)・`/node_modules/` が
// 全部生きている。「危険な接頭辞を CSP プロファイル表へ並べる」だけの対策は
// **応答ヘッダの選択表**であって転送の可否表ではなく、`/@` を「ビューア側」に列挙すると
// 任意ファイル読み出し経路へ**より緩い** CSP を与えることになる。
// ヘッダを足しても経路は閉じない。閉じるのは許可リストである。
//
// 中継してよいのはプレビュー表示に実際に必要な 2 系統だけ:
//   - ビューアアプリ `/__vivliostyle-viewer/**`(cli の `vsViewerPlugin` が sirv で返す)
//   - 文書と資産 `<docBase>/**`(cli の `vsDevServerPlugin`。既定 `/vivliostyle`)
// `/@vite/client` は `appType:'custom'` では注入されず、`/@vivliostyle:viewer:client` は
// オリジン直下の絶対 src なのでプロキシには届かない。`/node_modules/.vite/deps/*` も
// 文書が Vite の HTML 変換を通らないため不要である。つまり `/@fs` や `/__open-in-editor` は
// 「列挙して拒否する」までもなく**許可リストに載らないので落ちる**。
//
// CSP のプロファイル分けは残す(多層防御):
//   - ビューアアプリ側: knockout が data-bind 式を `new Function` で組むため `'unsafe-eval'` が要る。
//   - 文書側: `script-src 'none'`。ビューアは文書を XHR で取得して自前で組版するので、
//     文書内の script が動かなくても組版結果は変わらない。

import type { IncomingMessage, ServerResponse } from 'node:http';
import http from 'node:http';

/**
 * 検査を通った転送パス。`allowForwardPath` だけが生成できる型にして、「将来ルートを増やした
 * 人が未検査の文字列を渡す」ことをコンパイル時に不可能にする。列挙漏れではなく型の穴で
 * しか破れない、というのがこの branded 型の目的。
 */
export type ForwardPath = string & { readonly __previewForwardPath: unique symbol };

/** ビューアアプリの接頭辞(cli の `VIEWER_ROOT_PATH` と対)。 */
export const VIEWER_ROOT_PREFIX = '/__vivliostyle-viewer';

/** 文書 base の既定値(cli の `config.base ?? "/vivliostyle"` と対)。 */
export const DEFAULT_DOC_BASE = '/vivliostyle';

/**
 * 転送パスに現れてよい文字。RFC 3986 の pchar + `/` を許可リストで数える。空白・制御文字・
 * 生バックスラッシュはここで落ちる(Node の `ERR_UNESCAPED_CHARACTERS` に頼らない —
 * あれは実装依存で、我々の判定と上流の解釈がずれる余地を残す)。
 */
const PATH_CHARSET_RE = /^[A-Za-z0-9._~!$&'()*+,;=:@%/-]*$/;

/** セグメント境界を偽装する percent-encoding。復号すると `/` `\` になるものを拒否する。 */
const ENCODED_SEPARATOR_RE = /%2f|%5c/i;

/**
 * 境界付き前方一致。`startsWith(prefix)` 単独にしてはならない — `docBase='/vivliostyle'` の
 * とき `/vivliostyle-evil/x.html`(展開ルート直下の兄弟ディレクトリ。`serveStaticMiddleware`
 * が返す)が通ってしまう。
 */
function matchesPrefix(p: string, prefix: string): boolean {
  return p === prefix || p.startsWith(`${prefix}/`);
}

/** `..` セグメントを含むか(生・復号後の双方に掛ける)。 */
function hasDotDotSegment(p: string): boolean {
  return p.split('/').includes('..');
}

function isAllowedPathPart(pathPart: string, docBase: string): boolean {
  if (pathPart === '/') return true;
  return matchesPrefix(pathPart, VIEWER_ROOT_PREFIX) || matchesPrefix(pathPart, docBase);
}

/**
 * 中継してよいか判定する。通すときだけ `ForwardPath` を返し、それ以外は undefined。
 * 引数はルートが**生 URL から**切り出した「?/# 込みの残差」と、セッションの文書 base。
 *
 * 判定した文字列と転送する文字列は同一である(正規化して通す、をしない)。正規化すると
 * 「検査した形」と「上流が解釈する形」が分岐し、そこが次の迂回になる。上流(Vite / sirv /
 * cli の `decodeURI`)は復号して解釈するので、**生前方一致 + 復号後の再検査**の二重で見る。
 */
export function allowForwardPath(residual: string, docBase: string): ForwardPath | undefined {
  // 絶対形リクエストライン(`http://evil/x`)と空文字を封じる。
  if (!residual.startsWith('/')) return undefined;
  const cut = residual.search(/[?#]/);
  const pathPart = cut === -1 ? residual : residual.slice(0, cut);
  if (!PATH_CHARSET_RE.test(pathPart)) return undefined;
  if (ENCODED_SEPARATOR_RE.test(pathPart)) return undefined;
  let decoded: string;
  try {
    decoded = decodeURIComponent(pathPart);
  } catch {
    return undefined; // 復号不能は fail-close
  }
  if (hasDotDotSegment(pathPart) || hasDotDotSegment(decoded)) return undefined;
  // 生でも復号後でも許可リストに載ることを要求する。`/%76ivliostyle/x`(生では外れる)も
  // 「生では通るが復号後に別物になる」形も、これで両方落ちる。
  if (!isAllowedPathPart(pathPart, docBase)) return undefined;
  if (!isAllowedPathPart(decoded, docBase)) return undefined;
  return residual as ForwardPath;
}

/** ビューアアプリと Vite の内部モジュールに与える CSP。 */
const VIEWER_CSP = [
  "default-src 'self'",
  "script-src 'self' 'unsafe-eval' blob:",
  "style-src 'self' 'unsafe-inline' data:",
  "img-src 'self' data: blob:",
  "font-src 'self' data: blob:",
  "connect-src 'self' data: blob:",
  "worker-src 'self' blob:",
  "frame-src 'self' data: blob:",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'none'",
].join('; ');

/** アップロード由来の入力文書に与える CSP(script は一切動かさない)。 */
const CONTENT_CSP = [
  "default-src 'self'",
  "script-src 'none'",
  "style-src 'self' 'unsafe-inline' data:",
  "img-src 'self' data: blob:",
  "font-src 'self' data: blob:",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'none'",
].join('; ');

/**
 * ビューアアプリ側の path か。許可リスト導入後にプロキシへ到達しうるのは
 * 「ビューア配下」「docBase 配下」「`/`」の 3 種だけなので、判定は 1 条件で足りる。
 * fail-close(未知は文書プロファイル)は維持する — `'unsafe-eval'` が漏れる方向の事故を
 * 型 1 つで作れないようにするため。
 */
function isViewerPath(forwardPath: ForwardPath): boolean {
  const raw = forwardPath.split(/[?#]/, 1)[0];
  return matchesPrefix(raw, VIEWER_ROOT_PREFIX);
}

/** プロキシ応答へ付けるセキュリティヘッダを返す。 */
export function previewSecurityHeaders(forwardPath: ForwardPath): Record<string, string> {
  return {
    'content-security-policy': isViewerPath(forwardPath) ? VIEWER_CSP : CONTENT_CSP,
    // 文書を text/plain 等で置いても、ブラウザに script/CSS として読み直させない。
    'x-content-type-options': 'nosniff',
  };
}

/**
 * 上流へ渡すリクエストヘッダ。素の `{...req.headers}` は Cookie とホップバイホップまで
 * 流してしまう。Cookie を落とすのはアプリのセッション cookie が上流のログやエラーページへ
 * 載る経路を消すため。
 */
const FORWARDED_REQUEST_HEADERS = [
  'accept',
  'accept-encoding',
  'accept-language',
  'if-none-match',
  'if-modified-since',
  'range',
  'user-agent',
] as const;

/**
 * 上流から返してよいレスポンスヘッダ。Vite の dev サーバは既定で CORS 有効なので、
 * 素通しすると `access-control-allow-origin` が漏れる。`set-cookie` も同様に落とす。
 */
const FORWARDED_RESPONSE_HEADERS = [
  'content-type',
  'content-length',
  'content-encoding',
  'cache-control',
  'etag',
  'last-modified',
  'accept-ranges',
  'content-range',
  'vary',
] as const;

function pickRequestHeaders(req: IncomingMessage, host: string): Record<string, string> {
  const picked: Record<string, string> = { host };
  for (const name of FORWARDED_REQUEST_HEADERS) {
    const v = req.headers[name];
    if (typeof v === 'string') picked[name] = v;
  }
  return picked;
}

/**
 * リクエストをループバックの Vite プレビューサーバへリバースプロキシする。
 *
 * 生の Node `http` の `req`/`res` を直接扱う。Fastify ルートからは `reply.hijack()` 済みの
 * `request.raw` / `reply.raw` を渡す(Fastify による応答送出を抑止し、ここで応答を完全所有する)。
 *
 * ルートは GET / HEAD しか登録しないので、常に `upstream.end()` でリクエストを閉じる。
 * 非 GET を `req.pipe(upstream)` で流す形は成立しない — `app.ts` の content-type parser が
 * preHandler より前にボディを Buffer 化するため `request.raw` は消費済みで、1 バイトも
 * 流れず `end()` も呼ばれずに**上流が宙吊りになる**。将来 POST が本当に必要になったら
 * 「メソッドを足す」のではなく、当該ルートへ raw stream を温存する
 * `addContentTypeParser` を入れるところから設計し直すこと。
 */
export function proxyToPreview(
  host: string,
  port: number,
  forwardPath: ForwardPath,
  req: IncomingMessage,
  res: ServerResponse,
): void {
  const headers = pickRequestHeaders(req, `${host}:${port}`);
  const upstream = http.request(
    { host, port, method: req.method, path: forwardPath, headers },
    (up) => {
      res.statusCode = up.statusCode ?? 502;
      for (const key of FORWARDED_RESPONSE_HEADERS) {
        const value = up.headers[key];
        if (value !== undefined) res.setHeader(key, value);
      }
      // upstream 由来のヘッダより後に置き、上流が同名ヘッダを返しても必ずこちらが勝つ。
      for (const [key, value] of Object.entries(previewSecurityHeaders(forwardPath))) {
        res.setHeader(key, value);
      }
      up.pipe(res);
    },
  );
  upstream.on('error', () => {
    if (!res.headersSent) {
      res.statusCode = 502;
      res.setHeader('Content-Type', 'application/json; charset=utf-8');
      res.end(JSON.stringify({ kind: 'network', message: 'プレビューサーバに接続できません' }));
    } else {
      res.end();
    }
  });

  upstream.end();
}
