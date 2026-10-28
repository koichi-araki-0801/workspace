// =============================================================================
// generate.routes.ts — 既存 Python ツールで新規テンプレートを生成
// =============================================================================
// 1 回の作成で、作成画面のファンドの交付版・全体版の両方と、生成器が一緒に書き出す組入先
// (マザーファンド・組入投信)を取り込む。流れは次の順。
//
// 1. 属性・Rep1 コード・コピー元を検査し、略称と Rep1 コードが Rep1 で同じ会社の組かを確かめる
//    (画面から食い違った組を送られても、他社のコードで生成させない)。
// 2. 会社ごとの排他の中で、残りをすべて行う。組入先は同じ会社のファンドなので、別のファンドの
//    作成でも同じファイルを書きうる。排他が無いと、相手が書いている途中のファイルを読みうる。
//    作成済み・申請中・作業中の判定もこの中で行い、判定と書き込みの間に同じテンプレートを別の
//    作成が作らないようにする。
// 3. 選んだファンドの両版について、作成済み・承認待ちの作成申請・作業中を判定する(片方でも当たれば
//    409。作業中だけは同意があれば両版まとめて置き換える)。
// 4. 生成器を呼び、組入先は版ごとに、作成済み・申請中・作業中のどれも無いものだけを取り込む
//    (別のファンドから作られた作業を消さない)。取り込まなかったものは応答の `skipped` に載せる。
// 5. 取り込むものを全部メモリ上にそろえてから pending へ書き、古い作業を消し、作成記録を残し、
//    取り込んだファイルだけを生成器の `output/` から消す。書く前の段で失敗すれば何も変わらない。
//    例外: 選んだファンドの両版にある古い綴りの pending だけは、書く前に消す(大文字小文字を
//    区別しないファイルシステムで、書いた後に消すと新しい生成物が消えるため)。よって
//    replaceExisting のとき、書く前か書いている途中で失敗すると、その古い綴りの pending は失われる。
//
// **確定ディレクトリ(templatesDir)へは書かない。** ここが確定書込を直呼びすると、
// 任意ロールの認証済みユーザが承認を経ない確定テンプレ実体を作れてしまう。
// 確定実体はペア同期の転写先条件・結合 PDF・比較タブの入力であり、さらに実行コード不変性
// (`security/templateScripts.ts`)の**基準そのもの**でもあるため、生成が確定領域へ書けると
// 基準を差し替えて任意の JS を承認へ通せる。よって本ルートは `pendingFiles.ts` にしか
// 書かず、確定への昇格は承認(`repositories/confirmedWrite.ts`)だけが行う。
import {
  apiPaths,
  assertTemplateAttributeToken,
  conflict,
  type GenerateSkipped,
  type SkeletonAttributes,
  skeletonFileName,
  type Template,
  templateIdFromFileName,
  validation,
} from '@editor/shared';
import { GenerateRequest } from '@editor/shared/schemas';
import type { FastifyPluginAsync } from 'fastify';
import type { z } from 'zod';
import { config } from '../config.js';
import type { Deps } from '../deps.js';
import { deleteDraft } from '../files/draftFiles.js';
import { withFileLock } from '../files/fileLock.js';
import { findInProgressIds } from '../files/inProgress.js';
import { deletePending, writePending } from '../files/pendingFiles.js';
import { hasPendingCreateReview } from '../files/reviewFiles.js';
import { findTemplateId, listTemplateFiles, readTemplateCss } from '../files/templateFiles.js';
import { assertRequestedBaseDate, latestBaseDate } from '../generate/baseDate.js';
import {
  GENERATED_EDITIONS,
  type GeneratedFile,
  generateTemplates,
  removeGeneratedFiles,
} from '../generate/pyTemplate.js';
import { auditedRethrow } from '../logger.js';
import { requireAuth, requireEditor } from '../middleware/auth.js';
import { validate } from '../middleware/validate.js';
import { recordCreate } from '../repositories/historyRepo.js';
import { actorOf } from './routeHelpers.js';

