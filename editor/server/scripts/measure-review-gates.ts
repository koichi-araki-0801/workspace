// =============================================================================
// measure-review-gates.ts — 本番のテンプレートとパーツカタログで、作成経路の受付の検査と不変ゲートの誤検知を数える
// =============================================================================
// 使い方: editor\scripts\measure-review-gates.bat [--out <フォルダ>]
//         (中身は editor\server で `pnpm exec tsx scripts/measure-review-gates.ts [--out <フォルダ>]`)
// 作成経路の受付の検査(shared の `reviewableSource.ts`・`createReviewRender.ts`・`revealExpr.ts`)と
// script の不変ゲート(`src/security/templateScripts.ts`)は、手元の fixture では誤検知 0 件だが、本番の
// テンプレートとパーツカタログ(DB の `内容HTML`)では測れていない(設計書
// `2026-10-30-review-binding-and-script-gate-design.md` の手順 0・誤検知のリスク・追補 改訂 3)。本番の
// 端末で、サーバと同じ設定(`appconfig.json` と環境変数)・同じリポジトリの作り方で読み、次を数える。
//   テンプレート(dataRoot の templates/ の全ファイルと、pending/ の作成経路の生成物。作成タブでこれから
//   申請されるのは後者なので、どちらで見つけたかを `templates/<id>`・`pending/<id>` の名前で分けて
//   出す): (a) `findReviewableIssues` の違反、(b) テンプレート自身を基準にした `renderCreateReview` の
//   結果、(c) `collectExecutableUnits` の jinja で始まる単位。
//   パーツ(カタログの全件): (d) 文書の body に 1 つ挿入したときの違反、(e) jinja で始まる単位(基準に
//   無いので、作成タブで新しく挿入すると不変ゲートで拒否される)、(f) 値で描けず原文の文字になる式。
// 書き込みは一切しない。DB は読み取りの sproc の操作だけを許可リストで通し(`readOnlySproc`)、
// ファイルはリポジトリと pending/ の読み取りの口(`getTemplate`・`readPending`)だけを使う。結果は画面に要約、詳細は dataRoot の外のテキスト
// ファイル(既定は展開先の `bk\measure-<日時>\report.txt`)に、違反位置の前後 40 文字の抜粋だけを書く。
// 計測の中核は I/O を持たない関数に分け、`test/measureReviewGates.test.ts` が fixture とフェイクで
// 確かめる。`config.ts` は import 時に環境変数から dataRoot を解決するので、`main` の中でだけ読み込む
// (テストが開発機の DATA_ROOT を読まないように)。
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  applyTemplateAttributes,
  findReviewableIssues,
  isAppError,
  type PartCatalogItem,
  parseSkeletonFileName,
  type ReviewableIssueCode,
  renderCreateReview,
  renderPlainFilled,
  type SampleData,
  stripLeadingBom,
  templateIdFromFileName,
} from '@editor/shared';
import type { Row, SprocClient } from '../src/db/sproc.js';
import { SP } from '../src/db/sprocNames.js';
import type { PartRepo } from '../src/repositories/partRepo.js';
import type { TemplateRepo } from '../src/repositories/templateRepo.js';
import { collectExecutableUnits } from '../src/security/templateScripts.js';

// ── 1. 抜粋と上限 ──

/** 1 件の項目について、原文(unrendered・単位)を書き出す件数の上限。 */
export const MAX_SOURCES_PER_ITEM = 5;
/** 1 件の項目について、違反を書き出す件数の上限(件数は全部数える)。 */
const MAX_ISSUES_PER_ITEM = 20;
/** 原文 1 つを書き出す文字数の上限(実データを全文で書き出さない)。 */
const MAX_SOURCE_CHARS = 120;
/** 抜粋の前後の文字数。 */
const EXCERPT_RADIUS = 40;
/** 画面に名前を出す件数。 */
const SCREEN_NAMES = 20;

const visible = (s: string) => s.replace(/\r\n|\r|\n/g, '⏎').replace(/\t/g, '→');
const clip = (s: string, n = MAX_SOURCE_CHARS) => visible(s.length > n ? `${s.slice(0, n)}…` : s);

