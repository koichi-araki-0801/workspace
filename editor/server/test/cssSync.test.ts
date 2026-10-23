// =============================================================================
// cssSync.test.ts — ペア同期の CSS 転写(3 者比較の結果と競合の持ち越し)
// =============================================================================
import { describe, expect, it } from 'vitest';
import { computeCssSync, cssSyncPairKey } from '../src/sync/cssSync.js';

const NOW = '2026-10-05T00:00:00.000Z';
const LATER = '2026-10-06T00:00:00.000Z';
/** 規則のキー(`splitCssRules` の形: 入れ子の前置き・識別子・2 番目以降の出現番号の JSON 配列)。 */
const k = (...parts: Array<string | number>): string => JSON.stringify(parts);

describe('computeCssSync', () => {
  it('承認で変わった規則だけをペアへ写し、ペア固有に直した別の規則は残す', () => {
    const r = computeCssSync({
      base: '.a{color:red}\n.b{color:blue}',
      baseline: '.a{color:red}\n.b{color:blue}',
      next: '.a{color:green}\n.b{color:blue}',
      target: '.a{color:red}\n.b{color:navy}',
      prev: [],
      now: NOW,
      sourceEdition: '交付版',
    });
    expect(r.ran).toBe(true);
    expect(r.css).toContain('.a{color:green}');
    expect(r.css).toContain('.b{color:navy}');
    expect(r.applied).toEqual([k('.a')]);
    expect(r.skipped).toEqual([]);
    expect(r.conflicts).toEqual([]);
  });

  it('ペア側が承認前と違う規則は競合として飛ばし、CSS は書かない', () => {
    const r = computeCssSync({
      base: '.a{color:red}',
      baseline: '.a{color:red}',
      next: '.a{color:green}',
      target: '.a{color:black}',
      prev: [],
      now: NOW,
      sourceEdition: '交付版',
    });
    expect(r.css).toBeNull();
    expect(r.skipped).toEqual([k('.a')]);
    expect(r.conflicts).toEqual([{ ruleKey: k('.a'), detectedAt: NOW }]);
    expect(r.conflictsChanged).toBe(true);
  });

  it('承認で CSS が変わらなければ何もしない(ran=false)', () => {
    const r = computeCssSync({
      base: '.a{}',
      baseline: '.a{}',
      next: '.a{}',
      target: '.a{x:1}',
      prev: [],
      now: NOW,
      sourceEdition: '交付版',
    });
    expect(r).toMatchObject({ ran: false, css: null, applied: [], skipped: [], conflicts: [] });
    expect(r.conflictsChanged).toBe(false);
  });

  it('未解決の競合は、両版の規則がまだ違えば検出時刻ごと持ち越す', () => {
    const prev = [{ ruleKey: k('.a'), detectedAt: NOW }];
    const r = computeCssSync({
      base: '.a{color:green}\n.b{x:1}',
      baseline: '.a{color:green}\n.b{x:1}',
      next: '.a{color:green}\n.b{x:2}',
      target: '.a{color:black}\n.b{x:1}',
      prev,
      now: LATER,
      sourceEdition: '交付版',
    });
    expect(r.conflicts).toEqual(prev);
    expect(r.conflictsChanged).toBe(false);
  });

  it('両版の規則が一致したら競合を消す', () => {
    const r = computeCssSync({
      base: '.a{color:green}',
      baseline: '.a{color:green}',
      next: '.a{color:green}',
      target: '.a{color:green}',
      prev: [{ ruleKey: k('.a'), detectedAt: NOW }],
      now: LATER,
      sourceEdition: '交付版',
    });
    expect(r.conflicts).toEqual([]);
    expect(r.conflictsChanged).toBe(true);
  });

  it('空白の違いだけなら一致と見なす', () => {
    const r = computeCssSync({
      base: '.a{x:1}',
      baseline: '.a{x:1}',
      next: '.a{x:1}',
      target: '.a { x:1 }',
      prev: [{ ruleKey: k('.a'), detectedAt: NOW }],
      now: LATER,
      sourceEdition: '交付版',
    });
    expect(r.conflicts).toEqual([]);
  });

  it('ペア側に無い規則の変更も競合', () => {
    const r = computeCssSync({
      base: '.a{x:1}',
      baseline: '.a{x:1}',
      next: '.a{x:2}',
      target: '.t{z:1}',
      prev: [],
      now: NOW,
      sourceEdition: '交付版',
    });
    expect(r.css).toBeNull();
    expect(r.conflicts).toEqual([{ ruleKey: k('.a'), detectedAt: NOW }]);
  });

  it('ペア側で重複した規則は、畳んだ形が承認後と同じなら競合を解く', () => {
    const r = computeCssSync({
      base: '.a{color:red}',
      baseline: '.a{color:red;}',
      next: '.a{color:blue;margin:0;}',
      target: '.a{color:blue}\n.a{margin:0}\n',
      prev: [{ ruleKey: k('.a'), detectedAt: NOW }],
      now: LATER,
      sourceEdition: '交付版',
    });
    expect(r.conflicts).toEqual([]);
    expect(r.conflictsChanged).toBe(true);
  });

  it('空のペア側への追加は写す', () => {
    const r = computeCssSync({
      base: '',
      baseline: '',
      next: '.a{x:1}',
      target: '',
      prev: [],
      now: NOW,
      sourceEdition: '交付版',
    });
    expect(r.css).toBe('.a{x:1}\n');
    expect(r.applied).toEqual([k('.a')]);
  });

  // base は外部ツールが書いたディスク上の CSS(整形あり)、next は GrapesJS の getCss() 出力
  // (整形なし・ブロック最後の `;` あり)。内容が同じ規則は書式が違っても「変わっていない」。
  const EXTERNAL_BASE = '.a {\n  color: red;\n  margin: 0;\n}\n\n.b {\n  color: blue;\n}\n';
  const GRAPES_NEXT_SAME = '.a{color:red;margin:0;}.b{color:blue;}';

  it('書式だけ違う規則は転写しない(外部ツール形の base と getCss 形の next)', () => {
    const r = computeCssSync({
      base: EXTERNAL_BASE,
      baseline: EXTERNAL_BASE,
      next: GRAPES_NEXT_SAME,
      target: '.a {\n  color: navy;\n}\n\n.b {\n  color: blue;\n}\n',
      prev: [],
      now: NOW,
      sourceEdition: '交付版',
    });
    // 文字列は違う(ran)が、規則は 1 つも変わっていない。ペアの CSS は書かず、競合も作らない。
    expect(r.ran).toBe(true);
    expect(r.css).toBeNull();
    expect(r.applied).toEqual([]);
    expect(r.skipped).toEqual([]);
    expect(r.conflicts).toEqual([]);
  });

  it('書式が違う中で実際に変わった規則だけを写し、ペア固有の規則は残す', () => {
    const r = computeCssSync({
      base: EXTERNAL_BASE,
      baseline: EXTERNAL_BASE,
      next: '.a{color:red;margin:0;}.b{color:green;}',
      target: '.a {\n  color: navy;\n}\n\n.b {\n  color: blue;\n}\n',
      prev: [],
      now: NOW,
      sourceEdition: '交付版',
    });
    expect(r.applied).toEqual([k('.b')]);
    expect(r.skipped).toEqual([]);
    expect(r.css).toContain('.b{color:green;}');
    expect(r.css).toContain('color: navy');
    expect(r.css).not.toContain('color: blue');
  });

  it('書式だけ違う未解決の競合は、両版が一致したものとして消える', () => {
    const r = computeCssSync({
      base: '.a{x:1}',
      baseline: '.a{x:1}',
      next: '.a{x:1;}',
      target: '.a {\n  x: 1;\n}\n',
      prev: [{ ruleKey: k('.a'), detectedAt: NOW }],
      now: LATER,
      sourceEdition: '交付版',
    });
    expect(r.conflicts).toEqual([]);
    expect(r.conflictsChanged).toBe(true);
  });

  // ペア側・承認前の CSS は外部ツールが書いたもので、先頭の BOM や CRLF の改行がありうる。
  // 書式の違いとして扱い、転写と競合の判定はきれいな CSS と同じになること、転写先の BOM と
  // 改行は差し込んだ規則の外では変えないことを確かめる。
  const BOM = '﻿';

  it('BOM と CRLF を持つペア側へも、変わった規則だけを写し BOM と改行を保つ', () => {
    const target = `${BOM}.a {\r\n  color: red;\r\n}\r\n.b {\r\n  color: navy;\r\n}\r\n`;
    const r = computeCssSync({
      base: `${BOM}.a {\r\n  color: red;\r\n}\r\n.b {\r\n  color: blue;\r\n}\r\n`,
      baseline: `${BOM}.a {\r\n  color: red;\r\n}\r\n.b {\r\n  color: blue;\r\n}\r\n`,
      next: '.a{color:green;}.b{color:blue;}',
      target,
      prev: [],
      now: NOW,
      sourceEdition: '交付版',
    });
    expect(r.applied).toEqual([k('.a')]);
    expect(r.skipped).toEqual([]);
    expect(r.conflicts).toEqual([]);
    expect(r.css).toBe(`${BOM}.a{color:green;}\r\n.b {\r\n  color: navy;\r\n}\r\n`);
  });

  it('BOM と CRLF を持つペア側でも、版種固有に直した規則は競合になる', () => {
    const r = computeCssSync({
      base: `${BOM}.a {\r\n  color: red;\r\n}\r\n`,
      baseline: `${BOM}.a {\r\n  color: red;\r\n}\r\n`,
      next: '.a{color:green;}',
      target: `${BOM}.a {\r\n  color: black;\r\n}\r\n`,
      prev: [],
      now: NOW,
      sourceEdition: '交付版',
    });
    expect(r.css).toBeNull();
    expect(r.skipped).toEqual([k('.a')]);
    expect(r.conflicts).toEqual([{ ruleKey: k('.a'), detectedAt: NOW }]);
  });

  it('BOM と CRLF だけが違う CSS は規則が変わっていないものとして何も写さない', () => {
    const clean = '.a {\n  color: red;\n}\n';
    const r = computeCssSync({
      base: `${BOM}${clean.replaceAll('\n', '\r\n')}`,
      baseline: `${BOM}${clean.replaceAll('\n', '\r\n')}`,
      next: clean,
      target: `${BOM}.a {\r\n  color: red;\r\n}\r\n`,
      prev: [{ ruleKey: k('.a'), detectedAt: NOW }],
      now: LATER,
      sourceEdition: '交付版',
    });
    expect(r.ran).toBe(true);
    expect(r.css).toBeNull();
    expect(r.applied).toEqual([]);
    expect(r.conflicts).toEqual([]);
  });

  it('BOM と CRLF を持つペア側への追加は、BOM と既存の改行を残して直前の規則の後ろへ足す', () => {
    const target = `${BOM}.a {\r\n  color: red;\r\n}\r\n`;
    const r = computeCssSync({
      base: '.a{color:red}',
      baseline: '.a{color:red}',
      next: '.a{color:red}\n.z{x:1}',
      target,
      prev: [],
      now: NOW,
      sourceEdition: '交付版',
    });
    expect(r.applied).toEqual([k('.z')]);
    // 差し込んだ文字列(`\n.z{x:1}`)の外は元のまま。
    expect(r.css).toBe(`${BOM}.a {\r\n  color: red;\r\n}\n.z{x:1}\r\n`);
  });
});

