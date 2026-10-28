// =============================================================================
// generate.routes.ts — 既存 Python ツールで新規テンプレートを生成
// =============================================================================
// 1 回の作成で、作成画面のファンドの作る版(版種を選べばその版、選ばなければ作成済み・申請中で
// ない版)を取り込む。生成器は両版と組入先(マザーファンド・組入投信)を書くが、組入先は取り込まない。
// 流れは次の順。
//
// 1. 属性・Rep1 コード・コピー元を検査し、略称と Rep1 コードが Rep1 で同じ会社の組かを確かめる
//    (画面から食い違った組を送られても、他社のコードで生成させない)。基準日は常に最新基準日。
// 2. 会社ごとの排他の中で、残りをすべて行う。生成器の出力は同じ会社のファンドで重なりうるので、
//    排他が無いと、相手が書いている途中のファイルを読みうる。作成済み・申請中・作業中の判定も
//    この中で行い、判定と書き込みの間に同じテンプレートを別の作成が作らないようにする。
// 3. 候補の版ごとに、作成済み → 承認待ちの作成申請 → 作業中 → 無し の順で状態を決める。
//    版種を選んだときは、その版が作成済みか申請中なら 409。版種を選ばないときは、作成済み・
//    申請中の版を飛ばして `skipped` に載せ、両版とも当たれば 409(作成済みが 1 つでもあれば
//    「作成済み」、無ければ「申請中」)。作る版に作業中があれば、同意(replaceExisting)が無い限り 409。
// 4. 生成器を呼び、作る版だけを取り込む。版種を選んだときの同じファンドのもう片方の版の出力は
//    `output/` から消す。飛ばした版と組入先の出力は、運用者が確かめられるよう残す。
// 5. 取り込むものを全部メモリ上にそろえてから pending へ書き、作る版の古い作業を消し、作成記録を
//    残し、取り込んだファイル(と消す対象)を生成器の `output/` から消す。書く前の段で失敗すれば何も
//    変わらない。例外: 作る版にある古い綴りの pending だけは、書く前に消す(大文字小文字を区別しない
//    ファイルシステムで、書いた後に消すと新しい生成物が消えるため)。よって replaceExisting のとき、
//    書く前か書いている途中で失敗すると、その古い綴りの pending は失われる。
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
  type CreatableEdition,
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
import { latestBaseDate } from '../generate/baseDate.js';
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
}

/** 略称の比較キー。Rep1 の略称は固定長で末尾に空白が付きうる。 */
const companyKey = (code: string): string => code.trimEnd().toLowerCase();

type EditionState = 'created' | 'pendingReview' | 'inProgress' | 'none';

/**
 * 作成画面のファンドの 1 版の状態。優先は 作成済み > 申請中 > 作業中 > 無し(作成タブの
 * `getCreatableInfo` と同じ規則)。照合は大文字小文字を区別しない。`found` は作業中の綴りの一覧で、
 * 作り直しで古い作業を消すのに使う。
 */