/** 原文の `at` の前後 40 文字の抜粋。改行・タブは見える記号にする。 */
export function excerptAt(src: string, at: number): string {
  const start = Math.max(0, at - EXCERPT_RADIUS);
  const end = Math.min(src.length, at + EXCERPT_RADIUS);
  return `${start > 0 ? '…' : ''}${visible(src.slice(start, end))}${end < src.length ? '…' : ''}`;
}

const errorText = (e: unknown): string =>
  isAppError(e) ? e.message : e instanceof Error ? `${e.name}: ${e.message}` : String(e);

// ── 2. テンプレートごと・パーツごとの計測(I/O なし) ──

export interface IssueHit {
  code: ReviewableIssueCode;
  /** 原文の位置(パーツはパーツの中の位置)。 */
  at: number;
  excerpt: string;
}

export type RenderOutcome =
  | { ok: true; unrendered: number; unrenderedSources: string[]; escapedSafe: number; ms: number }
  | { ok: false; reason: string };

/**
 * テンプレートを見つけた置き場。`templates/` は確定版、`pending/` は作成経路の生成物(未承認)で、
 * 作成タブでこれから申請されるのは主に後者。同じ id が両方にあれば別々に測る。
 */
export type TemplateSource = 'templates' | 'pending';

export interface TemplateMeasure {
  source: TemplateSource;
  id: string;
  /** (a) 作成経路でそもそも申請できない違反。 */
  issues: IssueHit[];
  /** (b) テンプレート自身を基準にした受付の描画。 */
  render: RenderOutcome;
  /** (c) jinja で始まる単位の種類別の件数(参考)。 */
  jinjaUnitKinds: Record<string, number>;
  jinjaUnitSamples: string[];
}

export interface PartMeasure {
  id: string;
  name: string;
  /** (d) 文書の body に 1 つ挿入したときの違反。 */
  issues: IssueHit[];
  /** (e) jinja で始まる単位(新しく挿入すると不変ゲートで拒否される)。 */
  jinjaUnits: string[];
  /** 参考: jinja 以外の実行面の単位の数(これも新しく挿入すると拒否される)。 */
  otherUnits: number;
  /** (f) 値で描けず原文の文字になる式の件数。 */
  unrendered: number;
  unrenderedSources: string[];
  /** Jinja として読めないなど、(f) を測れなかった理由。 */
  error?: string;
}

const kindOf = (unit: string) => unit.split(':', 1)[0];

function toHits(src: string, issues: readonly { code: ReviewableIssueCode; at: number }[]) {
  return issues.map((i) => ({ code: i.code, at: i.at, excerpt: excerptAt(src, i.at) }));
}

/** テンプレート 1 本を測る。`sample` は受付と同じ作り方(getSampleData + applyTemplateAttributes)。 */
export function measureTemplate(
  id: string,
  html: string,
  sample: SampleData | null,
): Omit<TemplateMeasure, 'source'> {
  const src = stripLeadingBom(html);
  const issues = toHits(src, findReviewableIssues(src, { document: true }));
  const jinjaUnitKinds: Record<string, number> = {};
  const jinjaUnitSamples: string[] = [];
  for (const u of collectExecutableUnits(html)) {
    if (!u.startsWith('jinja')) continue;
    jinjaUnitKinds[kindOf(u)] = (jinjaUnitKinds[kindOf(u)] ?? 0) + 1;
    if (jinjaUnitSamples.length < MAX_SOURCES_PER_ITEM) jinjaUnitSamples.push(clip(u));
  }
  let render: RenderOutcome;
  if (sample === null) {
    render = { ok: false, reason: 'sample を取得できないため、受付の描画を測れません' };
  } else {
    const t0 = performance.now();
    try {
      const { renderNotes } = renderCreateReview(html, sample, html);
      render = {
        ok: true,
        unrendered: renderNotes.unrendered,
        unrenderedSources: renderNotes.unrenderedSources
          .slice(0, MAX_SOURCES_PER_ITEM)
          .map((s) => clip(s)),
        escapedSafe: renderNotes.escapedSafe,
        ms: Math.round(performance.now() - t0),
      };
    } catch (e) {
      render = { ok: false, reason: errorText(e) };
    }
  }
  return { id, issues, render, jinjaUnitKinds, jinjaUnitSamples };
}

