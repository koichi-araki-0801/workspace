// =============================================================================
// fillAnalysis.ts — 作成タブの往復で印を置けない位置を、原文の上で見つける
// =============================================================================
// `toFilled` は範囲の印を HTML コメントで、単独のトークンをチップで表す。ところが表の行の間の
// テキスト、SVG の中、開始タグの中、生テキスト要素の中などは、HTML パーサや GrapesJS が中身を
// 動かす・消すため、印やチップを置いても往復で原文に戻らない。ここでは、そうした位置を持つ
// 最小の安全な祖先(表・SVG・親要素、最後は本文全体)を「固める要素」として決める。
// 判定は字句解析(`jinjaLex.ts`)と HTML 走査(`htmlScan.ts`)の結果だけで行い、原文を書き換えた
// 文字列の上では位置を数えない。描画は呼び出し側(`fillJinja.ts`)が受け持つ。

import { type HtmlScan, maskJinja, type ScannedElement, scanHtml } from './htmlScan';
import {
  type JinjaBranch,
  type JinjaNode,
  type JinjaToken,
  lexJinja,
  type ParseResult,
  parseJinja,
} from './jinjaLex';

// ── 1. 型 ──

export type FreezeReason =
  | 'rawtext'
  | 'svg'
  | 'table-gap'
  | 'select-gap'
  | 'tag-position'
  | 'attr-crossing'
  | 'unbalanced-branch'
  | 'opaque-block'
  | 'crossing'
  | 'parse-error'
  | 'self-check';
export interface FrozenRegion {
  start: number;
  end: number;
  tag: string;
  reason: FreezeReason;
  form: 'element' | 'element-svg' | 'chip' | 'body';
}
export interface OpaqueRegion {
  start: number;
  end: number;
  kind: 'script' | 'math';
}
export interface FillAnalysis {
  parse: ParseResult;
  scan: HtmlScan;
  /** 外側だけ。位置順。 */
  frozen: FrozenRegion[];
  /** script / math 要素と TeX。frozen の内側は含めない。位置順。 */
  opaque: OpaqueRegion[];
  /** 属性値の中にあって原文のまま残すトークンの start。 */
  attrTokens: ReadonlySet<number>;
  /** 表の文脈にあって、チップの代わりに `t` の印にするトークンの start。 */
  commentOnlyTokens: ReadonlySet<number>;
}

// ── 2. 数式 ──

// MathJax が受理する TeX 区切り: $$…$$ / \(…\) / \[…\]。(単独の `$` はマッチさせ
// ない — レポート本文の通貨表記と衝突するため。)
export const MATH_TEX_RE = /\$\$[\s\S]*?\$\$|\\\([\s\S]*?\\\)|\\\[[\s\S]*?\\\]/g;

// ── 3. 規則表 ──

/** HTML パーサがテキストや要素を表の外へ追い出す(foster parenting)親。 */
const TABLE_CONTEXT = new Set(['table', 'thead', 'tbody', 'tfoot', 'tr', 'colgroup']);
const SELECT_CONTEXT = new Set(['select', 'optgroup', 'datalist']);
/** GrapesJS が要素として保てない(本文中の `<style>` は CSS 規則へ吸い上げる)ためチップにする。 */
const CHIP_TAGS = new Set(['style', 'textarea', 'title']);

const isSpace = (c: string | undefined) =>
  c === ' ' || c === '\t' || c === '\n' || c === '\r' || c === '\f';

type Block = Extract<JinjaNode, { type: 'if' | 'for' | 'raw' | 'opaqueBlock' }>;

/** ブロックを開閉・分岐する文。 */
function blockTags(b: Block): JinjaToken[] {
  switch (b.type) {
    case 'if':
      return [...b.branches.map((br) => br.tag), b.close];
    case 'for':
      return [b.open, ...(b.elseBranch ? [b.elseBranch.tag] : []), b.close];
    default:
      return [b.open, b.close];
  }
}

