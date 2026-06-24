// =============================================================================
// templateRepo.ts — テンプレート集約のサーバ(REST)実装
// =============================================================================
// ゲートウェイ sproc とディスク上の本体を裏付けとする。各関数は失敗時に `AppError` を
// throw し、ルートハンドラは中央の `errorHandler` に HTTP への変換を委ねる
// (Result を返す Repository 契約は web の `rest` 層が満たす。ここでは throw する)。
import {
  buildSampleData,
  type DropdownOptions,
  type DropdownQuery,
  type FundMaster,
  notFound,
  parseTemplateFileName,
  type SampleData,
  type Template,
  type TemplateAttributes,
  type TemplateDraft,
  type TemplateMeta,
  type TemplateStatus,
  templateFileName,
  templateIdFromFileName,
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
import {
  deleteDraft,
  draftExists,
  draftMtime,
  readDraft,
  writeDraft,
} from '../files/draftFiles.js';
import {
  listTemplateFiles,
  readFundCss,
  readTemplateHtml,
  restoreTemplateAndCss,
  snapshotCurrent,
  templateExists,
  templateMtime,
  writeTemplateAndCss,
} from '../files/templateFiles.js';
import { commitAll, ensureRepo, withGitLock } from '../git/gitRepo.js';

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

/** ファイル名 + 更新時刻から `TemplateMeta` を組む(台帳は引かない)。 */
async function fileToMeta(fileName: string): Promise<TemplateMeta | null> {
  const attrs = parseTemplateFileName(fileName);
  if (!attrs) return null;
  return {
    id: templateIdFromFileName(fileName),
    attributes: attrs,
    fileName,
    // 確定状態は今後 git コミット有無で表す(phase 3)。本体ファイルが在る分は published 扱い。
    status: 'published',
    updatedAt: await templateMtime(fileName),
    updatedBy: null,
  };
}

/** dropdown query の設定済み全フィールドにメタが一致するか。 */
function metaMatches(m: TemplateMeta, q: DropdownQuery): boolean {
  return (
    (!q.companyCode || m.attributes.companyCode === q.companyCode) &&
    (!q.fundCode || m.attributes.fundCode === q.fundCode) &&
    (!q.baseDate || m.attributes.baseDate === q.baseDate) &&
    (!q.editionType || m.attributes.editionType === q.editionType)
  );
}

/** 既存テンプレの一覧は台帳でなく `data/templates` のファイル走査から導く。 */
export async function listTemplates(q: DropdownQuery): Promise<TemplateMeta[]> {
  const files = await listTemplateFiles();
  const metas = (await Promise.all(files.map(fileToMeta))).filter(
    (m): m is TemplateMeta => m !== null,
  );
  return metas
    .filter((m) => metaMatches(m, q))
    .sort((a, b) => a.fileName.localeCompare(b.fileName));
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

/** 1 件取得。メタはファイル名規約、本体はファイル(台帳は引かない)。 */
export async function getTemplate(id: string): Promise<Template> {
  const fileName = `${id}.html`;
  const meta = await fileToMeta(fileName);
  if (!meta || !(await templateExists(fileName)))
    throw notFound(`テンプレートが見つかりません: ${id}`);
  const html = await readTemplateHtml(fileName);
  const css = await readFundCss(meta.attributes.fundCode);
  // 記入済みの静的コピーはサーバ側に保持しない。エディタが読み込み時に再差込する。
  return { meta, html, css, filled: '' };
}

/** 自動保存ドラフトはファイルのみ(`data/drafts`、git 管理外)。台帳は引かない。 */
export async function saveDraft(
  templateId: string,
  html: string,
  css: string,
  _loginId: string,
): Promise<void> {
  await writeDraft(templateId, html, css);
}

export async function getDraft(templateId: string): Promise<TemplateDraft | null> {
  if (!(await draftExists(templateId))) return null;
  const { html, css } = await readDraft(`${templateId}.html`, `${templateId}.css`);
  // 保存者はファイルからは判らない(下書きは作業コピー)。保存日時は mtime で代用。
  return { templateId, html, css, savedAt: (await draftMtime(templateId)) ?? '', savedBy: '' };
}

/** 確定保存せずメニューへ戻った際に、未確定の下書き作業コピーを破棄する。 */
export async function discardDraft(templateId: string): Promise<void> {
  await deleteDraft(templateId);
}

/**
 * 確定保存。テンプレ本体 + ファンド CSS をファイルへ書き、git に 1 コミット積む
 * (版管理の正典)。台帳の状態更新・スナップショット・DB の編集履歴は廃止。
 * ファイル書込失敗時は直前バイト列へ復元。git コミット失敗はベストエフォート
 * (確定ファイルは残し、次回保存か手動コミットで取り込む)。
 */
export async function confirmSave(req: {
  templateId: string;
  html: string;
  css: string;
  fundCode: string;
  loginId: string;
}): Promise<TemplateMeta> {
  const attrs = parseTemplateFileName(`${req.templateId}.html`);
  const fileName = attrs ? templateFileName(attrs) : `${req.templateId}.html`;

  await ensureRepo();
  // ロールバック用に現在のバイト列を控えてから上書きする。
  const prev = await snapshotCurrent(fileName, req.fundCode);
  try {
    await writeTemplateAndCss(fileName, req.html, req.fundCode, req.css);
  } catch (e) {
    await restoreTemplateAndCss(fileName, req.fundCode, prev).catch(() => {});
    throw e;
  }

  try {
    await withGitLock(() =>
      commitAll(`確定保存: ${req.templateId} by ${req.loginId}`, { name: req.loginId }),
    );
  } catch (e) {
    // コミット失敗(稀: ロック/ディスク)はベストエフォート。確定ファイルは作業ツリー
    // に残し、台帳に「未コミット版」が残る形にする(次回保存/手動コミットで回収)。
    console.warn(`git コミットに失敗しました(確定ファイルは保存済み): ${String(e)}`);
  }

  const meta = await fileToMeta(fileName);
  if (!meta) throw notFound(`テンプレートが見つかりません: ${req.templateId}`);
  return meta;
}

/** サンプルデータ台帳 JSON からファンド固有マスタ(名称/会社)を取り出す。 */
function parseFundMaster(json: string | null): FundMaster | undefined {
  if (!json) return undefined;
  try {
    const o = JSON.parse(json) as {
      fund?: { name?: string; nickname?: string };
      company?: { code?: string; name?: string };
    };
    if (o.fund?.name && o.company?.code && o.company?.name) {
      return {
        name: o.fund.name,
        nickname: o.fund.nickname ?? '',
        company: { code: o.company.code, name: o.company.name },
      };
    }
  } catch {
    /* 壊れた JSON は master 無し扱い */
  }
  return undefined;
}

/**
 * プレビュー文脈のサンプルデータ。本体はパーツ別共通ダミー(`sampleCommon`)で、
 * DB の台帳からはファンド固有の名称/会社だけを解決して被せる。版種(ファイル名由来)は
 * テンプレを開く web 側(`applyEdition`)で上書きする。
 */
export async function getSampleData(fundCode: string): Promise<SampleData> {
  const row = firstRow(await callSproc(SP.sample, '取得', [p('ファンドコード', fundCode)]));
  const master = parseFundMaster(row ? asStringOrNull(row.データJSON) : null);
  return buildSampleData(master, fundCode);
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