const PART_DOC_HEAD = '<!DOCTYPE html>\n<html><head><meta charset="utf-8"></head><body>\n<main>\n';
const PART_DOC_TAIL = '\n</main>\n</body></html>\n';

/** パーツ 1 件を測る。`sample` は値で描けるかを見るためだけに使う。 */
export function measurePart(part: PartCatalogItem, sample: SampleData): PartMeasure {
  const content = part.content;
  const wrapped = `${PART_DOC_HEAD}${content}${PART_DOC_TAIL}`;
  const clamp = (at: number) => Math.min(Math.max(at - PART_DOC_HEAD.length, 0), content.length);
  const issues = toHits(
    content,
    findReviewableIssues(wrapped, { document: true }).map((i) => ({ ...i, at: clamp(i.at) })),
  );
  const units = collectExecutableUnits(content);
  const jinjaUnits = units.filter((u) => u.startsWith('jinja')).map((u) => clip(u));
  const out: PartMeasure = {
    id: part.id,
    name: part.name,
    issues,
    jinjaUnits,
    otherUnits: units.length - jinjaUnits.length,
    unrendered: 0,
    unrenderedSources: [],
  };
  try {
    const { diagnostics } = renderPlainFilled(content, sample, { reveal: true });
    out.unrendered = diagnostics.unrenderedCount;
    out.unrenderedSources = diagnostics.unrendered
      .slice(0, MAX_SOURCES_PER_ITEM)
      .map((s) => clip(s));
  } catch (e) {
    out.error = errorText(e);
  }
  return out;
}

// ── 3. DB を読み取りに限る ──

/** 計測が呼んでよい sproc の操作(どれも読み取り)。ほかは呼ぶ前に止める。 */
const READ_ONLY_OPS: ReadonlySet<string> = new Set([
  `${SP.sample}/共通一覧`,
  `${SP.template}/委託会社一覧`,
  `${SP.template}/ファンド一覧`,
  `${SP.part}/一覧`,
]);

/** 許可リストの読み取りの操作だけを通す sproc の呼び出し口。 */
export function readOnlySproc(inner: SprocClient): SprocClient {
  return {
    callSproc<T = Row>(
      proc: string,
      操作: string,
      params?: Parameters<SprocClient['callSproc']>[2],
    ) {
      if (!READ_ONLY_OPS.has(`${proc}/${操作}`))
        return Promise.reject(
          new Error(`計測は読み取りの操作だけを呼びます。呼ぼうとした操作: ${proc} ${操作}`),
        );
      return inner.callSproc<T>(proc, 操作, params);
    },
  };
}

// ── 4. 全体の計測(リポジトリ経由) ──

export interface MeasureDeps {
  /** dataRoot の templates/ の `*.html`(`files/templateFiles.ts` の `listTemplateFiles`)。 */
  listTemplateFiles(): Promise<string[]>;
  /** dataRoot の pending/ の id(`files/pendingFiles.ts` の `listPendingIds`)。 */
  listPendingIds(): Promise<string[]>;
  /**
   * pending/ の本体を読む(`readPending`)。`getTemplate` は templates/ を先に見るので、同じ id が
   * 両方にあると pending/ の中身を読めない。
   */
  readPending(id: string): Promise<{ html: string } | null>;
  templates: Pick<TemplateRepo, 'getTemplate' | 'getSampleData'>;
  parts: Pick<PartRepo, 'listParts'>;
}

export interface MeasureResult {
  templates: TemplateMeasure[];
  parts: PartMeasure[];
  /** 測れなかった物と、パーツの sample の出どころ。 */
  notes: string[];
}

/** 画面・レポートでの名前。置き場を前に付けて、templates/ と pending/ を区別する。 */
export const templateLabel = (t: Pick<TemplateMeasure, 'source' | 'id'>) => `${t.source}/${t.id}`;

/**
 * templates/ の全ファイル、pending/ の作成経路の生成物(会社_ファンド_版種の id)、パーツカタログの
 * 全件を、受付と同じ作り方で読んで測る。pending/ の値入り HTML(基準日を持つ編集経路の生成物)は
 * 作成経路で申請されないので測らない。
 */
