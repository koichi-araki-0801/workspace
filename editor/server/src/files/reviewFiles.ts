// =============================================================================
// reviewFiles.ts — 確定保存の承認待ち申請(ディスク I/O)
// =============================================================================
// 確定保存の申請を `<dataRoot>/reviews/<reqId>/` に保管する(git 管理外。`ensureRepo` が
// `/reviews/` を .gitignore する)。1 申請 = 1 ディレクトリで、メタ(`meta.json`)と本体
// (`body.html` / `body.css` / 任意 `filled.html` / 任意 `baseline.css`)を分けて持つ。
// 一覧は readdir、状態更新は `meta.json` の書き換え。`templateFiles.ts`/`draftFiles.ts` と同じく本体はファイル、索引は
// メタに寄せる方針(`atomicWrite` で半端読みを防ぐ)。
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import {
  notFound,
  type ReviewRequestMeta,
  type StoredReviewRequest,
  toReviewMeta,
  unexpected,
} from '@editor/shared';
import { ReviewStatus } from '@editor/shared/schemas';
import { config } from '../config.js';
import { logger } from '../logger.js';
import { mapLimit } from '../util/mapLimit.js';
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
const baselineCssPath = (reqId: string) => path.join(reviewDir(reqId), 'baseline.css');

/** 申請のメタ + 本体を新規作成する(申請=submit 時)。 */
export async function writeReview(req: StoredReviewRequest): Promise<void> {
  const dir = reviewDir(req.id);
  await fs.mkdir(dir, { recursive: true });
  await atomicWrite(bodyHtmlPath(req.id), req.html);
  await atomicWrite(bodyCssPath(req.id), req.css);
  if (req.filledHtml !== undefined) await atomicWrite(filledPath(req.id), req.filledHtml);
  if (req.cssBaseline !== undefined) await atomicWrite(baselineCssPath(req.id), req.cssBaseline);
  // 本体を先に書いてからメタを書く(メタが在れば本体も在る、を保つ)。
  await atomicWrite(metaPath(req.id), JSON.stringify(toReviewMeta(req), null, 2));
}

/**
 * 状態が不明で読み飛ばした申請の id。一覧は開くたびに全件を読むので、警告は申請ごとに
 * プロセスで 1 回だけ出す(同じ警告でログを埋めない)。
 */
const warnedUnknownStatus = new Set<string>();

/**
 * 申請メタを読む。無ければ null(モジュール内部ヘルパ)。
 *
 * `status` が現行の 3 状態(`ReviewStatus`)の外にあるメタは読み飛ばし(null)、警告ログに残す。
 * 応答のスキーマに合わない 1 件のために一覧全体を落とさないため。単件の読み取りでは
 * 「見つからない」になる。
 */
async function readReviewMeta(reqId: string): Promise<ReviewRequestMeta | null> {
  const raw = await fs.readFile(metaPath(reqId), 'utf8').catch(() => null);
  if (raw === null) return null;
  const parsed = JSON.parse(raw) as ReviewRequestMeta;
  if (!ReviewStatus.safeParse(parsed.status).success) {
    if (!warnedUnknownStatus.has(reqId)) {
      warnedUnknownStatus.add(reqId);
      logger.warn({ reqId, status: parsed.status }, '申請の状態が不明なため読み飛ばしました');
    }
    return null;
  }
  return parsed;
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
export async function readReview(reqId: string): Promise<StoredReviewRequest | null> {
  const meta = await readReviewMeta(reqId);
  if (!meta) return null;
  const html = await readBodyFile(bodyHtmlPath(reqId), reqId);
  const css = await readBodyFile(bodyCssPath(reqId), reqId);
  // filled.html は任意添付のため、無い(読めない)ときは undefined のままでよい。
  const filledHtml = await fs.readFile(filledPath(reqId), 'utf8').catch(() => undefined);
  // baseline.css も任意。無い(読めない)申請は承認でペアへの CSS の転写だけを飛ばす。
  const cssBaseline = await fs.readFile(baselineCssPath(reqId), 'utf8').catch(() => undefined);
  return {
    ...meta,
    html,
    css,
    ...(filledHtml !== undefined ? { filledHtml } : {}),
    ...(cssBaseline !== undefined ? { cssBaseline } : {}),
  };
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

/**
 * 同じ id の承認待ちの作成申請(origin=create)があるか。あるうちに作り直すと、承認でその申請の
 * 内容が templates/ に入り、作り直した生成物と食い違う。照合は大文字小文字を区別しない。
 */
export async function hasPendingCreateReview(templateId: string): Promise<boolean> {
  const want = templateId.toLowerCase();
  return (await listReviewMetas()).some(
    (m) => m.status === 'pending' && m.origin === 'create' && m.templateId.toLowerCase() === want,
  );
}

/** 申請本文(HTML と CSS)の照合用の hash。区切りを挟むので、境界のずれた別の組と一致しない。 */
export function reviewContentHash(html: string, css: string): string {
  return createHash('sha1').update(html).update('\x00').update(css).digest('hex');
}

/**
 * 同じ人・同じテンプレ・同じ経路で、本文(HTML と CSS)も同じ承認待ちの申請を探す。あれば
 * その申請を、無ければ null を返す。二重クリックや再送で同じ申請がキューに並ぶのを止めるのに使う。
 *
 * 本文を読むのはメタの 3 項目が一致した申請だけ(同じ人・同じテンプレの承認待ちは普通 0〜2 件)。
 * hash をメタに持たせないのは、メタが API 応答の型でもあり、足すと openapi と web の型が動くため。
 * templateId の照合は `hasPendingCreateReview` と同じく大文字小文字を区別しない。
 */
export async function findDuplicatePendingReview(p: {
  templateId: string;
  origin: ReviewRequestMeta['origin'];
  submittedBy: string;
  contentHash: string;
}): Promise<ReviewRequestMeta | null> {
  const want = p.templateId.toLowerCase();
  const candidates = (await listReviewMetas()).filter(
    (m) =>
      m.status === 'pending' &&
      m.origin === p.origin &&
      m.submittedBy === p.submittedBy &&
      m.templateId.toLowerCase() === want,
  );
  for (const m of candidates) {
    // 本文の読めない申請は重複の判定から外す。ここで失敗にすると、壊れた 1 件のせいで同じ人が
    // そのテンプレへ申請できなくなる(その申請自体は承認時に `readReview` が止める)。
    const body = await Promise.all([
      fs.readFile(bodyHtmlPath(m.id), 'utf8'),
      fs.readFile(bodyCssPath(m.id), 'utf8'),
    ]).catch((err: unknown) => {
      const code = (err as NodeJS.ErrnoException | undefined)?.code;
      if (code !== 'ENOENT') {
        logger.warn({ reqId: m.id, code }, '重複判定のため申請の本文を読めず、読み飛ばしました');
      }
      return null;
    });
    if (body && reviewContentHash(body[0], body[1]) === p.contentHash) return m;
  }
  return null;
}

/** 同時に開くメタファイル数。`Promise.all` の全件同時 open は fd を枯渇させる。 */
const REVIEW_READ_CONCURRENCY = 8;

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
