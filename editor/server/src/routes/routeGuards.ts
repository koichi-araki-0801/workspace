// =============================================================================
// routeGuards.ts — ルートごとの必要ロールの正典と、起動時の網羅検査
// =============================================================================
// `viewer` は閲覧のみのロールだが、それが台帳(`ユーザー.ロール`)の上にあるだけで
// 変更系ルートの検査が `requireAuth` 止まりだと、下書きの上書き・削除、メモ書き、
// 履歴追記、承認申請の投入まで全部通れる = ロール分離が実質存在しない。
//
// ガードを 1 本足すだけでは同じことが繰り返される。**新しいルートを足したときに
// 検査を付け忘れたら落ちる**仕組みが要る。そこで
//   1. 「メソッド + パス → 必要ロール」の表(`ROUTE_POLICY`)をこのファイルに一元化し、
//   2. `app.addHook('onRoute', assertRoutePolicy)` で全ルート登録を照合し、
//   3. 表に無いルート・宣言とガードが食い違うルート・理由なしで viewer に開いた変更系
//      ルートは**サーバ起動時に throw** する
// という 3 段にする。起動時失敗なので本番まで届かない。
//
// パス文字列は `apiPaths` から導出する(手書きを増やさない)。`:id` と `:templateId` の
// ような表記ゆれは、導出していれば構造的に起こらない。
import { apiPaths, PREVIEW_HOST_BASE, RENDER_HOST_BASE } from '@editor/shared';
import type { RouteOptions } from 'fastify';
import { requireAdmin, requireApprover, requireAuth, requireEditor } from '../middleware/auth.js';

/** 必要ロール。`auth` = ログイン済みなら誰でも(= viewer も可)。 */
export type GuardLevel = 'public' | 'auth' | 'editor' | 'approver' | 'admin';

/** `/api` prefix 付きの完全パスへ合成する。register の prefix と一致させるための唯一の場所。 */
const api = (p: string): string => `/api${p}`;

/**
 * ルート正典。キーは `${METHOD} ${url}`(url は `/api` 込み・Fastify 形)。
 *
 * ここに無いルートを登録するとサーバが起動しない。逆に、ここにあって登録されていない
 * 行(dead entry)は `test/routeGuards.test.ts` が検出する。
 */