export async function runMeasure(deps: MeasureDeps): Promise<MeasureResult> {
  const notes: string[] = [];
  const templates: TemplateMeasure[] = [];
  let partSample: { from: string; sample: SampleData } | null = null;
  const targets: { source: TemplateSource; fileName: string }[] = [];
  for (const fileName of [...(await deps.listTemplateFiles())].sort()) {
    if (parseSkeletonFileName(fileName)) targets.push({ source: 'templates', fileName });
    else
      notes.push(
        `templates/ の作成経路の名前(会社_ファンド_版種)でないため測りません: ${fileName}`,
      );
  }
  const pendingIds = [...(await deps.listPendingIds())].sort();
  const skeletonPending = pendingIds.filter((id) => parseSkeletonFileName(`${id}.html`));
  targets.push(
    ...skeletonPending.map((id) => ({ source: 'pending' as const, fileName: `${id}.html` })),
  );
  if (skeletonPending.length < pendingIds.length)
    notes.push(
      `pending/ の編集経路の生成物(基準日つき) ${pendingIds.length - skeletonPending.length} 件は測りません`,
    );
  for (const { source, fileName } of targets) {
    const attrs = parseSkeletonFileName(fileName);
    if (!attrs) continue;
    const id = templateIdFromFileName(fileName);
    const label = templateLabel({ source, id });
    let html: string;
    try {
      const got =
        source === 'templates' ? await deps.templates.getTemplate(id) : await deps.readPending(id);
      if (got === null) throw new Error('見つかりません');
      html = got.html;
    } catch (e) {
      notes.push(`読めませんでした: ${label}: ${clip(errorText(e))}`);
      continue;
    }
    let sample: SampleData | null = null;
    try {
      sample = applyTemplateAttributes((await deps.templates.getSampleData(id)).sample, attrs);
      partSample ??= { from: label, sample };
    } catch (e) {
      notes.push(`sample を取得できませんでした: ${label}: ${clip(errorText(e))}`);
    }
    templates.push({ source, ...measureTemplate(id, html, sample) });
  }
  const items = await deps.parts.listParts({});
  notes.push(
    partSample
      ? `パーツの (f) は ${partSample.from} の sample で描きました`
      : 'パーツの (f) は sample を取れなかったので空の sample で描きました',
  );
  const parts = items.map((p) => measurePart(p, partSample?.sample ?? {}));
  return { templates, parts, notes };
}

// ── 5. 集計と出力 ──

/** 種類ごとの「該当した数」と「件数の合計」。 */
type Tally = Record<string, { items: number; count: number }>;

function addTally(t: Tally, key: string, count: number) {
  if (count === 0) return;
  const cur = t[key] ?? { items: 0, count: 0 };
  t[key] = { items: cur.items + 1, count: cur.count + count };
}

function tallyCodes(issues: readonly IssueHit[], into: Tally) {
  const by: Record<string, number> = {};
  for (const i of issues) by[i.code] = (by[i.code] ?? 0) + 1;
  for (const [k, n] of Object.entries(by)) addTally(into, k, n);
}

const partLabel = (p: PartMeasure) => `${p.name} (${p.id})`;

/** 置き場ひとつ分のテンプレートの集計。 */
function templateStats(list: readonly TemplateMeasure[]) {
  const issues: Tally = {};
  const units: Tally = {};
  for (const t of list) {
    tallyCodes(t.issues, issues);
    for (const [k, n] of Object.entries(t.jinjaUnitKinds)) addTally(units, k, n);
  }
  const ok = list.flatMap((t) => (t.render.ok ? [t.render] : []));
  return {
    total: list.length,
    issues,
    units,
    withIssues: list.filter((t) => t.issues.length > 0).map(templateLabel),
    renderFailed: list.filter((t) => !t.render.ok).map(templateLabel),
    withUnrendered: ok.filter((x) => x.unrendered > 0).length,
    unrenderedTotal: ok.reduce((s, x) => s + x.unrendered, 0),
    withUnits: list.filter((t) => Object.keys(t.jinjaUnitKinds).length > 0).length,
    slowestRenderMs: ok.reduce((s, x) => Math.max(s, x.ms), 0),
  };
}