/** HTML として閉じていなければならない本文の範囲。raw は中身が文字どおり出るので同じ扱い。 */
function bodies(b: Block): { start: number; end: number }[] {
  const of = (br: JinjaBranch) => ({ start: br.bodyStart, end: br.bodyEnd });
  if (b.type === 'if') return b.branches.map(of);
  if (b.type === 'for') return [of(b.body), ...(b.elseBranch ? [of(b.elseBranch)] : [])];
  if (b.type === 'raw') return [{ start: b.open.end, end: b.close.start }];
  return [];
}

function collect(nodes: readonly JinjaNode[], blocks: Block[], singles: JinjaToken[]): void {
  for (const n of nodes) {
    if (n.type === 'text') continue;
    if (n.type === 'token') {
      singles.push(n.token);
      continue;
    }
    blocks.push(n);
    if (n.type === 'if') for (const br of n.branches) collect(br.children, blocks, singles);
    if (n.type === 'for') {
      collect(n.body.children, blocks, singles);
      if (n.elseBranch) collect(n.elseBranch.children, blocks, singles);
    }
  }
}

function* ancestors(el: ScannedElement | null): Generator<ScannedElement> {
  for (let e = el; e; e = e.parent) yield e;
}

function outermost(el: ScannedElement | null, test: (e: ScannedElement) => boolean) {
  let hit: ScannedElement | null = null;
  for (const e of ancestors(el)) if (test(e)) hit = e;
  return hit;
}

function nearest(el: ScannedElement | null, test: (e: ScannedElement) => boolean) {
  for (const e of ancestors(el)) if (test(e)) return e;
  return null;
}

const isOpaqueElement = (e: ScannedElement) =>
  (e.tag === 'script' && e.foreign === null) || e.tag === 'math';

// ── 4. 判定 ──

interface Candidate {
  el: ScannedElement | null;
  reason: FreezeReason;
}

/** トークン 1 個の位置の情報。 */
interface TokenInfo {
  tok: JinjaToken;
  ctx: ReturnType<HtmlScan['contextAt']>;
  el: ScannedElement | null;
  /** 同じ領域に収まるかを比べる識別子。コメント・生テキスト要素・script / math 要素。 */
  region: object | null;
  /** `</` の直後(ブラウザが `>` まで読み捨てる)。印もチップも置けない。 */
  fake: boolean;
}

