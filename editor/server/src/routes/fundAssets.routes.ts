// =============================================================================
// fundAssets.routes.ts — 画像(imagesDir 直下と会社フォルダ 1 段)の読み取り専用ルート
// =============================================================================
// 画面内プレビュー(親が取得して data URI に埋める)と編集画面(canvas の CSS が
// `content:url()` で引く)の唯一の取得先。プレビューホストの資産ルートは `images/` を配らない
// ので、SVG 検査を通らない画像の配信経路は無い(`test/guardCoverage.guard.test.ts` が固定する)。
//
// 経路は `:file`(直下)と `:dir/:file`(会社フォルダ 1 段)の 2 本で、深さは経路の形で決める
// (ワイルドカードにしない)。1 つのパラメータは 1 セグメントで、復号した `/` `\` で深さを
// 偽装させない。会社コードとの照合はしない — テンプレ ID を持たないこの経路では決められないため、
// 照合は ID を知る web 側(`companyFolderMatches`)が行う。
//
// 経路の検査は 2 段: `resolveServedRoutePath`(`..`・絶対参照の拒否。プレビューホストと
// 同じ前段)→ `resolveServedAssetSource`(許可リスト・深さ・会社フォルダ名の大小文字無視・
// Windows で別の実体へ読み替わる名前の拒否・symlink 拒否を PDF の配置と共有する)。別の解決器は
// 作らない。Windows の予約名は lstat が装置として成功しうるので、実体に触れる前に名前で落とす。
//
// 閲覧権限は CSS と同じ(ログインしていれば全テンプレの画像を見られる)。応答は `no-store` —
// 画像は外部ツールが差し替えるため、古い版をブラウザに残さない。
//
// 確認 API(`POST /fund-assets/inspect`)は配信ルートと同じ `inspectFundImage` を通し、画像ごとに
// ok / missing / svg_rejected(違反の文言付き)を返す。編集画面とプレビューが「SVG の検査で
// 配信しない」理由を警告に出すための経路で、ファイルの中身は返さない。

import fs from 'node:fs/promises';
import path from 'node:path';
import type {
  FundAssetInspectRequest,
  FundAssetInspectResponse,
  FundAssetInspectResult,
  FundAssetRef,
} from '@editor/shared';
import { apiPaths, inspectSvg, resolveServedRoutePath } from '@editor/shared';
import type { FastifyInstance, FastifyReply } from 'fastify';
import { logger } from '../logger.js';
import { requireAuth } from '../middleware/auth.js';
import { validate } from '../middleware/validate.js';
import { FundAssetInspectRequest as FundAssetInspectRequestSchema } from '../openapi/schemas.js';
import { FUND_IMAGES_MOUNT, resolveServedAssetSource } from '../vivliostyle/docAssets.js';

/** 拡張子 → Content-Type。許可リスト外の拡張子は解決器が先に弾く。 */
const IMAGE_CONTENT_TYPES: ReadonlyMap<string, string> = new Map([
  ['.svg', 'image/svg+xml'],
  ['.png', 'image/png'],
  ['.jpg', 'image/jpeg'],
  ['.jpeg', 'image/jpeg'],
]);

/** Windows の予約デバイス名(拡張子付きを含む)。 */
const WINDOWS_RESERVED_RE = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\..*)?$/i;

/**
 * 直接開かれた SVG を opaque オリジンに閉じ込める CSP。`<img>` / CSS `content:url()` として
 * 読まれる限りスクリプトは動かないが、URL を直接開かれた場合に同一オリジンの文書にしない。
 */
const SVG_CSP = 'sandbox';

/**
 * ルートのパラメータから実体の絶対パスを引く。`dir` は会社フォルダ(直下なら null)。
 * 引数は 1 回だけ復号されたものとして扱い、もう一度は解かない(`%41` はその字面の名前)。
 * 正規化で形が変わる入力(`..`・区切り・前後の空白)は、どこを指すかを推測せずに拒む。
 */
export async function resolveFundImageSource(
  dir: string | null,
  file: string,
): Promise<string | undefined> {
  const segments = dir === null ? [file] : [dir, file];
  if (segments.some((s) => s.includes('/') || s.includes('\\') || WINDOWS_RESERVED_RE.test(s))) {
    return undefined;
  }
  const wanted = [FUND_IMAGES_MOUNT, ...segments].join('/');
  if (resolveServedRoutePath(wanted) !== wanted) return undefined;
  return resolveServedAssetSource(wanted);
}

/**
 * 1 枚の判定。配信ルートと確認 API が同じ関数を通るので、「確認では ok なのに配信は 404」の
 * ずれが起きない。`missing` は存在しない・経路が不正・許可外の拡張子をまとめたもので、
 * どれに当たったかは区別しない(置き場の外の名前の有無を確かめる手段にしない)。
 */