export function summarize(r: MeasureResult) {
  const bySource = {
    templates: templateStats(r.templates.filter((t) => t.source === 'templates')),
    pending: templateStats(r.templates.filter((t) => t.source === 'pending')),
  };
  const partIssues: Tally = {};
  const partUnits: Tally = {};
  for (const p of r.parts) {
    tallyCodes(p.issues, partIssues);
    const by: Record<string, number> = {};
    for (const u of p.jinjaUnits) by[kindOf(u)] = (by[kindOf(u)] ?? 0) + 1;
    for (const [k, n] of Object.entries(by)) addTally(partUnits, k, n);
  }
  return {
    bySource,
    partIssues,
    partUnits,
    templatesWithIssues: [...bySource.templates.withIssues, ...bySource.pending.withIssues],
    templatesRenderFailed: [...bySource.templates.renderFailed, ...bySource.pending.renderFailed],
    partsWithIssues: r.parts.filter((p) => p.issues.length > 0).map(partLabel),
    partsWithJinjaUnits: r.parts.filter((p) => p.jinjaUnits.length > 0).map(partLabel),
    partsWithOtherUnits: r.parts.filter((p) => p.otherUnits > 0).map(partLabel),
    partsWithUnrendered: r.parts.filter((p) => p.unrendered > 0).map(partLabel),
    partUnrenderedTotal: r.parts.reduce((s, p) => s + p.unrendered, 0),
    partsErrored: r.parts.filter((p) => p.error !== undefined).map(partLabel),
  };
}

/** 全角を 2 桁に数えて右を詰める(写真で列が揃うように)。 */
function padW(s: string, width: number): string {
  let w = 0;
  for (const ch of s) w += (ch.codePointAt(0) ?? 0) > 0xff ? 2 : 1;
  return s + ' '.repeat(Math.max(0, width - w));
}

/** 表の 1 行。列は右寄せの 11 桁(`templates/` の見出しが収まる幅)。 */
const row = (label: string, ...cols: (number | string)[]) =>
  `  ${padW(label, 44)}${cols.map((c) => String(c).padStart(11)).join('')}`.trimEnd();

function tallyRows(t: Tally): string[] {
  return Object.entries(t)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([k, v]) => row(`    ${k}`, v.items, v.count));
}

type Stats = ReturnType<typeof templateStats>;

/** テンプレートの種類別の行。列は templates/ の本数・pending/ の本数・件数の合計。 */
function tallyRows2(a: Tally, b: Tally): string[] {
  return [...new Set([...Object.keys(a), ...Object.keys(b)])]
    .sort((x, y) => x.localeCompare(y))
    .map((k) =>
      row(`    ${k}`, a[k]?.items ?? 0, b[k]?.items ?? 0, (a[k]?.count ?? 0) + (b[k]?.count ?? 0)),
    );
}

/** テンプレートの表の 1 行(置き場ごとの本数と、`sum` があれば合計の件数)。 */
const row2 = (
  label: string,
  t: Stats,
  p: Stats,
  pick: (s: Stats) => number,
  sum?: (s: Stats) => number,
) => row(label, pick(t), pick(p), sum ? sum(t) + sum(p) : '');

function nameList(title: string, names: readonly string[]): string[] {
  if (names.length === 0) return [`${title}: なし`];
  const head = names.slice(0, SCREEN_NAMES).map((n, i) => `  ${String(i + 1).padStart(2)}. ${n}`);
  const rest = names.length > SCREEN_NAMES ? [`  ほか ${names.length - SCREEN_NAMES} 件`] : [];
  return [`${title}(${names.length} 件。先頭 ${SCREEN_NAMES} 件):`, ...head, ...rest];
}

const uniq = (xs: readonly string[]) => [...new Set(xs)];

