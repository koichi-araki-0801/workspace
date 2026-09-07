// =============================================================================
// generate.routes.ts — 既存 Python ツールで新規テンプレートを生成
// =============================================================================
// REST モードでは生成結果を**未確定(pending)領域**へ置き、台帳へ登録(status=draft)、作成
// 履歴フィードへ記録する。Python ステップ自体は変更しない。
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
  type TemplateAttributes,
  type TemplateMeta,
  templateFileName,
  templateIdFromFileName,
} from '@editor/shared';
import type { FastifyPluginAsync } from 'fastify';
import type { z } from 'zod';
import { config } from '../config.js';
import type { Deps } from '../deps.js';
import { pendingExists, writePending } from '../files/pendingFiles.js';
import { readFundCss, templateExists } from '../files/templateFiles.js';
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
  deps: Pick<Deps, 'templates' | 'noteMaster'>;
}> = async (app, opts) => {
  const { templates, noteMaster } = opts.deps;

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
          const attributes: TemplateAttributes = {
            companyCode: assertTemplateAttributeToken('会社コード', body.companyCode),
            fundCode: assertTemplateAttributeToken('ファンドコード', body.fundCode),
            baseDate: todayYmd(),
            editionType: assertTemplateAttributeToken('版種', body.editionType),
          };
          const fileName = templateFileName(attributes);
          const id = templateIdFromFileName(fileName);

          // 同一属性の確定テンプレが既にあるなら生成では触らない。存在検査なしに
          // 上書きすると、baseDate がサーバ現在日と一致する確定テンプレを黙って
          // 壊せてしまう。続きは編集タブ(承認フロー)から行う。
          if (await templateExists(fileName)) {
            throw conflict(
              `同じ属性のテンプレートが既にあります: ${id}。編集タブから開いてください`,
            );
          }

          // 生成器の出力へ、承認済み注記マスタ(そのファンド・版種)を適用してから保存する。
          // 生成器(差し替え前提)にマスタ参照を要求しないための編集側適用点。DB 不達時は
          // 関数内で warn + 素通し(生成をブロックしない)。
          const html = await noteMaster.applyNoteMasterToHtml(
            await generateTemplate(body),
            attributes.fundCode,
            attributes.editionType,
          );
          const css = await readFundCss(attributes.fundCode);
          const meta: TemplateMeta = {
            id,
            attributes,
            fileName,
            status: 'draft',
            updatedAt: null,
            updatedBy: null,
          };

          // REST モード: 台帳登録 → pending 実体 → 作成記録の順。**台帳が先**なのは
          // `UQ_台帳_属性4` 違反で弾かれたときに実体だけが残る(孤児)のを避けるため。
          // CSS はファンド共有ファイルなので pending にしか書かない — 共有 CSS の
          // 書き換えは承認経路(`applyConfirmedWrite`)の専権である。
          //
          // 同一属性の pending が既に在るなら台帳行も既に在る(前回の生成で登録済み)。
          // ここで再登録すると `UQ_台帳_属性4` に当たり、未承認テンプレの作り直しが
          // 永久に不能になる。pending は未確定の作業用実体なので上書きしてよい
          // (確定側は上の 409 が守る。承認ゲートは一切迂回していない)。
          if (config.requireAuth) {
            if (!(await pendingExists(id))) await templates.registerGenerated(attributes, id);
            await writePending(id, html, css);
            await recordCreate(attributes, body.basedOnTemplateId, loginId);
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

function todayYmd(): string {
  const d = new Date();
  return `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`;
}
