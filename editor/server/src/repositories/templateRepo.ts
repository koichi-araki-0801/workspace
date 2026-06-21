// =============================================================================
// templateRepo.ts — テンプレート集約のサーバ(REST)実装
// =============================================================================
// ゲートウェイ sproc とディスク上の本体を裏付けとする。各関数は失敗時に `AppError` を
// throw し、ルートハンドラは中央の `errorHandler` に HTTP への変換を委ねる
// (Result を返す Repository 契約は web の `rest` 層が満たす。ここでは throw する)。
import { randomUUID } from 'node:crypto';
import {
  type DropdownOptions,
  type DropdownQuery,
  notFound,
  parseTemplateFileName,
  type SampleData,
  type Template,
  type TemplateAttributes,
  type TemplateDraft,
  type TemplateMeta,
  type TemplateStatus,
  templateFileName,
} from '@editor/shared';
import {
  asIso,
  asString,
  asStringOrNull,
  callSproc,
  firstRow,
  type Param,
  p,
} from '../db/sproc.js';
import { SP } from '../db/sprocNames.js';
import { readDraft, writeDraft } from '../files/draftFiles.js';
import { writeSnapshot } from '../files/snapshotFiles.js';
import {
  readFundCss,
  readTemplateHtml,
  restoreTemplateAndCss,
  snapshotCurrent,
  writeTemplateAndCss,
} from '../files/templateFiles.js';

function rowToMeta(r: Record<string, unknown>): TemplateMeta {
  return {
    id: asString(r.テンプレートID),
    attributes: {
      companyCode: asString(r.委託会社コード),
      fundCode: asString(r.ファンドコード),
      baseDate: asString(r.基準日),
      editionType: asString(r.版種),
    },
    fileName: asString(r.ファイル名),
    status: asString(r.状態) as TemplateStatus,
    updatedAt: asIso(r.更新日時),
    updatedBy: asStringOrNull(r.更新者),
  };
}

/** `候補` / `一覧` で共有する属性パラメータ(未設定時は null)。 */
function queryParams(q: DropdownQuery): Param[] {
  return [
    p('委託会社コード', q.companyCode),
    p('ファンドコード', q.fundCode),
    p('基準日', q.baseDate),
    p('版種', q.editionType),
  ];
}

export async function getDropdownOptions(q: DropdownQuery): Promise<DropdownOptions> {
  const rows = await callSproc(SP.template, '候補', queryParams(q));
  const pick = (kbn: string) =>
    rows.filter((r) => asString(r.区分) === kbn).map((r) => asString(r.値));
  return {
    companyCodes: pick('会社'),
    fundCodes: pick('ファンド'),
    baseDates: pick('基準日'),
    editionTypes: pick('版種'),
  };
}

export async function listTemplates(q: DropdownQuery): Promise<TemplateMeta[]> {
  const rows = await callSproc(SP.template, '一覧', queryParams(q));
  return rows.map(rowToMeta);
}

export async function listSeriesFunds(
  companyCode: string,
  editionType: string,
): Promise<TemplateMeta[]> {
  const rows = await callSproc(SP.template, '系列', [
    p('委託会社コード', companyCode),
    p('版種', editionType),
  ]);
  return rows.map(rowToMeta);
}

export async function getTemplate(id: string): Promise<Template> {
  const row = firstRow(await callSproc(SP.template, '取得', [p('テンプレートID', id)]));
  if (!row) throw notFound(`テンプレートが見つかりません: ${id}`);
  const meta = rowToMeta(row);
  const html = await readTemplateHtml(meta.fileName);
  const css = await readFundCss(meta.attributes.fundCode);
  // 記入済みの静的コピーはサーバ側に保持しない。エディタが読み込み時に再差込する。
  return { meta, html, css, filled: '' };
}