export const ROUTE_POLICY: Readonly<Record<string, GuardLevel>> = {
  // system / auth — 未認証で到達できる唯一の面
  [`GET ${api(apiPaths.health)}`]: 'public',
  [`GET ${api('/openapi.json')}`]: 'public',
  [`POST ${api(apiPaths.authLogin)}`]: 'public',
  // logout / me は cookie の読み取り後に動く(未ログインでも 204 / null を返す)。
  [`POST ${api(apiPaths.authLogout)}`]: 'public',
  [`GET ${api(apiPaths.authMe)}`]: 'public',
  // init-password は `requireIdentifiedUser` も重ねる(ローカルモードでも 401)。表の
  // レベルは「requireAuth 系ガードのうち最上位はどれか」を表すので `auth` になる。
  [`POST ${api(apiPaths.authInitPassword)}`]: 'auth',

  // templates — 参照は viewer にも開く
  [`GET ${api(apiPaths.templatesOptions)}`]: 'auth',
  [`GET ${api(apiPaths.templatesSeries)}`]: 'auth',
  [`GET ${api(apiPaths.templates)}`]: 'auth',
  [`GET ${api(apiPaths.templateById)}`]: 'auth',
  [`GET ${api(apiPaths.templateDraft)}`]: 'auth',
  [`GET ${api(apiPaths.templateSyncStatus)}`]: 'auth',
  [`GET ${api(apiPaths.fundSampleData)}`]: 'auth',
  // 下書きは他人のものも触れる(所有者検査は別の根で入る)。viewer には開かない。
  [`PUT ${api(apiPaths.templateDraft)}`]: 'editor',
  [`DELETE ${api(apiPaths.templateDraft)}`]: 'editor',
  [`POST ${api(apiPaths.generate)}`]: 'editor',

  // parts
  [`GET ${api(apiPaths.partClassificationOptions)}`]: 'auth',
  [`GET ${api(apiPaths.parts)}`]: 'auth',
  [`GET ${api(apiPaths.partHistory)}`]: 'auth',
  [`POST ${api(apiPaths.partHistory)}`]: 'editor',

  // notes
  [`GET ${api(apiPaths.notes)}`]: 'auth',
  [`PUT ${api(apiPaths.notes)}`]: 'editor',

  // history
  [`GET ${api(apiPaths.historyEdit)}`]: 'auth',
  [`GET ${api(apiPaths.historyPdf)}`]: 'auth',
  [`POST ${api(apiPaths.historyPdf)}`]: 'auth',
  [`GET ${api(apiPaths.historyCreate)}`]: 'auth',
  [`GET ${api(apiPaths.templateVersions)}`]: 'auth',
  [`GET ${api(apiPaths.snapshotById)}`]: 'auth',

  // vivliostyle
  [`POST ${api(apiPaths.build)}`]: 'auth',
  [`POST ${api(apiPaths.buildProject)}`]: 'editor',
  [`POST ${api(apiPaths.buildMerge)}`]: 'auth',
  [`GET ${api(apiPaths.preview)}`]: 'auth',
  [`POST ${api(apiPaths.preview)}`]: 'editor',
  [`GET ${api(apiPaths.previewById)}`]: 'auth',
  [`DELETE ${api(apiPaths.previewById)}`]: 'editor',
  [`GET ${api(apiPaths.previewById)}/*`]: 'auth',
  // 画面内プレビューの隔離ビューア(ホストページ + バンドル + 同梱資産)。閲覧そのものなので
  // viewer にも開く。認証は必須 — 未認証に開くと同梱資産が匿名で読める面になる。
  [`GET ${api(PREVIEW_HOST_BASE)}/index.html`]: 'auth',
  [`GET ${api(PREVIEW_HOST_BASE)}/*`]: 'auth',

  // render — 他人のテンプレを nunjucks でコンパイルする隔離 iframe(ホストページ +
  // バンドル)。テンプレの閲覧そのものなので viewer にも開く。認証は必須 — 未認証に開くと
  // `'unsafe-eval'` 付きの経路が匿名で叩ける面になる。
  [`GET ${api(RENDER_HOST_BASE)}/index.html`]: 'auth',
  [`GET ${api(RENDER_HOST_BASE)}/*`]: 'auth',

  // reviews
  [`POST ${api(apiPaths.reviewRequests)}`]: 'editor',
  [`GET ${api(apiPaths.reviewRequests)}`]: 'auth',
  [`GET ${api(apiPaths.reviewRequestById)}`]: 'auth',
  [`POST ${api(apiPaths.reviewRequestApprove)}`]: 'approver',
  [`POST ${api(apiPaths.reviewRequestReject)}`]: 'approver',

  // users
  [`GET ${api(apiPaths.users)}`]: 'admin',
  [`POST ${api(apiPaths.users)}`]: 'admin',
  [`PATCH ${api(apiPaths.userById)}`]: 'admin',
  [`POST ${api(apiPaths.userResetPassword)}`]: 'admin',
};

/**
 * viewer(= `auth` 止まり)に開いてよい変更系ルートと、その理由。
 *
 * 既定は「変更系は `editor` 以上」で、ここに理由付きで載っているものだけが例外になる。
 * 新しい POST/PUT/PATCH/DELETE を `auth` のまま足すと `assertRoutePolicy` が起動時に
 * 落ちるので、緩める判断は必ずこの表への追記として残る。
 */
export const VIEWER_ALLOWED_MUTATIONS: Readonly<Record<string, string>> = {
  [`POST ${api(apiPaths.authLogin)}`]: 'ログインそのもの。未認証で到達する唯一の入口',
  [`POST ${api(apiPaths.authLogout)}`]: '自分のセッションを閉じるだけ',
  [`POST ${api(apiPaths.authInitPassword)}`]: '自分のパスワード変更。対象はセッション所有者に固定',
  [`POST ${api(apiPaths.historyPdf)}`]: 'PDF 出力を viewer に許す以上、その記録も許す',
  [`POST ${api(apiPaths.build)}`]: '閲覧業務としての PDF 出力(サーバ状態を残さない)',
  [`POST ${api(apiPaths.buildMerge)}`]: '同上(複数文書の通しページ番号付き PDF)',
};

