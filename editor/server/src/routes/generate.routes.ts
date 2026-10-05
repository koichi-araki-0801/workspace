// =============================================================================
// generate.routes.ts — 既存 Python ツールで新規テンプレートを生成
// =============================================================================
// REST モードでは生成結果を**未確定(pending)領域**へ置き、作成履歴フィードへ記録する。
// Python ステップ自体は変更しない。
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
  type SkeletonAttributes,
  skeletonFileName,
  type TemplateMeta,
  templateIdFromFileName,
  validation,
} from '@editor/shared';
import type { FastifyPluginAsync } from 'fastify';
import type { z } from 'zod';
import { config } from '../config.js';
import type { Deps } from '../deps.js';
import { deleteDraft } from '../files/draftFiles.js';
import { findInProgressIds } from '../files/inProgress.js';
import { deletePending, writePending } from '../files/pendingFiles.js';
import { hasPendingCreateReview } from '../files/reviewFiles.js';
import {
  findTemplateId,
  hasTemplateFor,
  listTemplateFiles,
  readTemplateCss,
} from '../files/templateFiles.js';
import { generateTemplate } from '../generate/pyTemplate.js';
import { auditedRethrow } from '../logger.js';
import { requireAuth, requireEditor } from '../middleware/auth.js';
import { validate } from '../middleware/validate.js';
import { GenerateRequest } from '../openapi/schemas.js';
import { recordCreate } from '../repositories/historyRepo.js';

// トークン単位の検査はここに私有の複製を置かず `@editor/shared` の
// `assertTemplateAttributeToken` 1 本を呼ぶ。同じ判定を呼び出し元ごとの私有複製で持つと、
// 「生成は締まっているのに確定書込(`confirmedWrite.ts`)は緩い」のような非対称ができる。

