// =============================================================================
// http.ts — フェーズ 2 リポジトリの REST トランスポート(`apiFetch` と `attemptRest`)
// =============================================================================
// 役割: `apiFetch` は same-origin の `/api` を叩き、session cookie を送り
// (`credentials: 'include'`)、HTTP 失敗を共有 {@link AppError} へ写す。サーバの構造化
// ボディ `{ kind, message, code }` を優先し、無ければステータスコードへフォールバック
// する。`attemptRest`(throw→Result シーム)は local repos の `attempt` を再 export する。
import { type AppError, type AppErrorKind, appError, network } from '@editor/shared';

// throw→Result シームは local と REST で同一なので、REST は local の `attempt` を再利用
// する(既存 import を保つため `attemptRest` として再 export)。
export { attempt as attemptRest } from '../local/attempt';

const BASE = '/api';

/**
 * `apiPaths` の `/api` 無しパスへ `BASE` を前置した絶対パスを返す。`apiFetch` を経由できない
 * 直 `fetch`(例: Blob を受け取る PDF build)で `BASE` を二重管理しないために使う。
 */
export const apiUrl = (path: string): string => `${BASE}${path}`;

const STATUS_KIND: Record<number, AppErrorKind> = {
  400: 'validation',
  401: 'unauthorized',
  403: 'forbidden',
  404: 'not_found',
  409: 'conflict',
};

const KIND_MESSAGE: Record<AppErrorKind, string> = {
  validation: 'リクエスト内容が正しくありません',
  unauthorized: 'ログインが必要です',
  forbidden: '権限がありません',
  not_found: '対象が見つかりません',
  conflict: 'すでに存在するか、競合しています',
  network: 'サーバに接続できません',
  unexpected: '予期しないエラーが発生しました',
};

interface ErrorBody {
  kind?: unknown;
  message?: unknown;
  code?: unknown;
}

async function toError(res: Response): Promise<AppError> {
  let body: ErrorBody | undefined;
  try {
    body = (await res.json()) as ErrorBody;
  } catch {
    body = undefined;
  }
  if (body && typeof body.kind === 'string' && typeof body.message === 'string') {
    return appError(body.kind as AppErrorKind, body.message, {
      code: typeof body.code === 'string' ? body.code : undefined,
    });
  }
  const kind: AppErrorKind = STATUS_KIND[res.status] ?? 'unexpected';
  return appError(kind, KIND_MESSAGE[kind]);
}

interface FetchOptions {
  method?: string;
  query?: Record<string, string | undefined>;
  body?: unknown;
}

export async function apiFetch<T>(path: string, opts: FetchOptions = {}): Promise<T> {
  const url = new URL(`${BASE}${path}`, window.location.origin);
  if (opts.query) {
    for (const [k, v] of Object.entries(opts.query)) {
      if (v != null && v !== '') url.searchParams.set(k, v);
    }
  }
  const hasBody = opts.body !== undefined;
  let res: Response;
  try {
    res = await fetch(url.toString(), {
      method: opts.method ?? 'GET',
      credentials: 'include',
      headers: hasBody ? { 'Content-Type': 'application/json' } : undefined,
      body: hasBody ? JSON.stringify(opts.body) : undefined,
    });
  } catch (e) {
    throw network(KIND_MESSAGE.network, { cause: e });
  }
  if (!res.ok) throw await toError(res);
  if (res.status === 204) return undefined as T;
  return (await res.json()) as T;
}