export type FundImageInspection =
  | { status: 'ok'; body: Buffer; type: string }
  | { status: 'missing' }
  | { status: 'svg_rejected'; violations: string[] };

export async function inspectFundImage(
  dir: string | null,
  file: string,
): Promise<FundImageInspection> {
  const source = await resolveFundImageSource(dir, file);
  const type =
    source === undefined ? undefined : IMAGE_CONTENT_TYPES.get(path.extname(source).toLowerCase());
  if (source === undefined || type === undefined) return { status: 'missing' };
  let body: Buffer;
  try {
    body = await fs.readFile(source);
  } catch {
    return { status: 'missing' };
  }
  if (type === 'image/svg+xml') {
    const violations = inspectSvg(body.toString('utf8'));
    if (violations.length > 0) return { status: 'svg_rejected', violations };
  }
  return { status: 'ok', body, type };
}

/** 1 枚を返す(存在しない / 配信対象外 / 違反は区別せず 404 本文なし。理由を外へ漏らさない)。 */
async function sendFundImage(
  reply: FastifyReply,
  dir: string | null,
  file: string,
): Promise<FastifyReply> {
  const inspected = await inspectFundImage(dir, file);
  if (inspected.status === 'svg_rejected') {
    logger.warn(
      {
        type: 'asset.svg_rejected',
        file: [FUND_IMAGES_MOUNT, ...(dir === null ? [] : [dir]), file].join('/'),
        violations: inspected.violations,
      },
      'SVG の検査に違反したため配信しません',
    );
  }
  if (inspected.status !== 'ok') return reply.code(404).send();
  return reply.type(inspected.type).send(inspected.body);
}

/** 確認 API が返す違反の文言 1 件の最大長(UTF-16 単位。超えた分は `…` で切る)。 */
const MAX_VIOLATION_CHARS = 200;

/**
 * 違反の文言は要素名・属性名をそのまま含むので、長い名前を書いた SVG で応答が膨らまないよう
 * 切り詰める。ログ(`asset.svg_rejected`)は全文のまま残す。
 */
function capViolation(text: string): string {
  return text.length <= MAX_VIOLATION_CHARS ? text : `${text.slice(0, MAX_VIOLATION_CHARS - 1)}…`;
}

/**
 * 画像ごとの判定を返す(中身は返さない)。理由を出すのはログインした利用者に限るこの経路だけで、
 * 直接開かれうる配信ルートの 404 には理由を載せない。読み込みは 1 件ずつ順に行う — 上限 50 件の
 * 同時読み込みで共有ドライブを叩かないため。
 */
async function inspectFundImages(refs: readonly FundAssetRef[]): Promise<FundAssetInspectResponse> {
  const results: FundAssetInspectResult[] = [];
  for (const { dir, file } of refs) {
    const inspected = await inspectFundImage(dir, file);
    results.push(
      inspected.status === 'svg_rejected'
        ? {
            dir,
            file,
            status: inspected.status,
            violations: inspected.violations.map(capViolation),
          }
        : { dir, file, status: inspected.status },
    );
  }
  return { results };
}

/**
 * 画像の単体配信ルート。`app.register(fundAssetsRoutes, { prefix: '/api' })` のように
 * fastify-plugin を通さずに登録する = 独自コンテキストになり、下の `onSend` はこのルートにだけ
 * 掛かる(`vivliostyle/previewHost.ts` と同じ作法)。helmet は `onRequest` でヘッダを置くので、
 * `onSend` の上書きが必ず勝つ。
 */
export async function fundAssetsRoutes(app: FastifyInstance): Promise<void> {
  app.addHook('onSend', async (_request, reply) => {
    reply.header('x-content-type-options', 'nosniff');
    reply.header('cache-control', 'no-store');
    if (String(reply.getHeader('content-type') ?? '').startsWith('image/svg+xml')) {
      reply.header('content-security-policy', SVG_CSP);
    }
  });

  app.get<{ Params: { file: string } }>(
    apiPaths.fundAssetImage,
    { preHandler: requireAuth },
    async (request, reply) => sendFundImage(reply, null, request.params.file),
  );

  app.get<{ Params: { dir: string; file: string } }>(
    apiPaths.fundAssetImageInDir,
    { preHandler: requireAuth },
    async (request, reply) => sendFundImage(reply, request.params.dir, request.params.file),
  );

  app.post<{ Body: FundAssetInspectRequest }>(
    apiPaths.fundAssetInspect,
    { preHandler: [requireAuth, validate(FundAssetInspectRequestSchema)] },
    async (request) => inspectFundImages(request.body.refs),
  );
}
