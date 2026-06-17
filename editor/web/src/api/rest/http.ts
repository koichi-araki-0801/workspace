/**
 * REST transport for the phase-2 repositories. `apiFetch` calls the same-origin
 * `/api`, sends the session cookie (`credentials: 'include'`), and maps HTTP
 * failures to the shared {@link AppError} — preferring the server's structured
 * `{ kind, message, code }` body, falling back to the status code. `attemptRest`
 * (the throw→Result seam) is re-exported from the local repos' `attempt`.
 */
import { type AppError, type AppErrorKind, appError, network } from '@editor/shared';

// The throw→Result seam is identical for local and REST repos, so REST reuses
// the local `attempt` (re-exported as `attemptRest` to keep existing imports).
export { attempt as attemptRest } from '../local/attempt';

const BASE = '/api';

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

export interface FetchOptions {
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