export const generateRoutes: FastifyPluginAsync<{
  deps: Pick<Deps, 'noteMaster'>;
}> = async (app, opts) => {
  const { noteMaster } = opts.deps;

  app.post<{ Body: z.infer<typeof GenerateRequest> }>(
    apiPaths.generate,
    { preHandler: [requireAuth, requireEditor, validate(GenerateRequest)] },
    async (request) => {
      const body = request.body;
      const loginId = request.user?.username ?? 'system';
      const { meta, html, css } = await auditedRethrow(
        request,
        'template.generate',
        async () => {
          // テンプレートは会社・ファンド・版種に 1 つで、基準日を持たない(基準日で使い回さない)。
          const attributes: SkeletonAttributes = {
            companyCode: assertTemplateAttributeToken('会社コード', body.companyCode),
            fundCode: assertTemplateAttributeToken('ファンドコード', body.fundCode),
            editionType: assertTemplateAttributeToken('版種', body.editionType),
          };
          // コピー元も属性と同じくここで検査する。検査済みの値だけを生成器と作成履歴へ渡す。
          const sourceFundCode = body.sourceFundCode
            ? assertTemplateAttributeToken('コピー元ファンドコード', body.sourceFundCode)
            : undefined;
          // 画面はコピー元テンプレートが無い候補で作成を止めるが、API を直接呼ばれても同じ結果にする。
          if (
            sourceFundCode &&
            !(await hasTemplateFor(attributes.companyCode, sourceFundCode, attributes.editionType))
          ) {
            throw validation(`コピー元のテンプレートがありません: ${sourceFundCode}`);
          }
          const fileName = skeletonFileName(attributes);
          const id = templateIdFromFileName(fileName);

          // ① 作成済みなら生成では触らない。直すときは作成タブで既存のテンプレートを開き、申請 → 承認で
          // templates/ を上書きする。照合は作成タブの「作成済み」と同じく大文字小文字を区別しない。
          const existing = findTemplateId(
            await listTemplateFiles(),
            attributes.companyCode,
            attributes.fundCode,
            attributes.editionType,
          );
          if (existing !== null) {
            throw conflict('作成済みです。既存のテンプレートを開いてください');
          }
          // ② 承認待ちの作成申請があるうちに作り直すと、承認でその申請の内容が templates/ に入り、
          // 作り直した生成物と食い違う。
          if (await hasPendingCreateReview(id)) {
            throw conflict('申請中です。承認か却下を待ってください');
          }
          // ③ 作業中(下書きか pending)を黙って捨てない。画面は確認ダイアログで同意を得て送り直す。
          // 綴り違い(会社コードの大文字小文字)も同じテンプレートとして数える(① ② と同じ規則)。
          const inProgress = await findInProgressIds(id);
          if (
            body.replaceExisting !== true &&
            (inProgress.drafts.length > 0 || inProgress.pending.length > 0)
          ) {
            throw conflict('作成中のテンプレートがあります');
          }

          // ④ 生成器の出力へ、承認済み注記マスタ(そのファンド・版種)を適用してから保存する。
          // 生成器(差し替え前提)にマスタ参照を要求しないための編集側適用点。DB 不達時は
          // 関数内で warn + 素通し(生成をブロックしない)。
          const html = await noteMaster.applyNoteMasterToHtml(
            // 生成器へはリクエスト本文を渡さず、検証済みの属性だけを明示して組む
            // (本文の他のキーが共有上のコードへ流れないようにする)。
            await generateTemplate({
              companyCode: attributes.companyCode,
              fundCode: attributes.fundCode,
              editionType: attributes.editionType,
              ...(sourceFundCode === undefined ? {} : { sourceFundCode }),
              ...(body.isRedemption === true ? { isRedemption: true } : {}),
            }),
            attributes.fundCode,
            attributes.editionType,
          );
          // CSS の初期値: コピー元テンプレの CSS → 同じ名前の既存 CSS → 空(`readTemplateCss` は無ければ空)。
          // コピー元の有無は上で検査済み(大文字小文字を区別しない照合も `hasTemplateFor` と同じ)。
          const sourceId = sourceFundCode
            ? findTemplateId(
                await listTemplateFiles(),
                attributes.companyCode,
                sourceFundCode,
                attributes.editionType,
              )
            : null;
          const css = await readTemplateCss(sourceId ?? id);
          const meta: TemplateMeta = {
            id,
            attributes,
            fileName,
            status: 'draft',
            updatedAt: null,
            updatedBy: null,
          };

          // REST モード: 生成器が書いた pending/<id>.html を、注記マスタを適用した HTML と CSS で
          // 書き直し → 作成記録の順。CSS は同じテンプレの基準日違いで共有するので pending にしか
          // 書かない — css/ の書き換えは承認経路(`applyConfirmedWrite`)の専権である。前回の
          // 下書きは、生成器が成功したここで初めて捨てる(失敗したら作業を残す。前の pending/ は
          // 生成器の約束で残る)。下書きが残ると、編集画面を開いたときに古い下書きが新しい生成物を
          // 覆う。コメント(notes/)とパーツ変更履歴は同じテンプレートの記録なので残す。確定側
          // (templates/)は ① が守る。
          if (config.requireAuth) {
            await writePending(id, html, css);
            // 綴り違いの古い下書き・pending も同じテンプレートの作業なので捨てる(生成物は id の綴りで置く)。
            for (const d of inProgress.drafts) await deleteDraft(d);
            await deleteDraft(id);
            for (const p of inProgress.pending) if (p !== id) await deletePending(p);
            await recordCreate(attributes, sourceFundCode, loginId);
          } else {
            // local モードは pending を持たない。生成器は約束どおり書くので、読み終えたここで消す。
            await deletePending(id);
          }

          return { meta, html, css, id, attributes };
        },
        {
          success: (r) => ({ resource: { id: r.id, ...r.attributes } }),
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
      // 生成直後のスケルトンは静的な記入済み(filled)を持たない。エディタ側で描画する。
      return { template: { meta, html, css, filled: '' } };
    },
  );
};