// トークン単位の検査はここに私有の複製を置かず `@editor/shared` の
// `assertTemplateAttributeToken` 1 本を呼ぶ。同じ判定を呼び出し元ごとの私有複製で持つと、
// 「生成は締まっているのに確定書込(`confirmedWrite.ts`)は緩い」のような非対称ができる。

/** 取り込む 1 版。書く前に HTML(注記マスタ適用済み)と CSS をそろえておく。 */
interface ImportItem {
  id: string;
  attributes: SkeletonAttributes;
  html: string;
  css: string;
  file: GeneratedFile;
  /** 作成画面のファンドの版か(偽なら組入先)。 */
  selected: boolean;
}

/** 略称の比較キー。Rep1 の略称は固定長で末尾に空白が付きうる。 */
const companyKey = (code: string): string => code.trimEnd().toLowerCase();

/**
 * 組入先の 1 版を取り込まない理由(取り込んでよければ null)。照合は選んだファンドの判定と同じく
 * 大文字小文字を区別しない。
 */
async function skipReason(
  templateFiles: string[],
  attrs: SkeletonAttributes,
  id: string,
): Promise<GenerateSkipped['reason'] | null> {
  if (findTemplateId(templateFiles, attrs.companyCode, attrs.fundCode, attrs.editionType)) {
    return 'created';
  }
  if (await hasPendingCreateReview(id)) return 'pendingReview';
  const found = await findInProgressIds(id);
  if (found.drafts.length > 0 || found.pending.length > 0) return 'inProgress';
  return null;
}

