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
import {
  deleteDraft,
  draftExists,
  draftMtime,
  readDraft,
  writeDraft,
} from '../files/draftFiles.js';
import { listPendingIds, pendingMtime, readPending } from '../files/pendingFiles.js';
import {
  listTemplateFiles,
  readFundCss,
  readTemplateHtml,
  templateExists,
} from '../files/templateFiles.js';
import { applyConfirmedWrite } from './confirmedWrite.js';
import { fileToMeta } from './templateMeta.js';

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

/** dropdown query の設定済み全フィールドにメタが一致するか。 */
function metaMatches(m: TemplateMeta, q: DropdownQuery): boolean {
  return (
    (!q.companyCode || m.attributes.companyCode === q.companyCode) &&
    (!q.fundCode || m.attributes.fundCode === q.fundCode) &&
    (!q.baseDate || m.attributes.baseDate === q.baseDate) &&
    (!q.editionType || m.attributes.editionType === q.editionType)
  );
}

/**
 * 既存テンプレの一覧は台帳でなく `data/templates`(確定)と `data/pending`(生成直後の
 * 未確定実体)のファイル走査から導く。**pending も混ぜ、`status` で区別する。**
 *
 * 混ぜない設計は一度採ったが不成立だった: 作成タブは生成後に `/edit/:id` へ 1 回遷移する
 * だけで、履歴タブは遷移経路を持たない。そのため一覧から外すと、生成直後にブラウザを
 * 閉じた時点でその id へ到達する手段が UI から消え、同一属性の再生成も台帳の
 * `UQ_台帳_属性4` に当たって復旧できない(= 作ったテンプレが行方不明になる)。
 *
 * 未承認の内容を扱ってはいけない画面(比較タブ・結合 PDF)は**呼び出し側**で
 * `status === 'published'` に絞る。一覧側で落とすと上記の到達不能が再発する。
 */
export async function listTemplates(q: DropdownQuery): Promise<TemplateMeta[]> {
  const files = await listTemplateFiles();
  const confirmed = (await Promise.all(files.map(fileToMeta))).filter(
    (m): m is TemplateMeta => m !== null,
  );
  const confirmedIds = new Set(confirmed.map((m) => m.id));
  // 承認で確定へ昇格した後も pending が消し残る場合がある(削除はベストエフォート)。
  // 同一 id が両方に在るときは確定を採る — 一覧が二重に出るのを防ぐ。
  const pendingIds = (await listPendingIds()).filter((id) => !confirmedIds.has(id));
  const pending = (
    await Promise.all(
      pendingIds.map(async (id): Promise<TemplateMeta | null> => {
        const meta = await fileToMeta(`${id}.html`);
        return meta && { ...meta, status: 'draft', updatedAt: await pendingMtime(id) };
      }),
    )
  ).filter((m): m is TemplateMeta => m !== null);
  return [...confirmed, ...pending]
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

/**
 * 1 件取得。メタはファイル名規約、本体はファイル(台帳は引かない)。
 *
 * **確定を先に見る順序が契約**である。① 確定ファイルが在れば `status:'published'`、
 * ② 無く pending(生成直後の未確定実体)が在れば `status:'draft'`、③ どちらも無ければ 404。
 * 逆順にすると pending を書ける者が承認済みテンプレの表示内容を差し替えられ、編集画面・
 * 結合 PDF・比較タブが揃って汚染される。
 */
export async function getTemplate(id: string): Promise<Template> {
  const fileName = `${id}.html`;
  const meta = await fileToMeta(fileName);
  if (!meta) throw notFound(`テンプレートが見つかりません: ${id}`);
  if (await templateExists(fileName)) {
    const html = await readTemplateHtml(fileName);
    const css = await readFundCss(meta.attributes.fundCode);
    // 記入済みの静的コピーはサーバ側に保持しない。エディタが読み込み時に再差込する。
    return { meta, html, css, filled: '' };
  }
  const pending = await readPending(id);
  if (!pending) throw notFound(`テンプレートが見つかりません: ${id}`);
  return {
    meta: { ...meta, status: 'draft', updatedAt: await pendingMtime(id) },
    html: pending.html,
    css: pending.css,
    filled: '',
  };
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
 * 確定内容を実ファイルへ反映する(承認ワークフロー専用の入口)。実体は
 * `confirmedWrite.applyConfirmedWrite` にあり、ここは呼び出し側
 * (`reviewRepo.approveReview`)の参照を保つための薄い委譲。名前検査・ファンド帰属検査・
 * 実行コード不変性の照合・snapshot/restore・git コミット・監査はすべてチョークポイント側。
 */
export function applyConfirmedSave(req: {
  templateId: string;
  html: string;
  css: string;
  fundCode: string;
  commitMessage: string;
  author: string;
}): Promise<TemplateMeta> {
  return applyConfirmedWrite({ kind: 'review-approve', ...req });
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
 * テンプレを開く web 側(`applyTemplateAttributes`)で上書きする。
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
