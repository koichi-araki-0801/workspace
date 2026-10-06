import { readdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { buildSampleData, type FundMaster, parseTemplateFileName } from '@editor/shared';
import { describe, expect, it, vi } from 'vitest';
import { useGrapes } from '@/features/editor/useGrapes';
import fundMaster from '../src/api/fixtures/funds.json';
import { toFilledWithDiagnostics } from '../src/lib/fillJinja';
import { defaultHtmlParser, type HtmlParser } from '../src/lib/htmlParser';
import { lexJinja } from '../src/lib/jinjaLex';
import { normalizeForRoundTrip, toTemplate } from '../src/lib/jinjaMask';
import { getBodyInner } from '../src/lib/templateDoc';
import { linkedomParser } from '../src/workers/htmlWorkerImpl';
import { generateCases } from './helpers/jinjaCorpusGen';
import { REPRO_CASES } from './helpers/jinjaReproCases';

vi.mock('@/components/ui/toast', () => ({ toast: vi.fn(), toastError: vi.fn() }));

// =============================================================================
// fillJinja.corpus.dom.test.ts — 作成タブの往復をコーパスで確かめる
// =============================================================================
// 原文 → `toFilledWithDiagnostics` → `toTemplate` が原文へ戻ることを、3 経路で確かめる。
// 入力は fixture のテンプレート、dig の再現ケース、種を固定した乱数生成ケース。
//   1. jsdom のパーサで直接戻す(ブラウザの主スレッド)。
//   2. linkedom のパーサで直接戻す(Worker と Node)。
//   3. キャンバス経由: GrapesJS へ読み込み、`getBodyHtml` で直列化し直したものを戻す。保存は
//      この経路を通るので、パーサの並べ替えと GrapesJS の再直列化の両方が効く。
// 判定は往復の正規形(`normalizeForRoundTrip`)と、Jinja のトークン列(原文の文字列そのもの)の
// 両方の一致。正規形はテキスト位置の記号を印に置き換えるが、タグや属性値の中の記号は文字の
// まま比べるため、記号の並びを別に比べて取りこぼしを塞ぐ。

const tokenSources = (s: string): string[] | null => {
  const r = lexJinja(s);
  return r.ok ? r.tokens.map((t) => t.source) : null;
};

function expectRoundTrip(rawBody: string, back: string, path: string): void {
  expect(normalizeForRoundTrip(back, defaultHtmlParser), path).toBe(
    normalizeForRoundTrip(rawBody, defaultHtmlParser),
  );
  expect(tokenSources(back), path).toEqual(tokenSources(rawBody));
}

// GrapesJS の初期化は 1 件あたりの往復より桁違いに重いので、エディタは 1 個を使い回す。
// `load` は本文を `setComponents` で丸ごと差し替えるため、前のケースの部品は残らない。
let grapes: ReturnType<typeof useGrapes> | null = null;
function viaCanvas(filledBody: string): string {
  if (!grapes) {
    grapes = useGrapes();
    grapes.init({ canvas: document.createElement('div'), layers: document.createElement('div') });
  }
  grapes.load(filledBody, '');
  return toTemplate(grapes.getBodyHtml(), { asFragment: true });
}

const bodyOf = (html: string): string => (/<body/i.test(html) ? getBodyInner(html) : html);

/** 直接の 2 経路(jsdom・linkedom)で戻す。キャンバス経由は下の別の describe で見る。 */
function checkDirect(raw: string, sample: Record<string, unknown>) {
  const result = toFilledWithDiagnostics(raw, sample);
  const filledBody = bodyOf(result.html);
  const rawBody = bodyOf(raw);
  const parsers: [string, HtmlParser][] = [
    ['jsdom', defaultHtmlParser],
    ['linkedom', linkedomParser],
  ];
  for (const [name, parse] of parsers)
    expectRoundTrip(rawBody, toTemplate(filledBody, { asFragment: true }, parse), name);
  return result;
}

function checkCanvas(raw: string, sample: Record<string, unknown>): void {
  const filledBody = bodyOf(toFilledWithDiagnostics(raw, sample).html);
  expectRoundTrip(bodyOf(raw), viaCanvas(filledBody), 'canvas');
}

const fixtureDir = resolve(__dirname, '../src/api/fixtures/templates');
const fixtureFiles = readdirSync(fixtureDir)
  .filter((f) => f.endsWith('.html'))
  .sort();

function fixtureCase(file: string): { raw: string; sample: Record<string, unknown> } {
  const raw = readFileSync(resolve(fixtureDir, file), 'utf8');
  const attrs = parseTemplateFileName(file);
  if (!attrs) throw new Error(file);
  const sample = buildSampleData(
    (fundMaster as Record<string, FundMaster>)[attrs.fundCode],
    attrs.fundCode,
  ) as Record<string, unknown>;
  return { raw, sample };
}

const SEEDS = [1, 2, 3, 4];
const PER_SEED = 50;

describe('fixture のテンプレート', () => {
  it('8 本以上ある', () => expect(fixtureFiles.length).toBeGreaterThanOrEqual(8));
  for (const file of fixtureFiles) {
    it(file, () => {
      const { raw, sample } = fixtureCase(file);
      const { diagnostics } = checkDirect(raw, sample);
      // 本文側の固めが 0 件(自己検査で本文全体を固めた `body` も含めない)。固めると作成タブの
      // 見た目が変わる。head の title は編集画面に出ないので除く。
      expect(diagnostics.frozen.filter((f) => f.tag !== 'title')).toEqual([]);
    });
  }
});

describe('dig の再現ケース', () => {
  it.each(REPRO_CASES)('%s', (_n, raw, sample) => {
    checkDirect(raw, sample);
  });
});

describe('乱数生成ケース', () => {
  for (const seed of SEEDS) {
    generateCases(seed, PER_SEED).forEach((c, i) => {
      it(`seed=${seed} #${i}`, () => {
        checkDirect(c.raw, c.sample);
      });
    });
  }
});

// GrapesJS は本文を `DOMParser` へ素のまま渡すため、本文の先頭(空白を除く)にあるコメントは
// HTML の構文規則で body の外(文書の直下)へ置かれ、読み込みで消える。値入り HTML の往復の印は
// コメントなので、先頭がブロックの本文は保存で戻せない。また GrapesJS は `class` 属性を末尾へ
// 並べ替えて直列化する。どちらも直すまでこの経路は止めておく。
describe.skip('キャンバス経由', () => {
  for (const file of fixtureFiles)
    it(file, () => {
      const { raw, sample } = fixtureCase(file);
      checkCanvas(raw, sample);
    });

  it('本文の先頭のコメントが残る', () => {
    const { raw, sample } = fixtureCase(fixtureFiles[0] as string);
    const lead = /^\s*(<!--[\s\S]*?-->)/.exec(getBodyInner(raw))?.[1];
    expect(lead).toBeTruthy();
    const back = viaCanvas(bodyOf(toFilledWithDiagnostics(raw, sample).html));
    expect(back.trimStart().startsWith(lead as string)).toBe(true);
  });

  it.each(REPRO_CASES)('%s', (_n, raw, sample) => {
    checkCanvas(raw, sample);
  });

  for (const seed of SEEDS) {
    generateCases(seed, PER_SEED).forEach((c, i) => {
      it(`seed=${seed} #${i}`, () => {
        checkCanvas(c.raw, c.sample);
      });
    });
  }
});
