// =============================================================================
// historyRepo.ts — 履歴集約のサーバ(REST)実装
// =============================================================================
// 版一覧/スナップ/編集履歴は git(コミット履歴)が正典で、git log/show から導く。
// PDF出力/作成/パーツ変更は DB(旧 SP.history)を廃し、ファイル監査ログ
// (`logs/history/*.jsonl`)へ記録/参照する。
import { randomUUID } from 'node:crypto';
import {
  type CreateHistoryEntry,
  type EditHistoryEntry,
  notFound,
  type PartHistoryEntry,
  type PdfHistoryEntry,
  parseTemplateFileName,
  type TemplateAttributes,
  type TemplateSnapshot,
  type TemplateVersionMeta,
  templateIdFromFileName,
} from '@editor/shared';
import { appendHistory, readHistory } from '../files/historyFiles.js';
import {
  commitDate,
  commitFiles,
  type GitCommitMeta,
  logAll,
  logForFile,
  showFile,
} from '../git/gitRepo.js';

const TEMPLATES_PATHSPEC = 'templates';
const templateRel = (templateId: string): string => `${TEMPLATES_PATHSPEC}/${templateId}.html`;
const cssRel = (fundCode: string): string => `css/${fundCode}.css`;

/** コミットで変更された最初の `templates/*.html`(無ければ null)。 */
async function changedTemplateFile(hash: string): Promise<string | null> {
  const files = await commitFiles(hash);
  const tpl = files.find((f) => f.startsWith(`${TEMPLATES_PATHSPEC}/`) && f.endsWith('.html'));
  return tpl ? tpl.slice(`${TEMPLATES_PATHSPEC}/`.length) : null;
}

// ── git 由来: 編集履歴 / 版一覧 / スナップ ──

/** 全テンプレの編集履歴(templates/ に触れた各コミット)。 */
export async function getEditHistory(): Promise<EditHistoryEntry[]> {
  const commits = await logAll(TEMPLATES_PATHSPEC);
  const entries = await Promise.all(
    commits.map(async (c: GitCommitMeta) => {
      const fileName = await changedTemplateFile(c.hash);
      return {
        id: c.hash,
        templateId: fileName ? templateIdFromFileName(fileName) : '',
        user: c.author,
        timestamp: c.date,
        summary: c.subject,
      };
    }),
  );
  return entries;
}

/** テンプレ単位の版一覧(新しい順)。historyId はコミット hash。 */
export async function listVersions(templateId: string): Promise<TemplateVersionMeta[]> {
  const commits = await logForFile(templateRel(templateId));
  return commits.map((c) => ({
    historyId: c.hash,
    templateId,
    timestamp: c.date,
    user: c.author,
    summary: c.subject,
  }));
}

/** 版スナップショット(本体は git show でコミット時点を取り出す)。 */
export async function getSnapshot(historyId: string): Promise<TemplateSnapshot> {
  const fileName = await changedTemplateFile(historyId);
  if (!fileName) throw notFound(`この版の比較データがありません: ${historyId}`);
  const attrs = parseTemplateFileName(fileName);
  if (!attrs) throw notFound(`版のファイル名を解釈できません: ${historyId}`);
  const templateId = templateIdFromFileName(fileName);
  // html/css/日時は互いに独立した git read(`withGitLock` 非経由 = 並列安全)。
  // 逐次 await だと 3 プロセスの起動待ちが直列化するため Promise.all でまとめる。
  const [html, css, timestamp] = await Promise.all([
    showFile(historyId, templateRel(templateId)),
    showFile(historyId, cssRel(attrs.fundCode)),
    commitDate(historyId),
  ]);
  return {
    historyId,
    templateId,
    html,
    css,
    fundCode: attrs.fundCode,
    timestamp,
  };
}

// ── ファイル監査ログ由来: PDF出力 / 作成 / パーツ変更 ──

export async function getPdfHistory(): Promise<PdfHistoryEntry[]> {
  return readHistory<PdfHistoryEntry>('pdf');
}

export async function getCreateHistory(): Promise<CreateHistoryEntry[]> {
  return readHistory<CreateHistoryEntry>('create');
}

export async function recordPdfExport(templateId: string, loginId: string): Promise<void> {
  const entry: PdfHistoryEntry = {
    id: `ph-${randomUUID()}`,
    templateId,
    user: loginId,
    timestamp: new Date().toISOString(),
  };
  await appendHistory('pdf', entry);
}

export async function recordCreate(
  attributes: TemplateAttributes,
  basedOnTemplateId: string | undefined,
  loginId: string,
): Promise<void> {
  const entry: CreateHistoryEntry = {
    id: `ch-${randomUUID()}`,
    attributes,
    user: loginId,
    timestamp: new Date().toISOString(),
    basedOnTemplateId,
  };
  await appendHistory('create', entry);
}

export async function recordPartChange(
  templateId: string,
  partKey: string,
  change: string,
  loginId: string,
): Promise<void> {
  const entry: PartHistoryEntry = {
    id: `pt-${randomUUID()}`,
    templateId,
    partKey,
    user: loginId,
    timestamp: new Date().toISOString(),
    change,
  };
  await appendHistory('part', entry);
}

/** 指定版インスタンスの全パーツ履歴を返す(`partKey` 絞りは呼び出し側で行う)。 */
export async function listPartHistory(templateId: string): Promise<PartHistoryEntry[]> {
  const all = await readHistory<PartHistoryEntry>('part');
  return all.filter((e) => e.templateId === templateId);
}
