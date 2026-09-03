// =============================================================================
// templateEditorService.ts — editor の template 読込・draft 保存・履歴 service
// =============================================================================
import {
  applyTemplateAttributes,
  err,
  isErr,
  isOk,
  ok,
  type PairSyncStatus,
  type PartCatalogItem,
  type PartHistoryEntry,
  type PartRepository,
  type Result,
  type SampleData,
  type Template,
  type TemplateRepository,
  validation,
} from '@editor/shared';
import { usePartRepo, useTemplateRepo } from '@/api/repositories';
import { type DraftOwner, draftOwner } from '@/lib/draftOwner';
import { summarizeExternalCssRefs } from '@/lib/sanitizeCss';
import { getBodyInner } from '@/lib/templateDoc';
import { htmlWorker } from '@/workers';

/** editor が template を編集用に開くために必要な一式。 */
interface EditorLoad {
  template: Template;
  /** 編集可能(Jinja-mask 済み)形式の body HTML — draft 由来、または新規に mask したもの。 */
  editableBody: string;
  /** 確定版の値埋め込み本文。赤入れの基準。draft 有無に関わらず解決する。 */
  confirmedBody: string;
  css: string;
  /** canvas 選択を docs へ解決するための catalog parts。 */
  parts: PartCatalogItem[];
  /** editor タイトル用の表示 fund 名(sample data 由来。無ければファイル名にフォールバック)。 */
  fundName: string;
  /** 未確定の draft が既に存在したか(前回セッションの編集途中)。dirty 初期化に使う。 */
  hasDraft: boolean;
  /** 別セッションの下書きを破棄して確定版から開いたか。Undo スタックの後始末に使う。 */
  discardedStaleDraft: boolean;
}

interface TemplateEditorService {
  loadForEdit(id: string): Promise<Result<EditorLoad>>;
  saveDraft(id: string, html: string, css: string): Promise<Result<void>>;
  /** 未確定 draft を破棄する(所属の記録も消す)。 */
  discardDraft(id: string): Promise<Result<void>>;
  listPartHistory(templateId: string): Promise<Result<PartHistoryEntry[]>>;
  recordPartChange(templateId: string, partKey: string, change: string): Promise<Result<void>>;
  /** 交付版⇄全体版 ペア同期の現況(未解決競合)。編集画面を開いた時のバナー表示用。 */
  getSyncStatus(templateId: string): Promise<Result<PairSyncStatus>>;
}

export function createTemplateEditorService(
  templates: TemplateRepository,
  parts: PartRepository,
  owner: DraftOwner = draftOwner,
): TemplateEditorService {
  return {
    async loadForEdit(id) {
      const tplRes = await templates.getTemplate(id);
      if (isErr(tplRes)) return tplRes;
      const partsRes = await parts.listParts({});
      if (isErr(partsRes)) return partsRes;
      // source ファイルを mask するより、autosave 済み draft(既に編集可能)を優先する。
      const draftRes = await templates.getDraft(id);
      if (isErr(draftRes)) return draftRes;

      const tpl = tplRes.value;
      let draft = draftRes.value;
      let discardedStaleDraft = false;
      // 編集セッションはブラウザタブの寿命。別のタブ(閉じたタブ・別端末)が残した下書きは
      // ここで破棄して確定版から開く(設計正典「編集セッションの生存規則」)。破棄要求の失敗は
      // 下書きを採用しない形で吸収する — 古い下書きを黙って復元するより確定版から開く方が
      // 規則に沿い、残った実体は次の autosave が上書きする。
      if (draft && !owner.belongsToSession(id)) {
        const dropped = await templates.discardDraft(id);
        if (isOk(dropped)) owner.release(id);
        draft = null;
        discardedStaleDraft = true;
      }

      // sample data は値の差込と editor タイトルの両方を駆動する。ここでの失敗が
      // load をブロックしてはならない(差込は空値になるだけ)。
      let sample: SampleData = {};
      try {
        const sampleRes = await templates.getSampleData(tpl.meta.attributes.fundCode);
        // 版種・基準日(ファイル名由来)を被せる。getSampleData はファンド単位で属性を持たない。
        if (!isErr(sampleRes))
          sample = applyTemplateAttributes(sampleRes.value, tpl.meta.attributes);
      } catch {
        /* sample は空のままにする */
      }

      // editor canvas は "filled" 形式(値を差込み、Jinja source は保持)を編集する。
      // 静的な fill を優先し、無ければ load 時に生成する。draft は既に編集可能/filled
      // 形式なので最優先となる。
      // 値差込(filled)生成は Worker(nunjucks)で実行しメインを塞がない。静的 filled が
      // あればそれを優先する。
      const filledBody = tpl.filled || (await htmlWorker.toFilled(tpl.html, sample));
      const confirmedBody = getBodyInner(filledBody);
      const editableBody = draft ? draft.html : confirmedBody;
      const css = draft ? draft.css : tpl.css;

      // canvas の iframe は `about:blank` でアプリのオリジンを継承するため、CSS に外部参照が
      // 残っていると編集画面を開いただけでアプリのオリジンから外向き GET が出る(属性
      // セレクタ + `url()` で本文断片の持ち出しにも使える)。**削らずに拒む** — 削る実装は
      // CSS のエスケープで必ず迂回されるうえ、CSS 抜きで開くと autosave が draft の CSS を
      // 空で上書きしてしまう。
      const refs = summarizeExternalCssRefs(css);
      if (refs !== null) {
        return err(
          validation(
            `CSSに外部参照が含まれるため編集画面を開けません(${refs})。` +
              (draft
                ? '下書きを破棄すると開けるようになります。'
                : 'フォントや画像は同梱資産への相対パス(css/… fonts/…)で指定してください。'),
          ),
        );
      }

      let fundName = tpl.meta.fileName.replace(/\.html$/, '');
      const fund = sample.fund as { name?: string } | undefined;
      if (fund?.name) fundName = fund.name;

      return ok({
        template: tpl,
        editableBody,
        confirmedBody,
        css,
        parts: partsRes.value,
        fundName,
        hasDraft: !!draft,
        discardedStaleDraft,
      });
    },

    async saveDraft(id, html, css) {
      const res = await templates.saveDraft({ templateId: id, html, css });
      if (isOk(res)) owner.claim(id);
      return res;
    },

    async discardDraft(id) {
      const res = await templates.discardDraft(id);
      if (isOk(res)) owner.release(id);
      return res;
    },

    listPartHistory: (templateId) => parts.listPartHistory(templateId),

    recordPartChange: (templateId, partKey, change) =>
      parts.recordPartChange(templateId, partKey, change),

    getSyncStatus: (templateId) => templates.getSyncStatus(templateId),
  };
}

export const useTemplateEditorService = (): TemplateEditorService =>
  createTemplateEditorService(useTemplateRepo(), usePartRepo());
