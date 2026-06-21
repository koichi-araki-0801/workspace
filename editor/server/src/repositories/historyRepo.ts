// =============================================================================
// historyRepo.ts — 履歴集約のサーバ(REST)実装
// =============================================================================
// 4 つのフィード + バージョン + スナップショットはいずれも統合 `履歴` テーブル
// (`種別` 判別子)を読み、サーバが各 `種別` の行形状を DTO へ写像する。
// スナップショット本体はディスクから読む。
import { randomUUID } from 'node:crypto';
import {
  type CreateHistoryEntry,
  type EditHistoryEntry,
  notFound,
  type PartHistoryEntry,
  type PdfHistoryEntry,
  type TemplateAttributes,
  type TemplateSnapshot,
  type TemplateVersionMeta,
} from '@editor/shared';
import { asIso, asString, callSproc, firstRow, p } from '../db/sproc.js';
import { SP } from '../db/sprocNames.js';
import { readSnapshot } from '../files/snapshotFiles.js';

const ts = (r: Record<string, unknown>) => asIso(r.発生日時) ?? '';
const who = (r: Record<string, unknown>) => asString(r.表示名);

export async function getEditHistory(): Promise<EditHistoryEntry[]> {
  const rows = await callSproc(SP.history, '一覧', [p('種別', 'edit')]);
  return rows.map((r) => ({
    id: asString(r.公開ID),
    templateId: asString(r.テンプレートID),
    user: who(r),
    timestamp: ts(r),
    summary: asString(r.概要),
  }));
}

export async function getPdfHistory(): Promise<PdfHistoryEntry[]> {
  const rows = await callSproc(SP.history, '一覧', [p('種別', 'pdf')]);
  return rows.map((r) => ({
    id: asString(r.公開ID),
    templateId: asString(r.テンプレートID),
    user: who(r),
    timestamp: ts(r),
  }));
}

export async function getCreateHistory(): Promise<CreateHistoryEntry[]> {
  const rows = await callSproc(SP.history, '一覧', [p('種別', 'create')]);
  return rows.map((r) => ({
    id: asString(r.公開ID),
    attributes: {
      companyCode: asString(r.委託会社コード),
      fundCode: asString(r.作成ファンドコード),
      baseDate: asString(r.基準日),
      editionType: asString(r.版種),
    },
    user: who(r),
    timestamp: ts(r),
    basedOnTemplateId: (r.元テンプレートID as string | null) ?? undefined,
  }));
}

export async function recordPdfExport(templateId: string, loginId: string): Promise<void> {
  await callSproc(SP.history, '登録', [
    p('種別', 'pdf'),
    p('公開ID', `ph-${randomUUID()}`),
    p('テンプレートID', templateId),
    p('ログインID', loginId),
  ]);
}

export async function recordPartChange(
  templateId: string,
  partId: string,
  change: string,
  loginId: string,
): Promise<void> {
  await callSproc(SP.history, '登録', [
    p('種別', 'part'),
    p('公開ID', `ph-${randomUUID()}`),
    p('テンプレートID', templateId),
    p('ログインID', loginId),
    p('パーツID', partId),
    p('変更内容', change),
  ]);
}

export async function recordCreate(
  attributes: TemplateAttributes,
  basedOnTemplateId: string | undefined,
  loginId: string,
): Promise<void> {
  await callSproc(SP.history, '登録', [
    p('種別', 'create'),
    p('公開ID', `ch-${randomUUID()}`),
    p('ログインID', loginId),
    p('委託会社コード', attributes.companyCode),
    p('作成ファンドコード', attributes.fundCode),
    p('基準日', attributes.baseDate),
    p('版種', attributes.editionType),
    p('元テンプレートID', basedOnTemplateId),
  ]);
}

export async function listVersions(templateId: string): Promise<TemplateVersionMeta[]> {
  const rows = await callSproc(SP.history, 'バージョン一覧', [p('テンプレートID', templateId)]);
  return rows.map((r) => ({
    historyId: asString(r.公開ID),
    templateId: asString(r.テンプレートID),
    timestamp: ts(r),
    user: who(r),
    summary: asString(r.概要),
  }));
}

export async function getSnapshot(historyId: string): Promise<TemplateSnapshot> {
  const row = firstRow(await callSproc(SP.history, 'スナップ取得', [p('公開ID', historyId)]));
  if (!row) throw notFound(`この版の比較データがありません: ${historyId}`);
  const { html, css } = await readSnapshot(
    (row.スナップHTMLファイル as string | null) ?? null,
    (row.スナップCSSファイル as string | null) ?? null,
  );
  return {
    historyId: asString(row.公開ID),
    templateId: asString(row.テンプレートID),
    html,
    css,
    fundCode: asString(row.ファンドコード),
    timestamp: ts(row),
  };
}

export async function getPartHistory(
  templateId: string,
  partId: string,
): Promise<PartHistoryEntry[]> {
  const rows = await callSproc(SP.history, 'パーツ履歴', [
    p('テンプレートID', templateId),
    p('パーツID', partId),
  ]);
  return rows.map((r) => ({
    id: asString(r.公開ID),
    templateId: asString(r.テンプレートID),
    partId: asString(r.パーツID),
    user: who(r),
    timestamp: ts(r),
    change: asString(r.変更内容),
  }));
}