/** 画面の要約。件数の表と、違反のあったテンプレート・パーツの名前の先頭 20 件。 */
export function formatScreen(r: MeasureResult, reportFile: string): string {
  const s = summarize(r);
  const { templates: t, pending: p } = s.bySource;
  return [
    '==== 作成経路の受付の検査・不変ゲートの計測 ====',
    `テンプレート ${r.templates.length} 本(templates/ ${t.total}・pending/ ${p.total})` +
      ` / パーツ ${r.parts.length} 件`,
    '',
    row('[テンプレート]', 'templates/', 'pending/', '合計件数'),
    row2('(a) 原文の検査の違反(作成経路で申請できない)', t, p, (x) => x.withIssues.length),
    ...tallyRows2(t.issues, p.issues),
    row2('(b) 自身を基準にした受付の描画が 400', t, p, (x) => x.renderFailed.length),
    row2(
      '    通ったが値で描けない式あり(unrendered)',
      t,
      p,
      (x) => x.withUnrendered,
      (x) => x.unrenderedTotal,
    ),
    row('    受付の描画の最長(ミリ秒)', t.slowestRenderMs, p.slowestRenderMs),
    row2('(c) jinja で始まる単位(参考)', t, p, (x) => x.withUnits),
    ...tallyRows2(t.units, p.units),
    '',
    row('[パーツ]', '件数', '合計件数'),
    row('(d) body に挿入したときの違反', s.partsWithIssues.length, ''),
    ...tallyRows(s.partIssues),
    row('(e) jinja で始まる単位(新しく挿入で拒否)', s.partsWithJinjaUnits.length, ''),
    ...tallyRows(s.partUnits),
    row('    参考: jinja 以外の実行面(同じく拒否)', s.partsWithOtherUnits.length, ''),
    row('(f) 値で描けず原文の文字になる式', s.partsWithUnrendered.length, s.partUnrenderedTotal),
    row('    Jinja として読めない', s.partsErrored.length, ''),
    '',
    ...nameList(
      '違反のあったテンプレート (a)(b)',
      uniq([...s.templatesWithIssues, ...s.templatesRenderFailed]),
    ),
    '',
    ...nameList(
      '違反のあったパーツ (d)(e)',
      uniq([...s.partsWithIssues, ...s.partsWithJinjaUnits]),
    ),
    '',
    ...r.notes.map((n) => `注: ${n}`),
    `詳細: ${reportFile}`,
  ].join('\n');
}

function issueLines(issues: readonly IssueHit[]): string[] {
  const shown = issues
    .slice(0, MAX_ISSUES_PER_ITEM)
    .map((i) => `      ${i.code} @${i.at}  ${i.excerpt}`);
  const rest = issues.length - shown.length;
  return rest > 0 ? [...shown, `      ほか ${rest} 件`] : shown;
}

/** 詳細のレポート。何か見つかった物だけを、抜粋と原文の先頭数件で書く(全文は書かない)。 */
export function formatReport(r: MeasureResult): string {
  const out: string[] = [formatScreen(r, '(このファイル)'), '', '==== テンプレートの詳細 ===='];
  for (const t of r.templates) {
    const kinds = Object.entries(t.jinjaUnitKinds);
    const found =
      t.issues.length > 0 ||
      !t.render.ok ||
      kinds.length > 0 ||
      (t.render.ok && t.render.unrendered > 0);
    if (!found) continue;
    out.push(
      '',
      `■ ${templateLabel(t)}`,
      `  (a) 原文の検査の違反: ${t.issues.length} 件`,
      ...issueLines(t.issues),
    );
    if (t.render.ok) {
      out.push(
        `  (b) 受付の描画: 通過(${t.render.ms} ms)。unrendered ${t.render.unrendered} 件・` +
          `escapedSafe ${t.render.escapedSafe} 件`,
        ...t.render.unrenderedSources.map((x) => `      ${x}`),
      );
    } else {
      out.push(`  (b) 受付の描画: 400  ${clip(t.render.reason, 300)}`);
    }
    out.push(
      `  (c) jinja で始まる単位: ${kinds.map(([k, n]) => `${k} ${n}`).join('・') || 'なし'}`,
      ...t.jinjaUnitSamples.map((u) => `      ${u}`),
    );
  }
  out.push('', '==== パーツの詳細 ====');
  for (const p of r.parts) {
    const found =
      p.issues.length > 0 ||
      p.jinjaUnits.length > 0 ||
      p.otherUnits > 0 ||
      p.unrendered > 0 ||
      p.error !== undefined;
    if (!found) continue;
    out.push(
      '',
      `■ ${partLabel(p)}`,
      `  (d) 挿入したときの違反: ${p.issues.length} 件`,
      ...issueLines(p.issues),
      `  (e) jinja で始まる単位: ${p.jinjaUnits.length} 件(jinja 以外の実行面 ${p.otherUnits} 件)`,
      ...p.jinjaUnits.slice(0, MAX_SOURCES_PER_ITEM).map((u) => `      ${u}`),
      `  (f) 値で描けない式: ${p.unrendered} 件`,
      ...p.unrenderedSources.map((x) => `      ${x}`),
      ...(p.error !== undefined ? [`  読めない: ${clip(p.error, 300)}`] : []),
    );
  }
  return `${out.join('\n')}\n`;
}