/** 各レベルで preHandler 配列に**参照一致**で含まれていなければならないガード。 */
const REQUIRED_GUARD: Readonly<Record<Exclude<GuardLevel, 'public' | 'auth'>, unknown>> = {
  editor: requireEditor,
  approver: requireApprover,
  admin: requireAdmin,
};

/**
 * `/api/docs` は Scalar プラグインが自前でルートを生やす外部依存で、登録される URL 集合が
 * 我々の管理下に無い。ここだけは表の対象外にする(この 1 件が唯一の例外で、増やすときは
 * 「そのルート集合を我々が書いていないこと」を条件にする)。
 */
const EXTERNAL_ROUTE_PREFIXES: readonly string[] = ['/api/docs'];

const MUTATION_METHODS: readonly string[] = ['POST', 'PUT', 'PATCH', 'DELETE'];

/** `method` は単数/配列の両方を取る(`app.route({method:['GET','HEAD']})`)ので正規化する。 */
function methodsOf(routeOptions: RouteOptions): string[] {
  const raw = routeOptions.method;
  const list = Array.isArray(raw) ? raw : [raw];
  // HEAD は Fastify の `exposeHeadRoutes` が GET から自動生成する。表を二重に持たない。
  return [...new Set(list.map(String).filter((m) => m !== 'HEAD'))];
}

function preHandlersOf(routeOptions: RouteOptions): unknown[] {
  const raw = routeOptions.preHandler;
  if (!raw) return [];
  return Array.isArray(raw) ? [...raw] : [raw];
}

/** 実際に付いているガードから読み取ったレベル。表の宣言と厳密一致していなければならない。 */
function levelOf(preHandlers: readonly unknown[]): GuardLevel {
  if (!preHandlers.includes(requireAuth)) return 'public';
  if (preHandlers.includes(requireAdmin)) return 'admin';
  if (preHandlers.includes(requireApprover)) return 'approver';
  if (preHandlers.includes(requireEditor)) return 'editor';
  return 'auth';
}

/**
 * `app.addHook('onRoute', assertRoutePolicy)` として **API ルートの register より前**に
 * 張る。フックは張った後に登録されたルートしか見ないため、順序が要件になる。
 *
 * 起動時の失敗なので HTTP へは変換されない = `AppError` ではなく素の `Error` を投げる。
 */
export function assertRoutePolicy(routeOptions: RouteOptions): void {
  const url = routeOptions.url;
  if (!url.startsWith('/api')) return;
  if (EXTERNAL_ROUTE_PREFIXES.some((prefix) => url.startsWith(prefix))) return;

  const preHandlers = preHandlersOf(routeOptions);
  const actual = levelOf(preHandlers);
  for (const method of methodsOf(routeOptions)) {
    const key = `${method} ${url}`;
    const declared = ROUTE_POLICY[key];
    if (declared === undefined) {
      throw new Error(
        `[routeGuards] 未登録のルートです: ${key} — ` +
          'src/routes/routeGuards.ts の ROUTE_POLICY へ必要ロールを追加してください',
      );
    }
    if (declared !== actual) {
      throw new Error(
        `[routeGuards] ${key} は ROUTE_POLICY で '${declared}' ですが、実際のガードは ` +
          `'${actual}' です — preHandler と表のどちらかが誤っています`,
      );
    }
    const guard = declared === 'public' || declared === 'auth' ? null : REQUIRED_GUARD[declared];
    if (guard && !preHandlers.includes(guard)) {
      throw new Error(`[routeGuards] ${key} に '${declared}' のガードが付いていません`);
    }
    if (
      MUTATION_METHODS.includes(method) &&
      (declared === 'auth' || declared === 'public') &&
      VIEWER_ALLOWED_MUTATIONS[key] === undefined
    ) {
      throw new Error(
        `[routeGuards] ${key} は変更系なのに viewer へ開いています — requireEditor を付けるか、` +
          '理由を VIEWER_ALLOWED_MUTATIONS へ明記してください',
      );
    }
  }
}