export function analyzeFill(raw: string): FillAnalysis {
  const parse = parseJinja(raw);
  if (!parse.ok) {
    const lexed = lexJinja(raw);
    return {
      parse,
      scan: scanHtml(lexed.ok ? maskJinja(raw, lexed.tokens) : raw),
      frozen: [{ start: 0, end: raw.length, tag: 'body', reason: 'parse-error', form: 'body' }],
      opaque: [],
      attrTokens: new Set(),
      commentOnlyTokens: new Set(),
    };
  }
  const masked = maskJinja(raw, parse.tokens);
  const scan = scanHtml(masked);

  const blocks: Block[] = [];
  const singles: JinjaToken[] = [];
  collect(parse.nodes, blocks, singles);

  const info = new Map<number, TokenInfo>();
  for (const tok of parse.tokens) {
    const ctx = scan.contextAt(tok.start);
    const el =
      ctx.kind === 'text'
        ? ctx.parent
        : ctx.kind === 'htmlComment'
          ? scan.innermostContaining(tok.start, tok.end)
          : ctx.element;
    // script / math の中ならコメントもそれに含める(要素ごと原文のまま運ぶので)。
    let region: object | null =
      ctx.kind === 'rawText' ? ctx.element : outermost(el, isOpaqueElement);
    let fake = false;
    if (ctx.kind === 'htmlComment' && region === null) {
      region = ctx;
      fake = masked.startsWith('</', masked.lastIndexOf('<', tok.start));
    }
    info.set(tok.start, { tok, ctx, el, region, fake });
  }
  const at = (t: JinjaToken) => info.get(t.start) as TokenInfo;
  /** コメント・生テキスト・script / math の中身は原文のまま運ばれるので、ほかの判定から外す。 */
  const sealed = (i: TokenInfo) => i.region !== null && !i.fake;
  const crosses = (b: Block) => new Set(blockTags(b).map((t) => at(t).region)).size > 1;

  const cands: Candidate[] = [];
  const add = (el: ScannedElement | null, reason: FreezeReason) => cands.push({ el, reason });
  const attrTokens = new Set<number>();
  const commentOnly = new Set<number>();

  // 生テキスト要素の中。script は opaque として要素ごと運ぶので固めない。
  for (const i of info.values()) {
    if (i.ctx.kind === 'rawText' && CHIP_TAGS.has(i.ctx.element.tag)) add(i.el, 'rawtext');
  }

  // SVG の中の、属性値以外のトークン(ブロックの文を含む)。
  for (const i of info.values()) {
    if (sealed(i) || i.ctx.kind === 'attrValue') continue;
    const svg = outermost(i.el, (e) => e.tag === 'svg');
    if (svg) add(svg, 'svg');
  }

  // 表・select の子として置かれる出力とテキスト。範囲を持たない文と Jinja コメントは `t` の印で済む。
  const gapTarget = (parent: ScannedElement | null): Candidate | null => {
    if (!parent || outermost(parent, isOpaqueElement)) return null;
    if (TABLE_CONTEXT.has(parent.tag))
      return { el: nearest(parent, (e) => e.tag === 'table'), reason: 'table-gap' };
    if (SELECT_CONTEXT.has(parent.tag))
      return {
        el: nearest(parent, (e) => e.tag === 'select' || e.tag === 'datalist'),
        reason: 'select-gap',
      };
    return null;
  };
  for (const t of singles) {
    const i = at(t);
    if (sealed(i) || i.ctx.kind !== 'text') continue;
    const g = gapTarget(i.ctx.parent);
    if (!g) continue;
    if (t.kind === 'output') add(g.el, g.reason);
    else commentOnly.add(t.start);
  }
  let pos = 0;
  for (const t of [...parse.tokens, { start: raw.length, end: raw.length }]) {
    for (; pos < t.start; pos++) {
      if (isSpace(raw[pos])) continue;
      const ctx = scan.contextAt(pos);
      const g = ctx.kind === 'text' ? gapTarget(ctx.parent) : null;
      if (g) add(g.el, g.reason);
    }
    pos = t.end;
  }

  // 開始・終了タグの中の、引用符で囲んだ属性値以外の位置。
  for (const i of info.values()) {
    if (sealed(i)) continue;
    if (i.ctx.kind === 'tagOther' || i.fake) add(i.el, 'tag-position');
    else if (i.ctx.kind === 'attrValue') attrTokens.add(i.tok.start);
  }

  // 属性値の中のブロック。全部が同じ 1 個の値に収まれば原文のまま残す。
  const inAttr = new Set<Block>();
  for (const b of blocks) {
    const tags = blockTags(b).map(at);
    if (tags.every(sealed)) continue;
    const ctxs = tags.filter((i) => i.ctx.kind === 'attrValue').map((i) => i.ctx);
    if (ctxs.length === 0) continue;
    inAttr.add(b);
    if (ctxs.length === tags.length && new Set(ctxs).size === 1) {
      for (const t of parse.tokens)
        if (t.start >= b.start && t.end <= b.end) attrTokens.add(t.start);
    } else add(smallestCovering(scan, b.start, b.end), 'attr-crossing');
  }

  // 枝の本文が HTML として閉じていない。
  for (const b of blocks) {
    if (inAttr.has(b) || crosses(b) || blockTags(b).every((t) => sealed(at(t)))) continue;
    const broken = bodies(b).some(({ start, end }) =>
      scan.elements.some(
        (e) =>
          (e.start >= start && e.start < end && e.end > end) ||
          (e.start < start && e.end > start && e.end <= end),
      ),
    );
    if (broken) add(scan.innermostContaining(b.start, b.end), 'unbalanced-branch');
  }

  // 中身を描かないブロックと、表の文脈で中身が文字どおり出る raw。
  for (const b of blocks) {
    if ((b.type !== 'raw' && b.type !== 'opaqueBlock') || crosses(b)) continue;
    const i = at(b.open);
    if (sealed(i)) continue;
    const tableRaw = b.type === 'raw' && i.ctx.kind === 'text' && gapTarget(i.ctx.parent) !== null;
    if (b.type === 'opaqueBlock' || tableRaw)
      add(scan.innermostContaining(b.start, b.end), 'opaque-block');
  }

  // コメント・生テキスト要素・script / math の境界をまたぐブロック。
  for (const b of blocks) {
    if (crosses(b)) add(scan.innermostContaining(b.start, b.end), 'crossing');
  }

  const frozen = outerOnly(cands.map((c) => toRegion(c, raw.length)));
  const isFrozen = (s: number, e: number) => frozen.some((f) => f.start <= s && e <= f.end);
  const notFrozen = (set: Set<number>) =>
    new Set(
      [...set]
        .sort((a, b) => a - b)
        .filter((s) => !isFrozen(s, (info.get(s) as TokenInfo).tok.end)),
    );
  return {
    parse,
    scan,
    frozen,
    opaque: findOpaque(raw, scan, parse.tokens, blocks).filter((o) => !isFrozen(o.start, o.end)),
    attrTokens: notFrozen(attrTokens),
    commentOnlyTokens: notFrozen(commentOnly),
  };
}

