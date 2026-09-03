// =============================================================================
// api-paths.ts — REST エンドポイントパスの単一正典(Fastify テンプレート形)
// =============================================================================
// 同じ論理パスを server のルート(`:id`)・OpenAPI document(`{id}`)・web の
// `apiFetch`(実値 `${id}`)・テストの 4 箇所に別々の方言で書くと、パス変更や
// パラメータ名(`id`/`templateId` 等)のズレが齟齬の温床になる。ここでは Fastify 形
// (`:param`)を唯一の正典とし、OpenAPI 形と実値埋め込みは `toOpenApiPath` /
// `buildPath` で機械導出することで、3 方言の不一致を構造的に起こせなくする。
//
// `/api` プレフィックスは含めない。付与は各層が担う: server は `register(prefix:'/api')`、
// web は `http.ts` の `BASE`、OpenAPI は `servers[].url`。ここで含めると二重付与になる。

// ── 1. canonical paths — エンドポイントパスの正典(Fastify 形・`/api` 無し) ──

/**
 * 全 REST エンドポイントの Fastify 形パス。パラメータ名はここで確定する
 * (既存の不統一をそのまま固定: `templateById`=`:id`、`partHistory` 等=`:templateId`、
 * `fundSampleData`=`:fundCode`、`snapshotById`=`:historyId`)。
 */
export const apiPaths = {
  // system
  health: '/health',
  // auth
  authLogin: '/auth/login',
  authLogout: '/auth/logout',
  authMe: '/auth/me',
  authInitPassword: '/auth/init-password',
  // templates
  templatesOptions: '/templates/options',
  templatesSeries: '/templates/series',
  templates: '/templates',
  templateById: '/templates/:id',
  templateDraft: '/templates/:id/draft',
  templateSyncStatus: '/templates/:id/sync-status',
  generate: '/generate',
  fundSampleData: '/funds/:fundCode/sample-data',
  // parts
  partClassificationOptions: '/parts/classification-options',
  parts: '/parts',
  partHistory: '/templates/:templateId/part-history',
  // notes (パーツ単位メモ。投稿の追加/編集/削除は entryId 付きパス)
  notes: '/templates/:templateId/notes',
  noteEntry: '/templates/:templateId/notes/:entryId',
  // history
  historyEdit: '/history/edit',
  historyPdf: '/history/pdf',
  historyCreate: '/history/create',
  templateVersions: '/templates/:templateId/versions',
  snapshotById: '/snapshots/:historyId',
  // vivliostyle
  build: '/build',
  buildProject: '/build/project',
  buildMerge: '/build/merge',
  preview: '/preview',
  // ワイルドカード経路(reverse-proxy)はルート側で `+ '/*'` を合成する。
  previewById: '/preview/:id',
  // reviews (確定保存の精査者承認ワークフロー)
  reviewRequests: '/review-requests',
  reviewRequestById: '/review-requests/:reqId',
  reviewRequestApprove: '/review-requests/:reqId/approve',
  reviewRequestReject: '/review-requests/:reqId/reject',
  // users
  users: '/users',
  userById: '/users/:id',
  userResetPassword: '/users/:id/reset-password',
} as const;

/** `apiPaths` のキー集合。 */
export type ApiPathKey = keyof typeof apiPaths;

// ── 2. dialect conversions — OpenAPI 形 / 実値埋め込みへの機械導出 ──

/**
 * Fastify 形(`:p`)を OpenAPI 形(`{p}`)へ変換する。OpenAPI document の `paths` キー
 * 生成に使う。`:` を含まないパスはそのまま素通しする。
 */
export function toOpenApiPath(template: string): string {
  return template.replace(/:([A-Za-z0-9_]+)/g, '{$1}');
}

/**
 * テンプレート文字列リテラルからパラメータ名を抽出する型。`/templates/:id/draft`
 * なら `'id'`、パラメータ無しなら `never`。
 */
type ParamName<S extends string> = S extends `${string}:${infer P}/${infer Rest}`
  ? P | ParamName<`/${Rest}`>
  : S extends `${string}:${infer P}`
    ? P
    : never;

/**
 * テンプレートが要求するパラメータの型。パラメータ付きは各名を必須の `string`、
 * 無しは空オブジェクト。`id`/`templateId` の取り違えはこの型でコンパイル時に弾く。
 */
export type PathParams<S extends string> = [ParamName<S>] extends [never]
  ? Record<never, never>
  : { [K in ParamName<S>]: string };

/**
 * Fastify 形テンプレート + 実値から URL パスを組み立てる(web の `apiFetch` 用)。
 * 各値は `encodeURIComponent` でエスケープする。
 */
export function buildPath<S extends string>(template: S, params: PathParams<S>): string {
  return template.replace(/:([A-Za-z0-9_]+)/g, (_m, name: string) =>
    encodeURIComponent((params as Record<string, string>)[name]),
  );
}
