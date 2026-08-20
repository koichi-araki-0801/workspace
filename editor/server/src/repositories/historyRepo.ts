// =============================================================================
// historyRepo.ts — 履歴集約のサーバ(REST)実装
// =============================================================================
// 版一覧/スナップ/編集履歴は git(コミット履歴)が正典で、git log/show から導く。
// PDF出力/作成/パーツ変更は DB には置かず、ファイル監査ログ
// (`logs/history/*.jsonl`)へ記録/参照する。
import { randomUUID } from 'node:crypto';
import {
  assertTemplateId,
  type CreateHistoryEntry,
  type EditHistoryEntry,
  isGitObjectId,
  notFound,
  type PartHistoryEntry,
  type PdfHistoryEntry,
  parseTemplateFileName,
  type TemplateAttributes,
  type TemplateSnapshot,
  type TemplateVersionMeta,
  templateIdFromFileName,
  validation,
} from '@editor/shared';
import { appendHistory, readHistory } from '../files/historyFiles.js';
import { commitDate, commitFiles, logAllWithFiles, logForFile, showFile } from '../git/gitRepo.js';

const TEMPLATES_PATHSPEC = 'templates';
const templateRel = (templateId: string): string => `${TEMPLATES_PATHSPEC}/${templateId}.html`;
const cssRel = (fundCode: string): string => `css/${fundCode}.css`;

/**
 * 変更ファイル一覧から `templates/*.html` を**すべて**取り出す。
 *
 * 確定コミットは `git add -A` で作るため、承認とペア転写のように 2 つ以上のテンプレが
 * 同じコミットへ入りうる。先頭 1 件だけを見ると、版一覧が同じ hash を返す別テンプレへ
 * 先頭テンプレの内容を配ってしまう(誤帰属)。
 */
function templateFilesOf(files: readonly string[]): string[] {
  return files
    .filter((f) => f.startsWith(`${TEMPLATES_PATHSPEC}/`) && f.endsWith('.html'))
    .map((f) => f.slice(`${TEMPLATES_PATHSPEC}/`.length));
}

/** コミットが触れたテンプレのうち、スナップショットの対象 1 件を決める。 */
function pickTemplateFile(
  historyId: string,
  fileNames: readonly string[],
  templateId: string | undefined,
): string {
  if (templateId !== undefined) {
    // `templateId` は URL 由来。ファイル名規約を通してから照合する(`..` 等の混入を断つ)。
    const want = `${assertTemplateId(templateId)}.html`;
    const hit = fileNames.find((f) => f === want);
    if (!hit) throw notFound(`この版に ${templateId} の変更は含まれていません: ${historyId}`);
    return hit;
  }
  if (fileNames.length === 0) throw notFound(`この版の比較データがありません: ${historyId}`);
  if (fileNames.length > 1) {
    throw validation(
      `この版は複数のテンプレートを含みます。templateId を指定してください: ${historyId}`,
    );
  }
  return fileNames[0];
}

// ── git 由来: 編集履歴 / 版一覧 / スナップ ──

/**
 * 全テンプレの編集履歴(templates/ に触れた各コミット)。
 *
 * ⚠ コミットごとに `git show` を呼ぶ形へ戻さないこと。`Promise.all(commits.map(...))` は
 * 全コミットぶんの子プロセスを同一 tick で spawn するため、承認のたび伸びる履歴が
 * そのまま 1 リクエストのプロセス数になる(各子は `maxBuffer` 64MB を持つ)。
 * 変更ファイルは `logAllWithFiles` が同じ `git log` から取る = 子プロセスは常に 1 個。
 */
export async function getEditHistory(): Promise<EditHistoryEntry[]> {
  const commits = await logAllWithFiles(TEMPLATES_PATHSPEC);
  return commits.flatMap((c) => {
    const base = { id: c.hash, user: c.author, timestamp: c.date, summary: c.subject };
    const fileNames = templateFilesOf(c.files);
    // 触れたテンプレごとに 1 行を出す。1 行へ畳むと、同じコミットで変わった他のテンプレは
    // 履歴に現れないまま先頭テンプレの編集として記録される。
    if (fileNames.length === 0) return [{ ...base, templateId: '' }];
    return fileNames.map((f) => ({ ...base, templateId: templateIdFromFileName(f) }));
  });
}

/** テンプレ単位の版一覧(新しい順)。historyId はコミット hash。 */
export async function listVersions(templateId: string): Promise<TemplateVersionMeta[]> {
  // `templateId` は URL 由来で pathspec の一部になる。ファイル名規約 + 単一セグメント安全性を
  // 通ってからでないと git へ渡さない(`..` や pathspec magic の混入を入口で断つ)。
  const commits = await logForFile(templateRel(assertTemplateId(templateId)));
  return commits.map((c) => ({
    historyId: c.hash,
    templateId,
    timestamp: c.date,
    user: c.author,
    summary: c.subject,
  }));
}

/**
 * 版スナップショット(本体は git show でコミット時点を取り出す)。
 *
 * `templateId` は「このコミットのどのテンプレの版か」を決める。1 コミットが複数の
 * テンプレに触れていると hash だけでは対象が決まらないため、指定が無く候補が 2 つ以上
 * あるときは**先頭で代用せずエラー**にする(黙って別テンプレの内容を配らない)。
 */
export async function getSnapshot(
  historyId: string,
  templateId?: string,
): Promise<TemplateSnapshot> {
  // `historyId` は URL 由来で `git show` のリビジョン引数になる。`-` 始まりの値は git が
  // オプションとして解釈するため(`--output=<file>` で任意ファイルを破壊できる)、git を
  // 呼ぶ前にオブジェクトID 形式で弾く。git 呼び出し側の多層防御は `gitRepo.ts` の検証節。
  if (!isGitObjectId(historyId)) throw validation(`版の指定が不正です: ${historyId}`);
  const fileNames = templateFilesOf(await commitFiles(historyId));
  const fileName = pickTemplateFile(historyId, fileNames, templateId);
  const attrs = parseTemplateFileName(fileName);
  if (!attrs) throw notFound(`版のファイル名を解釈できません: ${historyId}`);
  const resolvedId = templateIdFromFileName(fileName);
  // html/css/日時は互いに独立した git read(`withGitLock` 非経由 = 並列安全)。
  // 逐次 await だと 3 プロセスの起動待ちが直列化するため Promise.all でまとめる。
  const [html, css, timestamp] = await Promise.all([
    showFile(historyId, templateRel(resolvedId)),
    showFile(historyId, cssRel(attrs.fundCode)),
    commitDate(historyId),
  ]);
  return {
    historyId,
    templateId: resolvedId,
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

/**
 * 指定版インスタンスの全パーツ履歴を返す(`partKey` 絞りは呼び出し側で行う)。
 *
 * 絞り込みは `readHistory` へ渡す(後から `filter` しない)。`part.jsonl` は全テンプレ共用の
 * 1 本なので、先に件数で打ち切ってから絞ると、他テンプレの編集が上限件数進むだけで当該
 * テンプレの履歴が 0 件になり「履歴が消えた」ように見える。
 */
export async function listPartHistory(templateId: string): Promise<PartHistoryEntry[]> {
  return readHistory<PartHistoryEntry>('part', { where: (e) => e.templateId === templateId });
}
