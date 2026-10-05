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
    });
    expect(r.conflicts).toEqual([]);
  });

  it('ペア側に無い規則の変更も競合(Task 3 の判定のまま)', () => {
    const r = computeCssSync({
      base: '.a{x:1}',
      baseline: '.a{x:1}',
      next: '.a{x:2}',
      target: '.t{z:1}',
      prev: [],
      now: NOW,
    });
    expect(r.css).toBeNull();
    expect(r.conflicts).toEqual([{ ruleKey: k('.a'), detectedAt: NOW }]);
  });

  it('空のペア側への追加は写す', () => {
    const r = computeCssSync({
      base: '',
      baseline: '',
      next: '.a{x:1}',
      target: '',
      prev: [],
      now: NOW,
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
    });
    expect(r.css).toBeNull();
    expect(r.skipped).toEqual([k('.cover-title')]);
    expect(r.conflicts).toEqual([{ ruleKey: k('.cover-title'), detectedAt: NOW }]);
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
