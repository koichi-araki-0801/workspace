// =============================================================================
// templateRepo.ts — テンプレート集約のサーバ(REST)実装
// =============================================================================
// ゲートウェイ sproc とディスク上の本体を裏付けとする。各関数は失敗時に `AppError` を
// throw し、ルートハンドラは中央の `errorHandler` に HTTP への変換を委ねる
// (Result を返す Repository 契約は web の `rest` 層が満たす。ここでは throw する)。
import {
  buildSampleData,
  type CompanyOption,
  type CreatableInfo,
  type DropdownOptions,
  type DropdownQuery,
  type DropdownScope,
  type FundMaster,
  type FundOption,
  notFound,
  type SampleData,
  type Template,
  type TemplateDraft,
  type TemplateMeta,
} from '@editor/shared';
import { asString, asStringOrNull, firstRow, p, type SprocClient } from '../db/sproc.js';
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
  attrKey,
  filledExists,
  listFilledFiles,
  listTemplateFiles,
  readFilledHtml,
  readFundCss,
  readTemplateHtml,
  templateAttrKeys,
  templateExists,
} from '../files/templateFiles.js';
import { applyConfirmedWrite, type ConfirmedTarget } from './confirmedWrite.js';
import { fileToMeta } from './templateMeta.js';

const ATTR_KEYS = ['companyCode', 'fundCode', 'baseDate', 'editionType'] as const;

/** 大文字小文字を区別しない一致。ファイル名由来の属性と利用者の選択を照合する。 */
export const sameCi = (a: string, b: string): boolean => a.toLowerCase() === b.toLowerCase();

export const isMeta = (m: TemplateMeta | null): m is TemplateMeta => m !== null;

/** dropdown query の先頭 `depth` 個の設定済みフィールドにメタが一致するか。 */
function matchesUpTo(m: TemplateMeta, q: DropdownQuery, depth: number): boolean {
  return ATTR_KEYS.slice(0, depth).every((k) => {
    const want = q[k];
    return !want || sameCi(m.attributes[k], want);
  });
}

/** dropdown query の設定済み全フィールドにメタが一致するか。 */
function metaMatches(m: TemplateMeta, q: DropdownQuery): boolean {
  return matchesUpTo(m, q, ATTR_KEYS.length);
}

/** 大文字小文字だけが違う値は最初の表記へまとめ、`localeCompare` で並べる。 */
function uniqCi(values: string[]): string[] {
  const seen = new Map<string, string>();
  for (const v of values) if (!seen.has(v.toLowerCase())) seen.set(v.toLowerCase(), v);
  return [...seen.values()].sort((a, b) => a.localeCompare(b));
}

/** 各候補は自分より上位の選択だけで絞る(sproc `候補` と同じ規則)。 */
function optionsFromMetas(metas: TemplateMeta[], q: DropdownQuery): DropdownOptions {
  const at = (depth: number, key: (typeof ATTR_KEYS)[number]) =>
    uniqCi(metas.filter((m) => matchesUpTo(m, q, depth)).map((m) => m.attributes[key]));
  return {
    companyCodes: at(0, 'companyCode'),
    fundCodes: at(1, 'fundCode'),
    baseDates: at(2, 'baseDate'),
    editionTypes: at(3, 'editionType'),
  };
}

/**
 * 編集タブが扱うテンプレ。`filled/`(確定)に、`includePending` なら `pending/`(生成直後の
 * 未確定)を足す。同じ id が両方に在るときは確定を採る(承認後の pending 削除はベストエフォート)。
 */