async function editionState(
  templateFiles: string[],
  attrs: SkeletonAttributes,
  id: string,
): Promise<{ state: EditionState; found: Awaited<ReturnType<typeof findInProgressIds>> }> {
  const found = await findInProgressIds(id);
  if (findTemplateId(templateFiles, attrs.companyCode, attrs.fundCode, attrs.editionType)) {
    return { state: 'created', found };
  }
  if (await hasPendingCreateReview(id)) return { state: 'pendingReview', found };
  if (found.drafts.length > 0 || found.pending.length > 0) return { state: 'inProgress', found };
  return { state: 'none', found };
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
          // 版種は省ける(省けば作成済み・申請中でない版をすべて作る)。
          const requested =
            body.editionType === undefined
              ? undefined
              : assertTemplateAttributeToken('版種', body.editionType);
          if (
            requested !== undefined &&
            !(GENERATED_EDITIONS as readonly string[]).includes(requested)
          ) {
            throw validation(`版種は ${GENERATED_EDITIONS.join('・')} のどちらかです`);
          }
          // 基準日は常に最新基準日(画面からは選ばせない)。古い画面が送る baseDate は
          // スキーマの検証で落ちるので、ここへは届かない。
          const baseDate = latestBaseDate();
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
            const toEdition = (editionType: CreatableEdition) => {
              const attributes: SkeletonAttributes = { companyCode, fundCode, editionType };
              return { attributes, id: templateIdFromFileName(skeletonFileName(attributes)) };
            };
            const candidates = (
              requested === undefined
                ? [...GENERATED_EDITIONS]
                : GENERATED_EDITIONS.filter((e) => e === requested)
            ).map(toEdition);
            const templateFiles = await listTemplateFiles();

            // 画面はコピー元テンプレートが無い候補で作成を止めるが、API を直接呼ばれても同じ結果に
            // する。生成器はコピー元の両版を読むので、作る版に関係なくコピー元は両版そろっていること。
            // 照合は大文字小文字を区別しない(CSS の初期値にもこの id を使う)。
            const sourceIds = new Map<string, string>();
            if (sourceFundCode) {
              for (const editionType of GENERATED_EDITIONS) {
                const found = findTemplateId(
                  templateFiles,
                  companyCode,
                  sourceFundCode,
                  editionType,
                );
                if (found === null) {
                  throw validation(`コピー元のテンプレートがありません: ${sourceFundCode}`);
                }
                sourceIds.set(editionType, found);
              }
            }

            // 候補の版ごとの状態。作成済みは生成では触らない(直すときは作成タブで既存のテンプレートを
            // 開き、申請 → 承認で templates/ を上書きする)。承認待ちの作成申請があるうちに作り直すと、
            // 承認でその申請の内容が templates/ に入り、作り直した生成物と食い違う。
            const states = await Promise.all(
              candidates.map(async (c) => ({
                ...c,
                ...(await editionState(templateFiles, c.attributes, c.id)),
              })),
            );
            const isBlocked = (st: EditionState) => st === 'created' || st === 'pendingReview';
            const blocked = states.filter((st) => isBlocked(st.state));
            if (blocked.length === states.length) {
              throw conflict(
                blocked.some((st) => st.state === 'created')
                  ? '作成済みです。既存のテンプレートを開いてください'
                  : '申請中です。承認か却下を待ってください',
              );
            }
            const skipped: GenerateSkipped[] = blocked.map((st) => ({
              templateId: st.id,
              editionType: st.attributes.editionType,
              reason: st.state === 'created' ? 'created' : 'pendingReview',
            }));
            const targets = states.filter((st) => !isBlocked(st.state));
            // 作業中(下書きか pending)を黙って捨てない。画面は確認ダイアログで同意を得て送り直す。
            // 綴り違い(会社コードの大文字小文字)も同じテンプレートとして数える。
            if (body.replaceExisting !== true && targets.some((st) => st.state === 'inProgress')) {
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
              targets.map((st) => st.attributes.editionType as CreatableEdition),
            );

            // 先頭の `targets.length` 件が作る版(`generateTemplates` の約束で、版の順も同じ)。id は
            // 要求の綴りで置く(見つけた綴り違いの作業は、この id の生成物で置き換える)。
            const items: ImportItem[] = [];
            for (const [i, st] of targets.entries()) {
              const file = generated[i];
              // 生成器の出力へ、承認済み注記マスタ(そのファンド・版種)を適用してから保存する。
              // 生成器(差し替え前提)にマスタ参照を要求しないための編集側適用点。DB 不達時は
              // 関数内で warn + 素通し(生成をブロックしない)。
              const html = await noteMaster.applyNoteMasterToHtml(
                file.html,
                st.attributes.fundCode,
                st.attributes.editionType,
              );
              // CSS の初期値: コピー元テンプレの CSS → 同じ名前の既存 CSS → 空(`readTemplateCss` は
              // 無ければ空)。
              const css = await readTemplateCss(sourceIds.get(st.attributes.editionType) ?? st.id);
              items.push({ id: st.id, attributes: st.attributes, html, css, file });
            }
            // 版種を選んだときの同じファンドのもう片方の版は、要らない出力なので消す。飛ばした版と
            // 組入先の出力は、運用者が確かめられるよう残す。
            const discard =
              requested === undefined
                ? []
                : generated.slice(targets.length).filter((f) => f.attributes.fundCode === fundCode);

            // pending へ書く → 古い作業を消す → 作成記録の順。CSS は承認経路
            // (`applyConfirmedWrite`)の専権なので css/ へは書かず pending にだけ持つ。前回の下書きは
            // 生成器が成功したここで初めて捨てる(失敗したら作業を残す)。下書きが残ると、編集画面を
            // 開いたときに古い下書きが新しい生成物を覆う。コメント(notes/)とパーツ変更履歴は
            // 同じテンプレートの記録なので残す。作らない版の作業には触らない。書いた後の段で
            // 失敗しても、書いた pending は正しい生成物なので残す。
            if (config.requireAuth) {
              // 綴り違いの古い pending も同じテンプレートの作業なので捨てる。ただし書く前に消す。
              // 大文字小文字を区別しないファイルシステムでは古い綴りと id の綴りが同じファイルなので、
              // 書いた後に消すと新しい生成物ごと消える。
              for (const st of targets) {
                for (const p of st.found.pending) if (p !== st.id) await deletePending(p);
              }
              for (const item of items) await writePending(item.id, item.html, item.css);
              for (const st of targets) {
                for (const d of st.found.drafts) await deleteDraft(d);
                await deleteDraft(st.id);
              }
              for (const item of items)
                await recordCreate(item.attributes, sourceFundCode, loginId);
            }
            // 無認証モードは pending を持たないが、生成器は約束どおり output/ へ書くので同じく消す。
            await removeGeneratedFiles([...items.map((item) => item.file), ...discard]);

            const imported = items.map((item) => ({
              templateId: item.id,
              editionType: item.attributes.editionType,
            }));
            // 取り込んだ版が 1 つならそれを開く。両版なら画面がどちらを開くかを選ばせる。
            if (items.length !== 1) return { imported, skipped };
            const [opened] = items;
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
            return { template, imported, skipped };
          });
        },
        {
          success: (r) => ({
            resource: {
              companyCode: body.companyCode,
              fundCode: body.fundCode,
              // 監査ログの互換のため名前は importedIds のまま残す。
              importedIds: r.imported.map((i) => i.templateId),
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