/** 範囲をタグごと含む最も狭い要素。属性値をまたぐブロックは開始タグの中から始まるため。 */
function smallestCovering(scan: HtmlScan, start: number, end: number): ScannedElement | null {
  let best: ScannedElement | null = null;
  for (const e of scan.elements) {
    if (e.start <= start && end <= e.end && (!best || e.end - e.start <= best.end - best.start))
      best = e;
  }
  return best;
}

// ── 5. 固める範囲 ──

function toRegion({ el, reason }: Candidate, len: number): FrozenRegion {
  // SVG の内側の要素だけを固めると、外側の svg を GrapesJS が組み直すときに崩れるため、外側まで広げる。
  const svg = outermost(el, (e) => e.tag === 'svg');
  const target = svg ?? el;
  if (!target || target.tag === 'body' || target.tag === 'html')
    return { start: 0, end: len, tag: 'body', reason, form: 'body' };
  const form = svg ? 'element-svg' : CHIP_TAGS.has(target.tag) ? 'chip' : 'element';
  return { start: target.start, end: target.end, tag: target.tag, reason, form };
}

/**
 * 入れ子を外側だけにする。固める範囲は原文の上で静的に決まり、外側を固めても内側の判定の
 * 根拠は消えないので、1 回で集めた候補の外側を取れば繰り返しても変わらない。
 * 同じ範囲は先に見つかった理由(規則表の順)を残す。
 */
function outerOnly(regions: FrozenRegion[]): FrozenRegion[] {
  const sorted = regions
    .map((r, idx) => ({ r, idx }))
    .sort((a, b) => a.r.start - b.r.start || b.r.end - a.r.end || a.idx - b.idx);
  const out: FrozenRegion[] = [];
  for (const { r } of sorted) {
    const last = out[out.length - 1];
    if (last && r.start >= last.start && r.end <= last.end) continue;
    out.push(r);
  }
  return out;
}

// ── 6. script と数式 ──

function findOpaque(
  raw: string,
  scan: HtmlScan,
  tokens: readonly JinjaToken[],
  blocks: readonly Block[],
): OpaqueRegion[] {
  const out: OpaqueRegion[] = [];
  for (const e of scan.elements) {
    if (e.tag === 'script' && e.foreign === null)
      out.push({ start: e.start, end: e.end, kind: 'script' });
    else if (e.tag === 'math' && !nearest(e.parent, (p) => p.tag === 'math'))
      out.push({ start: e.start, end: e.end, kind: 'math' });
  }
  const branchTags = blocks.flatMap(blockTags);
  for (const m of raw.matchAll(MATH_TEX_RE)) {
    const start = m.index;
    const end = start + m[0].length;
    const ctx = scan.contextAt(start);
    const overlaps = (t: { start: number; end: number }) => t.start < end && start < t.end;
    if (ctx.kind !== 'text' || m[0].includes('<')) continue;
    if (nearest(ctx.parent, (e) => e.tag === 'math')) continue;
    if (branchTags.some(overlaps)) continue;
    // 範囲の端がトークンの途中にあるものは、TeX ではなくトークンの中身。
    if (tokens.some((t) => overlaps(t) && (t.start < start || t.end > end))) continue;
    if (out.some(overlaps)) continue;
    out.push({ start, end, kind: 'math' });
  }
  return out.sort((a, b) => a.start - b.start);
}