async function scanEditableMetas(includePending: boolean): Promise<TemplateMeta[]> {
  const files = await listFilledFiles();
  const confirmed = (await Promise.all(files.map((f) => fileToMeta(f, 'filled')))).filter(isMeta);
  if (!includePending) return confirmed;
  // 照合は大文字小文字を区別しない。NTFS では承認が既存の綴りのファイルへ上書きするので、
  // 綴り違いの pending が消し残ると完全一致では同じテンプレが二重に出る。
  const confirmedIds = new Set(confirmed.map((m) => m.id.toLowerCase()));
  const pendingIds = (await listPendingIds()).filter((id) => !confirmedIds.has(id.toLowerCase()));
  const pending = (
    await Promise.all(
      pendingIds.map(async (id): Promise<TemplateMeta | null> => {
        const meta = await fileToMeta(`${id}.html`);
        return meta && { ...meta, status: 'draft', updatedAt: await pendingMtime(id) };
      }),
    )
  ).filter(isMeta);
  return [...confirmed, ...pending];
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

export interface TemplateRepo {
  getDropdownOptions(q: DropdownQuery, scope: DropdownScope): Promise<DropdownOptions>;
  listTemplates(q: DropdownQuery): Promise<TemplateMeta[]>;
  getTemplate(id: string): Promise<Template>;
  saveDraft(templateId: string, html: string, css: string, loginId: string): Promise<void>;
  getDraft(templateId: string): Promise<TemplateDraft | null>;
  discardDraft(templateId: string): Promise<void>;
  getSampleData(fundCode: string): Promise<SampleData>;
  listCompanies(): Promise<CompanyOption[]>;
  listFunds(rep1CompanyCode: string): Promise<FundOption[]>;
  getCreatableInfo(q: {
    companyCode: string;
    rep1CompanyCode: string;
    fundCode: string;
    editionType: string;
  }): Promise<CreatableInfo>;
}

export function createTemplateRepo(sproc: SprocClient): TemplateRepo {
  async function listFunds(rep1CompanyCode: string): Promise<FundOption[]> {
    const rows = await sproc.callSproc(SP.template, 'ファンド一覧', [
      p('委託会社コード', rep1CompanyCode),
    ]);
    return rows.map((r) => ({
      fundCode: asString(r.ファンドコード),
      fundName: asString(r.ファンド名),
    }));
  }

  return {
    async listCompanies() {
      const rows = await sproc.callSproc(SP.template, '委託会社一覧');
      return rows.map((r) => ({
        companyCode: asString(r.委託会社略称),
        companyName: asString(r.委託会社名),
        rep1CompanyCode: asString(r.委託会社コード),
      }));
    },

    listFunds,

    /**
     * 作成タブ Step 2 の素。作成済みは filled/・templates/・pending/ のどれか、コピー元の有無は
     * 生成器が読む templates/ だけを見る。シリーズは Rep1 の会社コードで引き、名称はファンド一覧から付ける。
     */
    async getCreatableInfo({ companyCode, rep1CompanyCode, fundCode, editionType }) {
      const templateKeys = templateAttrKeys(await listTemplateFiles());
      const createdKeys = new Set([
        ...templateKeys,
        ...templateAttrKeys(await listFilledFiles()),
        ...templateAttrKeys((await listPendingIds()).map((id) => `${id}.html`)),
      ]);
      const created = createdKeys.has(attrKey(companyCode, fundCode, editionType));
      const seriesRows = await sproc.callSproc(SP.series, '一覧', [
        p('委託会社コード', rep1CompanyCode),
      ]);
      const seriesOf = new Map(
        seriesRows.map((r) => [asString(r.ファンドコード), asStringOrNull(r.シリーズコード)]),
      );
      const series = seriesOf.get(fundCode) ?? null;
      if (!series) return { created, seriesFunds: [] };
      const names = new Map(
        (await listFunds(rep1CompanyCode)).map((f) => [f.fundCode, f.fundName]),
      );
      const seriesFunds = [...seriesOf.entries()]
        .filter(([code, s]) => code !== fundCode && s === series)
        .map(([code]) => ({
          fundCode: code,
          fundName: names.get(code) ?? '',
          hasTemplate: templateKeys.has(attrKey(companyCode, code, editionType)),
        }))
        .sort((a, b) => a.fundCode.localeCompare(b.fundCode));
      return { created, seriesFunds };
    },

    /**
     * 候補の出所は画面ごとに違う。編集タブ(edit)は一覧と同じ filled/ + pending/、比較・結合
     * (published)は承認済みの filled/ だけ。作成タブの候補は Rep1(`listCompanies` / `listFunds`)。
     */
    async getDropdownOptions(q, scope) {
      return optionsFromMetas(await scanEditableMetas(scope === 'edit'), q);
    },

    /**
     * 既存テンプレの一覧は `filled/`(値入り HTML = 編集タブの本文)と
     * `pending/`(生成直後の未確定実体)のファイル走査から導く。`templates/`(作成タブの
     * Jinja)は一覧に出さない — 値入り HTML が無いテンプレを編集して申請する事故を防ぐため。
     *
     * 混ぜない設計は一度採ったが不成立だった: 作成タブは生成後に `/edit/:id` へ 1 回遷移する
     * だけで、履歴タブは遷移経路を持たない。そのため一覧から外すと、生成直後にブラウザを
     * 閉じた時点でその id へ到達する手段が UI から消える(= 作ったテンプレが行方不明になる)。
     *
     * 未承認の内容を扱ってはいけない画面(比較タブ・結合 PDF)は**呼び出し側**で
     * `status === 'published'` に絞る。一覧側で落とすと上記の到達不能が再発する。
     */
    async listTemplates(q) {
      return (await scanEditableMetas(true))
        .filter((m) => metaMatches(m, q))
        .sort((a, b) => a.fileName.localeCompare(b.fileName));
    },

    /**
     * 1 件取得。メタはファイル名規約、本体はファイル(DB は引かない)。
     *
     * 探索順は ① `filled/`(値入り HTML。編集タブの本文)→ ② `templates/`(作成タブの Jinja。
     * 作成経路の承認直後に精査画面が確定版を読む)→ ③ `pending/`(生成直後の未確定実体)。
     * ①②は `status:'published'`、③は `status:'draft'`、どこにも無ければ 404。
     * **確定を先に見る順序が契約**である。逆順にすると pending を書ける者が承認済みテンプレの
     * 表示内容を差し替えられ、編集画面・結合 PDF・比較タブが揃って汚染される。
     * ①で見つかったときだけ `filled` に本文を入れる(値入り HTML は Jinja を持たないので
     * `html` と同じ内容。web は `filled` が非空の文書を完成描画として扱う)。
     */
    async getTemplate(id) {
      const fileName = `${id}.html`;
      if (await filledExists(fileName)) {
        const meta = await fileToMeta(fileName, 'filled');
        if (!meta) throw notFound(`テンプレートが見つかりません: ${id}`);
        const html = await readFilledHtml(fileName);
        const css = await readFundCss(meta.attributes.fundCode);
        return { meta, html, css, filled: html };
      }
      const meta = await fileToMeta(fileName);
      if (!meta) throw notFound(`テンプレートが見つかりません: ${id}`);
      if (await templateExists(fileName)) {
        const html = await readTemplateHtml(fileName);
        const css = await readFundCss(meta.attributes.fundCode);
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
    },

    /** 自動保存ドラフトはファイルのみ(`<dataRoot>/drafts`、git 管理外)。DB は引かない。 */
    async saveDraft(templateId, html, css, _loginId) {
      await writeDraft(templateId, html, css);
    },

    async getDraft(templateId) {
      if (!(await draftExists(templateId))) return null;
      const { html, css } = await readDraft(`${templateId}.html`, `${templateId}.css`);
      // 保存者はファイルからは判らない(下書きは作業コピー)。保存日時は mtime で代用。
      return { templateId, html, css, savedAt: (await draftMtime(templateId)) ?? '', savedBy: '' };
    },

    /** 確定保存せずメニューへ戻った際に、未確定の下書き作業コピーを破棄する。 */
    async discardDraft(templateId) {
      await deleteDraft(templateId);
    },

    /**
     * プレビュー文脈のサンプルデータ。本体はパーツ別共通ダミー(`sampleCommon`)で、
     * DB の台帳からはファンド固有の名称/会社だけを解決して被せる。版種(ファイル名由来)は
     * テンプレを開く web 側(`applyTemplateAttributes`)で上書きする。
     */
    async getSampleData(fundCode) {
      const row = firstRow(
        await sproc.callSproc(SP.sample, '取得', [p('ファンドコード', fundCode)]),
      );
      const master = parseFundMaster(row ? asStringOrNull(row.データJSON) : null);
      return buildSampleData(master, fundCode);
    },
  };
}

/**
 * 確定内容を実ファイルへ反映する(承認ワークフロー専用の入口)。実体は
 * `confirmedWrite.applyConfirmedWrite` にあり、ここは呼び出し側
 * (`reviewRepo.approveReview`)の参照を保つための薄い委譲。名前検査・ファンド帰属検査・
 * 実行コード不変性の照合・snapshot/restore・git コミット・監査はすべてチョークポイント側。
 *
 * sproc に依存しないため `createTemplateRepo` の中へは入れない — 入れると
 * `createReviewRepo` がテンプレート集約ごと受け取る必要が生じ、承認の依存が広がる。
 */
export function applyConfirmedSave(req: {
  templateId: string;
  target: ConfirmedTarget;
  html: string;
  css: string;
  fundCode: string;
  commitMessage: string;
  author: string;
}): Promise<TemplateMeta> {
  return applyConfirmedWrite({ kind: 'review-approve', ...req });
}
