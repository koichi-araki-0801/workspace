// =============================================================================
// reviewFiles.ts — 確定保存の承認待ち申請(ディスク I/O)
// =============================================================================
// 確定保存の申請を `data/reviews/<reqId>/` に保管する(git 管理外。`ensureRepo` が
// `/reviews/` を .gitignore する)。1 申請 = 1 ディレクトリで、メタ(`meta.json`)と本体
// (`body.html` / `body.css` / 任意 `filled.html`)を分けて持つ。一覧は readdir、状態更新は
// `meta.json` の書き換え。`templateFiles.ts`/`draftFiles.ts` と同じく本体はファイル、索引は
// メタに寄せる方針(`atomicWrite` で半端読みを防ぐ)。
import fs from 'node:fs/promises';
import path from 'node:path';
import {
  notFound,
  type ReviewRequest,
  type ReviewRequestMeta,
  toReviewMeta,
  unexpected,
} from '@editor/shared';
import { config } from '../config.js';
import { atomicWrite } from './atomic.js';

/** reqId は内部生成(英数字/`-`/`_`)。パストラバーサルを弾き、ディレクトリ脱出を防ぐ。 */
const REQ_ID_PATTERN = /^[A-Za-z0-9_-]+$/;

function reviewDir(reqId: string): string {
  if (!REQ_ID_PATTERN.test(reqId)) throw notFound(`申請が見つかりません: ${reqId}`);
  return path.join(config.reviewsDir, reqId);
}

const metaPath = (reqId: string) => path.join(reviewDir(reqId), 'meta.json');
const bodyHtmlPath = (reqId: string) => path.join(reviewDir(reqId), 'body.html');
const bodyCssPath = (reqId: string) => path.join(reviewDir(reqId), 'body.css');
const filledPath = (reqId: string) => path.join(reviewDir(reqId), 'filled.html');

/** 申請のメタ + 本体を新規作成する(申請=submit 時)。 */
export async function writeReview(req: ReviewRequest): Promise<void> {
  const dir = reviewDir(req.id);
  await fs.mkdir(dir, { recursive: true });
  await atomicWrite(bodyHtmlPath(req.id), req.html);
  await atomicWrite(bodyCssPath(req.id), req.css);
  if (req.filledHtml !== undefined) await atomicWrite(filledPath(req.id), req.filledHtml);
  // 本体を先に書いてからメタを書く(メタが在れば本体も在る、を保つ)。
  await atomicWrite(metaPath(req.id), JSON.stringify(toReviewMeta(req), null, 2));
}

/** 申請メタを読む。無ければ null(モジュール内部ヘルパ)。 */
async function readReviewMeta(reqId: string): Promise<ReviewRequestMeta | null> {
  const raw = await fs.readFile(metaPath(reqId), 'utf8').catch(() => null);
  if (raw === null) return null;
  return JSON.parse(raw) as ReviewRequestMeta;
}

/**
 * 本体ファイル(html/css)を読む。読取失敗は `writeReview` の「メタが在れば本体も在る」
 * 不変条件が破れた異常(部分削除・ディスク障害等)。空文字へ倒すと承認時に本番テンプレート
 * を空内容で上書きしてしまうため、必ずエラーにする。
 */
async function readBodyFile(filePath: string, reqId: string): Promise<string> {
  try {
    return await fs.readFile(filePath, 'utf8');
  } catch (cause) {
    throw unexpected(`申請本文の読み取りに失敗しました: ${reqId}`, { cause });
  }
}

/** 申請を本体込みで読む。無ければ null。本体(html/css)が読めない申請はエラー。 */
export async function readReview(reqId: string): Promise<ReviewRequest | null> {
  const meta = await readReviewMeta(reqId);
  if (!meta) return null;
  const html = await readBodyFile(bodyHtmlPath(reqId), reqId);
  const css = await readBodyFile(bodyCssPath(reqId), reqId);
  // filled.html は任意添付のため、無い(読めない)ときは undefined のままでよい。
  const filledHtml = await fs.readFile(filledPath(reqId), 'utf8').catch(() => undefined);
  return { ...meta, html, css, ...(filledHtml !== undefined ? { filledHtml } : {}) };
}

/** 全申請のメタ一覧(順序は呼び出し側でソート)。壊れた/読めないエントリは飛ばす。 */
export async function listReviewMetas(): Promise<ReviewRequestMeta[]> {
  const entries = await fs.readdir(config.reviewsDir).catch(() => [] as string[]);
  const metas = await Promise.all(
    entries.filter((e) => REQ_ID_PATTERN.test(e)).map((e) => readReviewMeta(e).catch(() => null)),
  );
  return metas.filter((m): m is ReviewRequestMeta => m !== null);
}

/** 申請メタを部分更新する(承認/却下の状態遷移)。本体は触らない。 */
export async function updateReviewMeta(
  reqId: string,
  patch: Partial<ReviewRequestMeta>,
): Promise<ReviewRequestMeta> {
  const cur = await readReviewMeta(reqId);
  if (!cur) throw notFound(`申請が見つかりません: ${reqId}`);
  const next = { ...cur, ...patch };
  await atomicWrite(metaPath(reqId), JSON.stringify(next, null, 2));
  return next;
}
