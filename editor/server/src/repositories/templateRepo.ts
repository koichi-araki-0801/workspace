/**
 * Template aggregate — server (REST) implementation backed by the gateway sproc
 * + on-disk bodies. Functions throw {@link AppError} on failure; route handlers
 * let the central errorHandler translate to HTTP. (The Result-returning
 * Repository contract is satisfied by the web `rest` layer; here we throw.)
 */
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

/** Attribute params shared by 候補 / 一覧 (null when unset). */
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
  // No static filled copy is persisted server-side; the editor re-fills at load time.
  return { meta, html, css, filled: '' };
}

/** Attribute params derived from a template id (filename convention). */
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

  // 1) freeze snapshot bytes, then write the confirmed files (after backing up
  //    the current bytes so a DB failure can be rolled back).
  await writeSnapshot(historyId, req.html, req.css);
  const prev = await snapshotCurrent(fileName, req.fundCode);
  await writeTemplateAndCss(fileName, req.html, req.fundCode, req.css);

  // 2) commit the DB transaction; on failure restore the previous file bytes.
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

/** Register a freshly generated template into the 台帳 (status=draft). */
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