describe('computeCssSync — 変わった規則は baseline(GrapesJS 形)→ next で見る', () => {
  // 外部ツールが書いた承認前の原文と、それを GrapesJS が読み込んで書き出した形。
  const RAW = '.cover-title{color:#003366}\n.page{padding:10mm}\n';
  const gjs = (color: string): string =>
    `.cover-title{color:${color};}` +
    '.page{padding-top:10mm;padding-right:10mm;padding-bottom:10mm;padding-left:10mm;}';

  it('無編集の承認はペアの CSS を書かず、版種固有に直した規則も競合にしない', () => {
    const target = RAW.replace('#003366', '#990000');
    const r = computeCssSync({
      base: RAW,
      baseline: gjs('rgb(0, 51, 102)'),
      next: gjs('rgb(0, 51, 102)'),
      target,
      prev: [],
      now: NOW,
      sourceEdition: '交付版',
    });
    expect(r).toMatchObject({ ran: false, css: null, applied: [], skipped: [], conflicts: [] });
  });

  it('編集した規則だけを写し、書き直されただけの規則には触らない', () => {
    const r = computeCssSync({
      base: RAW,
      baseline: gjs('rgb(0, 51, 102)'),
      next: gjs('rgb(0, 0, 0)'),
      target: RAW,
      prev: [],
      now: NOW,
      sourceEdition: '交付版',
    });
    expect(r.applied).toEqual([k('.cover-title')]);
    expect(r.css).toBe('.cover-title{color:rgb(0, 0, 0);}\n.page{padding:10mm}\n');
  });

  it('編集した規則をペア側が版種固有に直していれば競合にする', () => {
    const r = computeCssSync({
      base: RAW,
      baseline: gjs('rgb(0, 51, 102)'),
      next: gjs('rgb(0, 0, 0)'),
      target: RAW.replace('#003366', '#990000'),
      prev: [],
      now: NOW,
      sourceEdition: '交付版',
    });
    expect(r.css).toBeNull();
    expect(r.skipped).toEqual([k('.cover-title')]);
    expect(r.conflicts).toEqual([{ ruleKey: k('.cover-title'), detectedAt: NOW }]);
  });

  it('記録済みの競合は、無編集の承認では検出時刻ごと持ち越し、両版が同じ形になれば消える', () => {
    const prev = [{ ruleKey: k('.cover-title'), detectedAt: NOW }];
    const kept = computeCssSync({
      base: gjs('rgb(0, 0, 0)'),
      baseline: gjs('rgb(0, 0, 0)'),
      next: gjs('rgb(0, 0, 0)'),
      target: RAW.replace('#003366', '#990000'),
      prev,
      now: LATER,
      sourceEdition: '交付版',
    });
    expect(kept).toMatchObject({ ran: false, css: null, conflicts: prev, conflictsChanged: false });
    // ペア側が同じ書き出し(GrapesJS 形)になれば一致する。ペア側にだけある別の規則(.unused)は
    // 判定に関わらない — 比べるのは競合した規則のキーごと。
    const cleared = computeCssSync({
      base: gjs('rgb(0, 0, 0)'),
      baseline: gjs('rgb(0, 0, 0)'),
      next: gjs('rgb(0, 0, 0)'),
      target: `${gjs('rgb(0, 0, 0)')}\n.unused{color:red;}`,
      prev,
      now: LATER,
      sourceEdition: '交付版',
    });
    expect(cleared.conflicts).toEqual([]);
    expect(cleared.conflictsChanged).toBe(true);
  });
});