/** テンプレート id(ファイル名規約)から導出する属性パラメータ。 */
function attrParams(id: string): Param[] {
  const attrs = parseTemplateFileName(`${id}.html`);
  if (!attrs) return [p('ファイル名', `${id}.html`)];
  return [
    p('委託会社コード', attrs.companyCode),
    p('ファンドコード', attrs.fundCode),
    p('基準日', attrs.baseDate),
    p('版種', attrs.editionType),
    p('ファイル名', templateFileName(attrs)),
  ];
}

export async function saveDraft(
  templateId: string,
  html: string,
  css: string,
  loginId: string,
): Promise<void> {
  const refs = await writeDraft(templateId, html, css);
  await callSproc(SP.template, '下書き保存', [
    p('テンプレートID', templateId),
    p('ログインID', loginId),
    p('下書きHTMLファイル', refs.htmlFile),
    p('下書きCSSファイル', refs.cssFile),
    ...attrParams(templateId),
  ]);
}

export async function getDraft(templateId: string): Promise<TemplateDraft | null> {
  const row = firstRow(
    await callSproc(SP.template, '下書き取得', [p('テンプレートID', templateId)]),
  );
  if (!row) return null;
  const { html, css } = await readDraft(
    asStringOrNull(row.下書きHTMLファイル),
    asStringOrNull(row.下書きCSSファイル),
  );
  return {
    templateId,
    html,
    css,
    savedAt: asIso(row.下書き保存日時) ?? '',
    savedBy: asString(row.下書き保存者),
  };
}

export async function confirmSave(req: {
  templateId: string;
  html: string;
  css: string;
  fundCode: string;
  loginId: string;
}): Promise<TemplateMeta> {
  const attrs = parseTemplateFileName(`${req.templateId}.html`);
  const fileName = attrs ? templateFileName(attrs) : `${req.templateId}.html`;
  const historyId = `eh-${randomUUID()}`;

  // 1) スナップショットのバイト列を凍結し、確定ファイルを書き込む(DB 失敗時に
  //    ロールバックできるよう現在のバイト列をバックアップしてから書く)。
  await writeSnapshot(historyId, req.html, req.css);
  const prev = await snapshotCurrent(fileName, req.fundCode);
  await writeTemplateAndCss(fileName, req.html, req.fundCode, req.css);

  // 2) DB トランザクションをコミットする。失敗時は直前のファイルバイト列を復元する。
  try {
    const row = firstRow(
      await callSproc(SP.template, '確定保存', [
        p('テンプレートID', req.templateId),
        p('ファンドコード', req.fundCode),
        p('ログインID', req.loginId),
        p('公開ID', historyId),
        p('概要', '確定保存'),
        p('スナップHTMLファイル', `${historyId}.html`),
        p('スナップCSSファイル', `${historyId}.css`),
        ...attrParams(req.templateId),
      ]),
    );
    if (!row) throw notFound(`テンプレートが見つかりません: ${req.templateId}`);
    return rowToMeta(row);
  } catch (e) {
    await restoreTemplateAndCss(fileName, req.fundCode, prev).catch(() => {});
    throw e;
  }
}

export async function getSampleData(fundCode: string): Promise<SampleData> {
  const row = firstRow(await callSproc(SP.sample, '取得', [p('ファンドコード', fundCode)]));
  const json = row ? asStringOrNull(row.データJSON) : null;
  if (!json) return {};
  try {
    return JSON.parse(json) as SampleData;
  } catch {
    return {};
  }
}

/** 新規生成したテンプレートを `台帳` に登録する(status=draft)。 */
export async function registerGenerated(attributes: TemplateAttributes, id: string): Promise<void> {
  await callSproc(SP.template, '生成登録', [
    p('テンプレートID', id),
    p('委託会社コード', attributes.companyCode),
    p('ファンドコード', attributes.fundCode),
    p('基準日', attributes.baseDate),
    p('版種', attributes.editionType),
    p('ファイル名', templateFileName(attributes)),
  ]);
}