const isInside = (dir: string, root: string) => {
  const rel = path.relative(path.resolve(root).toLowerCase(), path.resolve(dir).toLowerCase());
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
};

/**
 * レポートを `<outDir>/report.txt` に新しく書く。dataRoot(とその配下の置き場)の中には書かない。
 * 既にあれば上書きせずに失敗する。
 */
export async function writeReport(
  outDir: string,
  text: string,
  forbiddenRoots: readonly string[],
): Promise<string> {
  for (const root of forbiddenRoots)
    if (isInside(outDir, root))
      throw new Error(
        `出力先が dataRoot の中です。--out で dataRoot の外を指定してください: ${outDir}`,
      );
  await fs.mkdir(outDir, { recursive: true });
  const file = path.join(outDir, 'report.txt');
  await fs.writeFile(file, text, { encoding: 'utf8', flag: 'wx' });
  return file;
}

// ── 6. 起動 ──

const stamp = (d: Date) => {
  const z = (n: number) => String(n).padStart(2, '0');
  const date = `${d.getFullYear()}${z(d.getMonth() + 1)}${z(d.getDate())}`;
  return `${date}-${z(d.getHours())}${z(d.getMinutes())}${z(d.getSeconds())}`;
};

/** 引数は `--out <フォルダ>` だけ。既定は展開先(リポジトリの直下)の `bk/measure-<日時>`。 */
export function parseArgs(argv: readonly string[], repoRoot: string): { outDir: string } | null {
  if (argv.length === 0)
    return { outDir: path.join(repoRoot, 'bk', `measure-${stamp(new Date())}`) };
  if (argv.length === 2 && argv[0] === '--out' && argv[1]) return { outDir: path.resolve(argv[1]) };
  return null;
}

/** 展開先(このファイルの 3 つ上。`editor/server/scripts` → リポジトリの直下)。 */
const REPO_ROOT = fileURLToPath(new URL('../../../', import.meta.url));

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2), REPO_ROOT);
  if (!args) {
    console.error('使い方: measure-review-gates [--out <dataRoot の外のフォルダ>]');
    process.exit(2);
  }
  // サーバと同じ設定(appconfig.json と環境変数)で dataRoot と DB を決める。
  const { config } = await import('../src/config.js');
  const { realSproc } = await import('../src/db/sproc.js');
  const { createTemplateRepo } = await import('../src/repositories/templateRepo.js');
  const { createPartRepo } = await import('../src/repositories/partRepo.js');
  const { listTemplateFiles } = await import('../src/files/templateFiles.js');
  const { listPendingIds, readPending } = await import('../src/files/pendingFiles.js');
  console.log(`dataRoot  : ${config.dataRoot}`);
  console.log(`templates : ${config.templatesDir}`);
  console.log(`pending   : ${config.pendingDir}`);
  console.log(`DB        : ${config.db.server} / ${config.db.name}`);
  const sproc = readOnlySproc(realSproc);
  const result = await runMeasure({
    listTemplateFiles,
    listPendingIds,
    readPending,
    templates: createTemplateRepo(sproc),
    parts: createPartRepo(sproc),
  });
  let file: string;
  try {
    file = await writeReport(args.outDir, formatReport(result), [
      config.dataRoot,
      config.templatesDir,
    ]);
  } catch (e) {
    console.log(formatScreen(result, '(書けませんでした)'));
    console.error(`レポートを書けませんでした: ${errorText(e)}`);
    process.exit(1);
  }
  console.log(formatScreen(result, file));
  process.exit(0);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href)
  main().catch((e: unknown) => {
    console.error(`計測を中断しました(DB・ファイルは変えていません): ${errorText(e)}`);
    process.exit(1);
  });