describe('computeCssSync — 照合不可', () => {
  // 展開しても合わない形(並びの中の重複は展開しない)で照合不可を作る。
  const raw = '.a, .a{color:red}\n.c{color:red}\n';
  const baseline = '.a{color:red}\n.a{color:red}\n.c{color:red}\n';
  const base = { base: raw, baseline, target: raw, now: LATER, sourceEdition: '交付版' };
  const unmatchedA = {
    ruleKey: k('.a'),
    detectedAt: NOW,
    kind: '照合不可' as const,
    sourceEdition: '交付版',
  };

  it('変更の照合不可を kind と sourceEdition つきで記録する', () => {
    const r = computeCssSync({
      ...base,
      prev: [],
      next: '.a{color:red}\n.a{color:blue}\n.c{color:red}\n',
    });
    expect(r.css).toBeNull();
    expect(r.conflicts).toEqual([
      { ruleKey: k('.a'), detectedAt: LATER, kind: '照合不可', sourceEdition: '交付版' },
    ]);
    expect(r.skipped).toEqual([k('.a')]);
    expect(r.conflictsChanged).toBe(true);
  });

  it('削除の照合不可も記録する(両版に無いから解消、としない)', () => {
    const r = computeCssSync({ ...base, prev: [], next: '.c{color:red}\n' });
    expect(r.conflicts.map((c) => [c.ruleKey, c.kind])).toEqual([[k('.a'), '照合不可']]);
    expect(r.skipped).toEqual([k('.a')]);
  });

  it('記録済みの照合不可は、同じキーを検出時刻ごと持ち越し二重に足さない', () => {
    const r = computeCssSync({ ...base, prev: [unmatchedA], next: '.c{color:red}\n' });
    expect(r.conflicts).toEqual([unmatchedA]);
    expect(r.conflictsChanged).toBe(false);
  });

  it('同じ向きの次の承認で、ペア側がまだそのキーを持たなければ残す', () => {
    // source から規則を消した後の無編集の承認。両版ともキー .a を持たないので、普通の判定なら
    // 「両版に無い = 解消」になるが、ペア側は原文の形(.a, .a)のままで突き合わせられていない。
    const deleted = '.c{color:red}\n';
    const input = { base: deleted, baseline: deleted, next: deleted, target: raw, now: LATER };
    const same = computeCssSync({ ...input, prev: [unmatchedA], sourceEdition: '交付版' });
    expect(same.conflicts).toEqual([unmatchedA]);
    // 逆向きの承認では普通の判定に戻る(両版に無いので消える)。
    const reverse = computeCssSync({ ...input, prev: [unmatchedA], sourceEdition: '全体版' });
    expect(reverse.conflicts).toEqual([]);
    expect(reverse.conflictsChanged).toBe(true);
  });

  it('同じ向きでも、ペア側がそのキーを持つようになれば普通の判定で消す', () => {
    const css = '.a{color:blue}\n.c{color:red}\n';
    const r = computeCssSync({
      base: css,
      baseline: css,
      next: css,
      target: css,
      prev: [unmatchedA],
      now: LATER,
      sourceEdition: '交付版',
    });
    expect(r.conflicts).toEqual([]);
  });

  it('逆向きの承認で、両版の規則が一致すれば消え、違えば残す', () => {
    // 元のペア側(全体版)を編集画面で承認した: next はその書き出し形、target は元の source
    // (前回の承認で書き出し形になった交付版)。
    const pair = '.a{color:blue}\n.c{color:red}\n';
    const input = { base: pair, baseline: pair, next: pair, prev: [unmatchedA], now: LATER };
    const same = computeCssSync({ ...input, target: pair, sourceEdition: '全体版' });
    expect(same.conflicts).toEqual([]);
    const differ = computeCssSync({
      ...input,
      target: '.a{color:green}\n.c{color:red}\n',
      sourceEdition: '全体版',
    });
    expect(differ.conflicts).toEqual([unmatchedA]);
  });

  it('古いキー(旧正規化)の競合を読み替えて持ち越す', () => {
    const prev = [{ ruleKey: '[".x > .y"]', detectedAt: NOW }];
    const r = computeCssSync({
      base: '.x>.y{a:1}',
      baseline: '.x>.y{a:1}',
      next: '.x>.y{a:1}',
      target: '.x>.y{a:2}',
      prev,
      now: LATER,
      sourceEdition: '交付版',
    });
    expect(r.conflicts).toEqual([{ ruleKey: k('.x>.y'), detectedAt: NOW }]);
    expect(r.conflictsChanged).toBe(true);
  });

  it('古い並びのキーの競合はセレクタごとの 2 件になり、それぞれ元の検出時刻を引き継ぐ', () => {
    const css = '.a{x:1}\n.b{y:1}';
    const r = computeCssSync({
      base: css,
      baseline: css,
      next: css,
      target: '.a{x:2}\n.b{y:2}',
      prev: [{ ruleKey: '[".a,.b"]', detectedAt: NOW }],
      now: LATER,
      sourceEdition: '交付版',
    });
    expect(r.conflicts).toEqual([
      { ruleKey: k('.a'), detectedAt: NOW },
      { ruleKey: k('.b'), detectedAt: NOW },
    ]);
  });

  it('読み替えで同じキーが 2 件になれば検出時刻の早い方を残す', () => {
    const EARLIER = '2026-10-04T00:00:00.000Z';
    const css = '.a{x:1}\n.b{y:1}';
    const r = computeCssSync({
      base: css,
      baseline: css,
      next: css,
      target: '.a{x:2}\n.b{y:2}',
      prev: [
        { ruleKey: '[".a,.b"]', detectedAt: NOW },
        { ruleKey: '[".b"]', detectedAt: EARLIER },
      ],
      now: LATER,
      sourceEdition: '交付版',
    });
    expect(r.conflicts).toEqual([
      { ruleKey: k('.a'), detectedAt: NOW },
      { ruleKey: k('.b'), detectedAt: EARLIER },
    ]);
  });

  it('今のキーとして両版のどちらかにあるキーは読み替えずに使う(大文字の at-keyword の文)', () => {
    // 文の at-rule はキーが原文の綴りのまま。読み替えると小文字になり、どちらの版にも無いキーに
    // なって「両版に無い = 解消」で黙って消える。
    const imp = '@IMPORT url("x.css");\n';
    const key = k('@IMPORT url("x.css")');
    const r = computeCssSync({
      base: imp,
      baseline: imp,
      next: imp,
      target: '',
      prev: [{ ruleKey: key, detectedAt: NOW }],
      now: LATER,
      sourceEdition: '交付版',
    });
    expect(r.conflicts).toEqual([{ ruleKey: key, detectedAt: NOW }]);
  });
});

describe('cssSyncPairKey', () => {
  it('値入り HTML(4 つ区切り)でもテンプレ(3 つ区切り)でも 会社_ファンド', () => {
    expect(cssSyncPairKey('AM01_510037_20240710_交付版')).toBe('AM01_510037');
    expect(cssSyncPairKey('AM01_510037_20250110_全体版')).toBe('AM01_510037');
    expect(cssSyncPairKey('AM01_510037_交付版')).toBe('AM01_510037');
    expect(cssSyncPairKey('../x')).toBeNull();
  });
});