export const generateRoutes: FastifyPluginAsync<{
  deps: Pick<Deps, 'noteMaster' | 'templates'>;
}> = async (app, opts) => {
  const { noteMaster, templates } = opts.deps;

  app.post<{ Body: z.infer<typeof GenerateRequest> }>(
    apiPaths.generate,
    { preHandler: [requireAuth, requireEditor, validate(GenerateRequest)] },
    async (request) => {
      const body = request.body;
      const loginId = actorOf(request);
      const result = await auditedRethrow(
        request,
        'template.generate',
        async () => {
          // テンプレートは会社・ファンド・版種に 1 つで、基準日を持たない(基準日で使い回さない)。
          const companyCode = assertTemplateAttributeToken('会社コード', body.companyCode);
          const fundCode = assertTemplateAttributeToken('ファンドコード', body.fundCode);
          const openEdition = assertTemplateAttributeToken('版種', body.editionType);
          if (!(GENERATED_EDITIONS as readonly string[]).includes(openEdition)) {
            throw validation(`版種は ${GENERATED_EDITIONS.join('・')} のどちらかです`);
          }
          // 基準日は、指定があれば検査して使い、無ければ最新基準日。排他や生成器に触れる前に
          // 決めるので、不正な日付で会社の排他を取らず、生成器も呼ばない。
          const baseDate = body.baseDate
            ? assertRequestedBaseDate(body.baseDate)
            : latestBaseDate();
          const rep1CompanyCode = body.rep1CompanyCode.trim();
          // コピー元も属性と同じくここで検査する。検査済みの値だけを生成器と作成履歴へ渡す。
          const sourceFundCode = body.sourceFundCode
            ? assertTemplateAttributeToken('コピー元ファンドコード', body.sourceFundCode)
            : undefined;

          // 生成器へ渡すのは Rep1 コードなので、略称と組でない Rep1 コードを通すと他社のテンプレートを
          // この会社の名前で取り込める。Rep1 に届かないときは確かめられないので作らない(例外のまま返す)。
          const companies = await templates.listCompanies();
          const paired = companies.some(
            (c) =>
              companyKey(c.companyCode) === companyKey(companyCode) &&
              c.rep1CompanyCode.trim() === rep1CompanyCode,
          );
          if (!paired) {
            throw validation('会社と Rep1 の委託会社コードの組が Rep1 と一致しません');
          }

          return withFileLock(`generate-company:${companyKey(companyCode)}`, async () => {
            const editions = GENERATED_EDITIONS.map((editionType) => {
              const attributes: SkeletonAttributes = { companyCode, fundCode, editionType };
              return { attributes, id: templateIdFromFileName(skeletonFileName(attributes)) };
            });
            const templateFiles = await listTemplateFiles();

            // 画面はコピー元テンプレートが無い候補で作成を止めるが、API を直接呼ばれても同じ結果に
            // する。生成は両版を作るので、コピー元も両版そろっていること。照合は大文字小文字を
            // 区別しない(CSS の初期値にもこの id を使う)。
            const sourceIds = new Map<string, string>();
            if (sourceFundCode) {
              for (const { attributes } of editions) {
                const found = findTemplateId(
                  templateFiles,
                  companyCode,
                  sourceFundCode,
                  attributes.editionType,
                );
                if (found === null) {
                  throw validation(`コピー元のテンプレートがありません: ${sourceFundCode}`);
                }
                sourceIds.set(attributes.editionType, found);
              }
            }

            // ① 作成済みなら生成では触らない。直すときは作成タブで既存のテンプレートを開き、申請 →
            // 承認で templates/ を上書きする。照合は作成タブの「作成済み」と同じく大文字小文字を
            // 区別しない。両版を一緒に作るので、片方でも作成済みなら止める。
            for (const { attributes } of editions) {
              if (
                findTemplateId(templateFiles, companyCode, fundCode, attributes.editionType) !==
                null
              ) {
                throw conflict('作成済みです。既存のテンプレートを開いてください');
              }
            }
            // ② 承認待ちの作成申請があるうちに作り直すと、承認でその申請の内容が templates/ に入り、
            // 作り直した生成物と食い違う。
            for (const { id } of editions) {
              if (await hasPendingCreateReview(id)) {
                throw conflict('申請中です。承認か却下を待ってください');
              }
            }
            // ③ 作業中(下書きか pending)を黙って捨てない。画面は確認ダイアログで同意を得て送り直す。
            // 綴り違い(会社コードの大文字小文字)も同じテンプレートとして数える(① ② と同じ規則)。
            const inProgress = await Promise.all(editions.map(({ id }) => findInProgressIds(id)));
            const busy = inProgress.some((f) => f.drafts.length > 0 || f.pending.length > 0);
            if (body.replaceExisting !== true && busy) {
              throw conflict('作成中のテンプレートがあります');
            }

            // 生成器へはリクエスト本文を渡さず、検証済みの値だけを明示して組む(本文の他のキーが
            // 生成器のコードへ流れないようにする)。
            const generated = await generateTemplates(
              {
                companyCode,
                rep1CompanyCode,
                fundCode,
                ...(sourceFundCode === undefined ? {} : { sourceFundCode }),
                ...(body.isRedemption === true ? { isRedemption: true } : {}),
              },
              baseDate,
            );

            // 先頭の 2 件が選んだファンドの両版(`generateTemplates` の約束)。id は要求の綴りで
            // 置く(③ で見つけた綴り違いの作業は、この id の生成物で置き換える)。組入先も同じ会社
            // なので、会社は要求の綴りにそろえる。
            const currentFiles = await listTemplateFiles();
            const items: ImportItem[] = [];
            const skipped: GenerateSkipped[] = [];
            for (const [i, file] of generated.entries()) {
              const selected = i < editions.length;
              const attributes: SkeletonAttributes = selected
                ? editions[i].attributes
                : {
                    companyCode,
                    fundCode: file.attributes.fundCode,
                    editionType: file.attributes.editionType,
                  };
              const id = templateIdFromFileName(skeletonFileName(attributes));
              if (!selected) {
                // 組入先は `replaceExisting` の対象外。別のファンドから作られた作業を消さない。
                const reason = await skipReason(currentFiles, attributes, id);
                if (reason !== null) {
                  skipped.push({ templateId: id, reason });
                  continue;
                }
              }
              // 生成器の出力へ、承認済み注記マスタ(そのファンド・版種)を適用してから保存する。
              // 生成器(差し替え前提)にマスタ参照を要求しないための編集側適用点。DB 不達時は
              // 関数内で warn + 素通し(生成をブロックしない)。
              const html = await noteMaster.applyNoteMasterToHtml(
                file.html,
                attributes.fundCode,
                attributes.editionType,
              );
              // CSS の初期値: コピー元テンプレの CSS → 同じ名前の既存 CSS → 空(`readTemplateCss` は
              // 無ければ空)。コピー元は選んだファンドの版にだけ使う(組入先はコピー元から作らない)。
              const sourceId = selected ? sourceIds.get(attributes.editionType) : undefined;
              const css = await readTemplateCss(sourceId ?? id);
              items.push({ id, attributes, html, css, file, selected });
            }

            // REST モード: pending へ書く → 古い作業を消す → 作成記録の順。CSS は承認経路
            // (`applyConfirmedWrite`)の専権なので css/ へは書かず pending にだけ持つ。前回の下書きは
            // 生成器が成功したここで初めて捨てる(失敗したら作業を残す)。下書きが残ると、編集画面を
            // 開いたときに古い下書きが新しい生成物を覆う。コメント(notes/)とパーツ変更履歴は
            // 同じテンプレートの記録なので残す。確定側(templates/)は ① が守る。書いた後の段で
            // 失敗しても、書いた pending は正しい生成物なので残す。
            if (config.requireAuth) {
              // 綴り違いの古い pending も同じテンプレートの作業なので捨てる。ただし書く前に消す。
              // 大文字小文字を区別しないファイルシステムでは古い綴りと id の綴りが同じファイルなので、
              // 書いた後に消すと新しい生成物ごと消える。
              for (const [i, { id }] of editions.entries()) {
                for (const p of inProgress[i].pending) if (p !== id) await deletePending(p);
              }
              for (const item of items) await writePending(item.id, item.html, item.css);
              for (const [i, { id }] of editions.entries()) {
                for (const d of inProgress[i].drafts) await deleteDraft(d);
                await deleteDraft(id);
              }
              for (const item of items) {
                if (item.selected) {
                  await recordCreate(item.attributes, sourceFundCode, loginId);
                } else {
                  await recordCreate(item.attributes, undefined, loginId, fundCode);
                }
              }
            }
            // 無認証モードは pending を持たないが、生成器は約束どおり output/ へ書くので同じく消す。
            // 取り込まなかった組入先は、運用者が後から確かめられるよう残す。
            await removeGeneratedFiles(items.map((item) => item.file));

            // 選んだファンドの両版は必ず取り込むので、`items` の先頭は版の順に並ぶ。
            const opened =
              items[editions.findIndex((e) => e.attributes.editionType === openEdition)];
            // 生成直後のスケルトンは静的な記入済み(filled)を持たない。エディタ側で描画する。
            const template: Template = {
              meta: {
                id: opened.id,
                attributes: opened.attributes,
                fileName: skeletonFileName(opened.attributes),
                status: 'draft',
                updatedAt: null,
                updatedBy: null,
              },
              html: opened.html,
              css: opened.css,
              filled: '',
            };
            return { template, importedIds: items.map((item) => item.id), skipped };
          });
        },
        {
          success: (r) => ({
            resource: {
              companyCode: body.companyCode,
              fundCode: body.fundCode,
              importedIds: r.importedIds,
            },
          }),
          failure: () => ({
            resource: {
              companyCode: body.companyCode,
              fundCode: body.fundCode,
              editionType: body.editionType,
            },
          }),
          failureMessage: 'generation failed',
        },
      );
      return result;
    },
  );
};
