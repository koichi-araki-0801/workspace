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
import { logger } from '../logger.js';
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

/**
 * 申請メタを読む。無ければ null(モジュール内部ヘルパ)。
 *
 * 旧い meta.json には保留(`held`)の状態と `heldBy` / `heldAt` / `holdComment` が残っている
 * ことがある。保留は撤去したので、読み取りで `pending` に正規化し保留の 3 フィールドは
 * 落とす。書き戻しはしない — 次の決着(承認 / 差し戻し)で新しい meta が書かれ自然に消える。
 */
async function readReviewMeta(reqId: string): Promise<ReviewRequestMeta | null> {
  const raw = await fs.readFile(metaPath(reqId), 'utf8').catch(() => null);
  if (raw === null) return null;
  const parsed = JSON.parse(raw) as Record<string, unknown>;
  delete parsed.heldBy;
  delete parsed.heldAt;
  delete parsed.holdComment;
  const status = parsed.status === 'held' ? 'pending' : parsed.status;
  return { ...parsed, status } as ReviewRequestMeta;
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

/**
 * 一覧で走査する申請ディレクトリ数の上限。申請を削除するコードはリポジトリに無く件数は
 * 単調増加するため、無制限に読むと承認一覧が徐々に重くなり最後は開かなくなる。
 * 超過分は捨てる(分類 B: degrade。一覧が出ないより出るほうがよい)。
 */
export const MAX_REVIEW_SCAN = 5_000;

/**
 * **未処理(pending)**申請の同時保持数の上限。申請の作成は editor 1 ロールでいくらでも
 * 撃てるうえ、1 件あたり最大でボディ上限ぶんのバイト列を `reviewsDir` へ書く。上限が無いと
 * 1 人で dataRoot を膨らませられ、`reviewsDir` は templates / `.git` と同じボリュームに
 * あるので、枯渇は `atomicWrite` と `commitAll` の失敗 = **承認フローの停止**へ直結する。
 *
 * 数える対象を pending に限るのは、決着済み(approved/rejected)の件数は**承認者の操作
 * ぶんしか増えない**ため。攻撃者が伸ばせるのは pending だけで、そこを縛れば増加は止まる。
 * 逆に総数で縛ると、決着済みが積もった時点で新規申請が恒久的に通らなくなる
 * (削除経路を持たない以上、自ら作る停止状態のほうが害が大きい)。
 *
 * 値は「人が処理する行列」の現実的な上限。500 件の未処理は運用としては既に破綻しており、
 * ここに達したら資源ではなく運用を直すべき状態である。
 */
export const MAX_PENDING_REVIEWS = 500;

/**
 * 未処理申請の件数。上限判定に使う(一覧と同じ走査上限が掛かる)。
 */
export async function countPendingReviews(): Promise<number> {
  const metas = await listReviewMetas();
  return metas.filter((m) => m.status === 'pending').length;
}

/** 同時に開くメタファイル数。`Promise.all` の全件同時 open は fd を枯渇させる。 */
const REVIEW_READ_CONCURRENCY = 8;

/** 同時実行数を制限しつつ全件を写像する(結果は入力順)。 */
async function mapLimit<T, R>(
  items: readonly T[],
  limit: number,
  task: (item: T) => Promise<R>,
): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  const run = async (): Promise<void> => {
    while (next < items.length) {
      const i = next;
      next += 1;
      out[i] = await task(items[i]);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, run));
  return out;
}

/**
 * 全申請のメタ一覧(順序は呼び出し側でソート)。壊れた/読めないエントリは飛ばす。
 *
 * 上限に当たったときの degrade は「**古いものから見えなくなる**」でなければならない。
 * 申請ディレクトリ名は `randomUUID` 由来で時系列順ではないため、readdir 順のまま
 * `slice` すると落ちる対象が名前の辞書順という利用者から見て無意味な軸で決まり、
 * 承認待ちの新しい申請が消えうる。よって mtime の降順で選ぶ。
 * 打ち切りが起きたことは警告ログに残す(一覧が全件でないことを運用者へ伝える)。
 */
export async function listReviewMetas(): Promise<ReviewRequestMeta[]> {
  const entries = await fs.readdir(config.reviewsDir).catch(() => [] as string[]);
  const ids = entries.filter((e) => REQ_ID_PATTERN.test(e));
  let targets = ids;
  if (ids.length > MAX_REVIEW_SCAN) {
    const stamped = await mapLimit(ids, REVIEW_READ_CONCURRENCY, async (id) => ({
      id,
      mtime: await fs
        .stat(path.join(config.reviewsDir, id))
        .then((s) => s.mtimeMs)
        .catch(() => 0),
    }));
    stamped.sort((a, b) => b.mtime - a.mtime);
    targets = stamped.slice(0, MAX_REVIEW_SCAN).map((s) => s.id);
    logger.warn(
      { total: ids.length, scanned: MAX_REVIEW_SCAN },
      '申請が上限件数を超えたため一覧は最新分のみを返しています(全件ではありません)',
    );
  }
  const metas = await mapLimit(targets, REVIEW_READ_CONCURRENCY, (e) =>
    readReviewMeta(e).catch(() => null),
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
