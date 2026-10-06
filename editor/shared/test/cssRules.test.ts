// =============================================================================
// cssRules.test.ts — CSS の規則分割と、承認で変わった規則だけをペア側へ当てる 3 者比較
// =============================================================================
import { describe, expect, it } from 'vitest';
import {
  foldedCssRuleTexts,
  mergeCssRuleChanges,
  mergeCssRuleChangesFromBaseline,
  sameCssRule,
  splitCssRules,
} from '../src/css/cssRules.js';

/** キーの組み立て(実装と同じ JSON 配列の文字列)。 */
const k = (...parts: Array<string | number>): string => JSON.stringify(parts);

describe('splitCssRules', () => {
  it('空の CSS は規則なし', () => {
    expect(splitCssRules('')).toEqual([]);
    expect(splitCssRules('  /* c */ \n')).toEqual([]);
  });

  it('規則ごとにキー・原文・範囲を返す', () => {
    const css = '.a{color:red}\n.b { color: blue }';
    expect(splitCssRules(css)).toEqual([
      { key: k('.a'), atRules: [], text: '.a{color:red}', start: 0, end: 13 },
      { key: k('.b'), atRules: [], text: '.b { color: blue }', start: 14, end: 32 },
    ]);
  });

  it('セレクタの空白を正規化する', () => {
    expect(splitCssRules('.a   >  .b ,\n .c {x:1}').map((r) => r.key)).toEqual([k('.a>.b,.c')]);
  });

  it('@media と @supports の入れ子は外側の前置きをキーに含める', () => {
    const css = '@media print { .a{x:1} @supports (display:grid) { .b{y:2} } }';
    const rules = splitCssRules(css);
    expect(rules.map((r) => r.key)).toEqual([
      k('@media print', '.a'),
      k('@media print', '@supports (display:grid)', '.b'),
    ]);
    expect(rules.map((r) => r.atRules)).toEqual([
      ['@media print'],
      ['@media print', '@supports (display:grid)'],
    ]);
    // text と範囲は規則本体だけ(囲む @media の前置きを含まない)。
    expect(rules.map((r) => r.text)).toEqual(['.a{x:1}', '.b{y:2}']);
    expect(rules.map((r) => css.slice(r.start, r.end))).toEqual(['.a{x:1}', '.b{y:2}']);
  });

  it('@media の中の @font-face も本体だけを text にし、atRules に @media を持つ', () => {
    const css = '@media print{\n  @font-face{font-family:P;src:url(fonts/p.woff2)}\n}';
    expect(splitCssRules(css)).toEqual([
      {
        key: k('@media print', '@font-face{font-family:p;font-weight:;font-style:}'),
        atRules: ['@media print'],
        text: '@font-face{font-family:P;src:url(fonts/p.woff2)}',
        start: 16,
        end: 64,
      },
    ]);
  });

  it('同じセレクタは出現順の番号で区別する', () => {
    expect(splitCssRules('.a{x:1}.a{x:2}.a{x:3}').map((r) => r.key)).toEqual([
      k('.a'),
      k('.a', 2),
      k('.a', 3),
    ]);
  });

  it('文字列の中の { } は規則の区切りにしない', () => {
    const rules = splitCssRules('.a::before{content:"{ }"}.b{x:1}');
    expect(rules.map((r) => r.text)).toEqual(['.a::before{content:"{ }"}', '.b{x:1}']);
  });

  it('コメントの中の } は区切りにせず、規則の間のコメントは規則に含めない', () => {
    const rules = splitCssRules('/* } */.a{x:1/* } */}.b{y:2}');
    expect(rules.map((r) => r.text)).toEqual(['.a{x:1/* } */}', '.b{y:2}']);
    expect(rules[0].start).toBe(7);
  });

  it('セレクタの中のコメントはキーから除く', () => {
    expect(splitCssRules('.a/* x */ .b{x:1}').map((r) => r.key)).toEqual([k('.a .b')]);
  });

  it('url() の中の括弧は区切りにしない', () => {
    expect(splitCssRules('.a{background:url(x{y}.png)}').map((r) => r.text)).toEqual([
      '.a{background:url(x{y}.png)}',
    ]);
  });

  it('@font-face は family で見分ける(キーは小文字化)', () => {
    const rules = splitCssRules(
      '@font-face{font-family:A;src:url(a.woff2)}\n@font-face{font-family:B;src:url(b.woff2)}',
    );
    expect(rules).toHaveLength(2);
    expect(rules[0].key).not.toBe(rules[1].key);
    expect(rules[0].key).toContain('font-family:a');
    expect(rules[1].key).toContain('font-family:b');
  });

  it('@page :first は前置きで、@keyframes は中へ降りずに 1 規則', () => {
    const rules = splitCssRules('@page :first{margin:0}@keyframes k{from{x:0}to{x:1}}');
    expect(rules.map((r) => r.key)).toEqual([k('@page :first'), k('@keyframes k')]);
    expect(rules[1].text).toBe('@keyframes k{from{x:0}to{x:1}}');
  });

  it('; で終わる文は 1 規則(キーは ; を除いた文)', () => {
    const rules = splitCssRules('@charset "utf-8";\n.a{}');
    expect(rules.map((r) => r.key)).toEqual([k('@charset "utf-8"'), k('.a')]);
    expect(rules[0].text).toBe('@charset "utf-8";');
  });

  it('入れ子の中で } の手前にある終端の無い文も規則にする', () => {
    const rules = splitCssRules('@media x{.a{} color:red }');
    expect(rules.map((r) => r.key)).toEqual([k('@media x', '.a'), k('@media x', 'color:red')]);
    expect(rules[1].text).toBe('color:red');
  });

  it('閉じていないブロックは末尾まで、末尾の終端の無い文は規則にしない', () => {
    expect(splitCssRules('.a{x:1').map((r) => r.text)).toEqual(['.a{x:1']);
    expect(splitCssRules('.a{}\n.b').map((r) => r.text)).toEqual(['.a{}']);
  });

  it('対応の無い } は読み飛ばす', () => {
    expect(splitCssRules('}.a{x:1}').map((r) => r.key)).toEqual([k('.a')]);
  });

  it('空白だけの CSS は規則なし', () => {
    expect(splitCssRules(' \r\n\t \n')).toEqual([]);
  });

  it('先頭の BOM と CRLF があっても最初の規則を落とさず、キーと本文は LF・BOM 無しと同じ', () => {
    const clean = '.a{x:1}\n@media print {\n  .b{y:2}\n}\n';
    const dirty = `﻿${clean.replace(/\n/g, '\r\n')}`;
    const c = splitCssRules(clean);
    const d = splitCssRules(dirty);
    expect(d.map((r) => r.key)).toEqual(c.map((r) => r.key));
    expect(d.map((r) => r.text)).toEqual(c.map((r) => r.text));
    expect(d.map((r) => r.atRules)).toEqual(c.map((r) => r.atRules));
    expect(d[0].key).toBe(k('.a'));
    expect(d.map((r) => dirty.slice(r.start, r.end))).toEqual(d.map((r) => r.text));
  });
});

describe('mergeCssRuleChanges', () => {
  it('変わった規則は、ペア側が base と同じなら当てる', () => {
    const r = mergeCssRuleChanges(
      '.a{x:1}\n.b{y:1}\n',
      '.a{x:2}\n.b{y:1}\n',
      '.a{x:1}\n.b{y:1}\n.t{z:1}\n',
    );
    expect(r).toEqual({
      css: '.a{x:2}\n.b{y:1}\n.t{z:1}\n',
      applied: [k('.a')],
      conflicts: [],
      unmatched: [],
    });
  });

  it('ペア側が base と違えば競合として飛ばす', () => {
    const target = '.a{x:9}\n.b{y:1}\n';
    const r = mergeCssRuleChanges('.a{x:1}\n.b{y:1}\n', '.a{x:2}\n.b{y:1}\n', target);
    expect(r).toEqual({ css: target, applied: [], conflicts: [k('.a')], unmatched: [] });
  });

  it('ペア側に無い規則の変更は競合', () => {
    const r = mergeCssRuleChanges('.a{x:1}\n', '.a{x:2}\n', '.t{z:1}\n');
    expect(r).toEqual({ css: '.t{z:1}\n', applied: [], conflicts: [k('.a')], unmatched: [] });
  });

  it('ペア側が既に next と同じなら何もしない', () => {
    const r = mergeCssRuleChanges('.a{x:1}\n', '.a{x:2}\n', '.a{x:2}\n');
    expect(r).toEqual({ css: '.a{x:2}\n', applied: [], conflicts: [], unmatched: [] });
  });

  it('変わっていない規則には、ペア側が違っていても触らない', () => {
    const r = mergeCssRuleChanges('.b{y:1}\n', '.b{y:1}\n', '.b{y:7}\n');
    expect(r).toEqual({ css: '.b{y:7}\n', applied: [], conflicts: [], unmatched: [] });
  });

  it('空白だけの違いは同じ規則とみなす', () => {
    const r = mergeCssRuleChanges('.a{x:1}', '.a{x:2}', '.a { x: 1 }\n');
    expect(r).toEqual({ css: '.a{x:2}\n', applied: [k('.a')], conflicts: [], unmatched: [] });
  });

  it('削除は、ペア側が base と同じなら行ごと消す', () => {
    const r = mergeCssRuleChanges('.a{x:1}\n.b{y:1}\n', '.b{y:1}\n', '.a{x:1}\n.b{y:1}\n');
    expect(r).toEqual({ css: '.b{y:1}\n', applied: [k('.a')], conflicts: [], unmatched: [] });
  });

  it('入れ子の中の削除は行頭のインデントと CRLF の改行も消す', () => {
    const base = '@media print {\r\n  .a{x:1}\r\n  .b{y:1}\r\n}\r\n';
    const next = '@media print {\r\n  .b{y:1}\r\n}\r\n';
    const r = mergeCssRuleChanges(base, next, base);
    expect(r.css).toBe(next);
    expect(r.applied).toEqual([k('@media print', '.a')]);
  });

  it('削除で、ペア側が base と違えば競合', () => {
    const target = '.a{x:5}\n.b{y:1}\n';
    const r = mergeCssRuleChanges('.a{x:1}\n.b{y:1}\n', '.b{y:1}\n', target);
    expect(r).toEqual({ css: target, applied: [], conflicts: [k('.a')], unmatched: [] });
  });

  it('削除で、ペア側に既に無ければ何もしない', () => {
    const r = mergeCssRuleChanges('.a{x:1}\n.b{y:1}\n', '.b{y:1}\n', '.b{y:1}\n');
    expect(r).toEqual({ css: '.b{y:1}\n', applied: [], conflicts: [], unmatched: [] });
  });

  it('追加は next で直前にある規則の後ろへ入れる', () => {
    const r = mergeCssRuleChanges(
      '.a{x:1}\n.c{z:1}\n',
      '.a{x:1}\n.b{y:1}\n.c{z:1}\n',
      '.a{x:1}\n.t{w:1}\n.c{z:1}\n',
    );
    expect(r).toEqual({
      css: '.a{x:1}\n.b{y:1}\n.t{w:1}\n.c{z:1}\n',
      applied: [k('.b')],
      conflicts: [],
      unmatched: [],
    });
  });

  it('連続する追加は next の順でまとめて入れる', () => {
    const r = mergeCssRuleChanges('.a{}', '.a{}\n.b{}\n.c{}', '.a{}');
    expect(r).toEqual({
      css: '.a{}\n.b{}\n.c{}',
      applied: [k('.b'), k('.c')],
      conflicts: [],
      unmatched: [],
    });
  });

  it('直前の規則がペア側に無ければ末尾へ入れる', () => {
    const r = mergeCssRuleChanges('.a{x:1}\n', '.n{q:1}\n.a{x:1}\n', '.a{x:1}\n.t{w:1}');
    expect(r).toEqual({
      css: '.a{x:1}\n.t{w:1}\n.n{q:1}\n',
      applied: [k('.n')],
      conflicts: [],
      unmatched: [],
    });
  });

  it('@media の中の追加は、同じ @media の直前の規則の後ろへインデントを合わせて入れる', () => {
    const base = '@media print {\n  .a{x:1}\n}\n';
    const next = '@media print {\n  .a{x:1}\n  .b{y:1}\n}\n';
    const r = mergeCssRuleChanges(base, next, base);
    expect(r).toEqual({
      css: next,
      applied: [k('@media print', '.b')],
      conflicts: [],
      unmatched: [],
    });
  });

  it('同じ入れ子の直前の規則が無ければ、外側の at-rule で包んで末尾へ入れる', () => {
    const r = mergeCssRuleChanges(
      '.a{x:1}\n',
      '.a{x:1}\n@media print {\n  .p{y:1}\n}\n',
      '.a{x:1}\n',
    );
    expect(r).toEqual({
      css: '.a{x:1}\n@media print {\n.p{y:1}\n}\n',
      applied: [k('@media print', '.p')],
      conflicts: [],
      unmatched: [],
    });
  });

  it('追加した規則がペア側に既にあれば、同じなら何もせず、違えば競合', () => {
    expect(mergeCssRuleChanges('', '.a{x:1}', '.a{x:1}')).toEqual({
      css: '.a{x:1}',
      applied: [],
      conflicts: [],
      unmatched: [],
    });
    expect(mergeCssRuleChanges('', '.a{x:1}', '.a{x:2}')).toEqual({
      css: '.a{x:2}',
      applied: [],
      conflicts: [k('.a')],
      unmatched: [],
    });
  });

  it('重複セレクタは出現順の番号で対応づけて当てる', () => {
    const r = mergeCssRuleChanges('.a{x:1}\n.a{x:2}\n', '.a{x:1}\n.a{x:3}\n', '.a{x:1}\n.a{x:2}\n');
    expect(r).toEqual({
      css: '.a{x:1}\n.a{x:3}\n',
      applied: [k('.a', 2)],
      conflicts: [],
      unmatched: [],
    });
  });

  it('文字列やコメントに括弧を含む規則も壊さずに当てる', () => {
    const base = '/* } */\n.q::before{content:"{"}\n.r{x:1}\n';
    const next = '/* } */\n.q::before{content:"}"}\n.r{x:1}\n';
    const r = mergeCssRuleChanges(base, next, base);
    expect(r).toEqual({ css: next, applied: [k('.q::before')], conflicts: [], unmatched: [] });
  });

  it('規則の間のコメントだけの違いは同期しない', () => {
    const target = '/* t */\n.a{x:1}\n';
    const r = mergeCssRuleChanges('/* c1 */\n.a{x:1}\n', '/* c2 */\n.a{x:1}\n', target);
    expect(r).toEqual({ css: target, applied: [], conflicts: [], unmatched: [] });
  });

  it('空の CSS どうし・空のペア側への追加', () => {
    expect(mergeCssRuleChanges('', '', '')).toEqual({
      css: '',
      applied: [],
      conflicts: [],
      unmatched: [],
    });
    expect(mergeCssRuleChanges('', '', '.t{}')).toEqual({
      css: '.t{}',
      applied: [],
      conflicts: [],
      unmatched: [],
    });
    expect(mergeCssRuleChanges('', '.a{x:1}', '')).toEqual({
      css: '.a{x:1}\n',
      applied: [k('.a')],
      conflicts: [],
      unmatched: [],
    });
  });

  it('空白だけの base でも追加を当てる', () => {
    expect(mergeCssRuleChanges('  \n', '.a{x:1}', '')).toEqual({
      css: '.a{x:1}\n',
      applied: [k('.a')],
      conflicts: [],
      unmatched: [],
    });
  });

  it('@media の中の規則の置き換えは本体だけを差し替え、前置きと閉じ括弧を保つ', () => {
    const base = '@media print {\n  .a{x:1}\n  .b{y:1}\n}\n';
    const next = '@media print {\n  .a{x:2}\n  .b{y:1}\n}\n';
    const r = mergeCssRuleChanges(base, next, base);
    expect(r).toEqual({
      css: next,
      applied: [k('@media print', '.a')],
      conflicts: [],
      unmatched: [],
    });
  });

  it('入れ子の追加で包み直すとき、複数の規則を 1 つの at-rule にまとめる', () => {
    const r = mergeCssRuleChanges(
      '.a{x:1}\n',
      '.a{x:1}\n@media print {\n  .p{y:1}\n  .q{z:1}\n}\n',
      '.a{x:1}\n',
    );
    expect(r.css).toBe('.a{x:1}\n@media print {\n.p{y:1}\n.q{z:1}\n}\n');
    expect(r.applied).toEqual([k('@media print', '.p'), k('@media print', '.q')]);
  });

  it('変更と、その規則の直後への追加を同時に当てる', () => {
    const r = mergeCssRuleChanges('.a{x:1}\n', '.a{x:2}\n.b{y:1}\n', '.a{x:1}\n');
    expect(r).toEqual({
      css: '.a{x:2}\n.b{y:1}\n',
      applied: [k('.a'), k('.b')],
      conflicts: [],
      unmatched: [],
    });
  });

  describe('先頭の BOM と CRLF', () => {
    const toDirty = (s: string): string => `﻿${s.replace(/\n/g, '\r\n')}`;

    it('変更を当てる結果が、クリアな入力と同じキーで適用される', () => {
      const base = '.a{x:1}\n.b{y:1}\n';
      const next = '.a{x:2}\n.b{y:1}\n';
      const target = '.a{x:1}\n.b{y:1}\n.t{z:1}\n';
      const clean = mergeCssRuleChanges(base, next, target);
      const dirty = mergeCssRuleChanges(toDirty(base), toDirty(next), toDirty(target));
      expect(dirty.applied).toEqual(clean.applied);
      expect(dirty.conflicts).toEqual(clean.conflicts);
      expect(dirty.css).toBe(toDirty(clean.css));
    });

    it('競合も、クリアな入力と同じように検出する', () => {
      const base = '.a{x:1}\n';
      const next = '.a{x:2}\n';
      const target = '.a{x:9}\n';
      const dirty = mergeCssRuleChanges(toDirty(base), toDirty(next), toDirty(target));
      expect(dirty.applied).toEqual([]);
      expect(dirty.conflicts).toEqual([k('.a')]);
      expect(dirty.css).toBe(toDirty(target));
    });

    it('削除と追加も同じ結果になる', () => {
      const base = '.a{x:1}\n.b{y:1}\n';
      const next = '.b{y:1}\n.c{z:1}\n';
      const clean = mergeCssRuleChanges(base, next, base);
      const dirty = mergeCssRuleChanges(toDirty(base), toDirty(next), toDirty(base));
      expect(dirty.applied).toEqual(clean.applied);
      // 挿入する改行は LF 固定(既存の行の改行はそのまま CRLF)。改行の種類を除けば同じ。
      expect(dirty.css.replace(/\r\n/g, '\n')).toBe(toDirty(clean.css).replace(/\r\n/g, '\n'));
    });
  });
});

describe('sameCssRule — 書式の違いだけなら同じ規則', () => {
  it('空白・改行・ブロック最後の `;` の有無を無視する', () => {
    expect(sameCssRule('.a{color:red}', '.a {\n  color: red;\n}')).toBe(true);
    expect(sameCssRule('.a{x:1;y:2}', '.a{x:1;y:2;}')).toBe(true);
    expect(sameCssRule('.a{x:1;\n}', '.a { x : 1 }')).toBe(true);
  });

  it('値やプロパティの順が違えば別の規則', () => {
    expect(sameCssRule('.a{color:red}', '.a{color:blue}')).toBe(false);
    expect(sameCssRule('.a{x:1;y:2}', '.a{y:2;x:1}')).toBe(false);
  });
});

describe('名前のない at-rule(@page / @font-face)の識別', () => {
  it('@page は前置きで見分け、@page と @page :first は別のキー', () => {
    const rules = splitCssRules('@page{margin:1mm}@page :first{margin:2mm}@page cover{margin:3mm}');
    expect(rules.map((r) => r.key)).toEqual([k('@page'), k('@page :first'), k('@page cover')]);
  });

  it('@font-face は family・weight・style で見分け、weight が違えば別のキー', () => {
    const rules = splitCssRules(
      '@font-face{font-family:"A";font-weight:400;src:url(a4.woff2)}' +
        '@font-face{font-family:A;font-weight:700;src:url(a7.woff2)}',
    );
    expect(rules).toHaveLength(2);
    expect(rules[0].key).not.toBe(rules[1].key);
  });

  it('font-family の無い @font-face は中身全体で見分ける', () => {
    const rules = splitCssRules('@font-face{src:url(a.woff2)}@font-face{src:url(b.woff2)}');
    expect(new Set(rules.map((r) => r.key)).size).toBe(2);
  });

  it('@page の変更をペア側が版種固有に直していれば競合にし、追記しない', () => {
    const target = '@page{margin:20mm}\n.a{}\n';
    const r = mergeCssRuleChanges(
      '@page{margin:10mm}\n.a{}\n',
      '@page{margin:12mm}\n.a{}\n',
      target,
    );
    expect(r).toEqual({ css: target, applied: [], conflicts: [k('@page')], unmatched: [] });
  });

  it('@page の変更をペア側が base のままならその場で置き換える', () => {
    const r = mergeCssRuleChanges(
      '@page{margin:10mm}\n.a{}\n',
      '@page{margin:12mm}\n.a{}\n',
      '@page{margin:10mm}\n.a{}\n',
    );
    expect(r).toEqual({
      css: '@page{margin:12mm}\n.a{}\n',
      applied: [k('@page')],
      conflicts: [],
      unmatched: [],
    });
  });

  it('@font-face の src 変更は同じ family/weight/style の変更として扱う', () => {
    const base = '@font-face{font-family:A;font-weight:400;src:url(a.woff2)}\n';
    const next = '@font-face{font-family:A;font-weight:400;src:url(a2.woff2)}\n';
    const key = k('@font-face{font-family:a;font-weight:400;font-style:}');
    expect(mergeCssRuleChanges(base, next, base)).toEqual({
      css: next,
      applied: [key],
      conflicts: [],
      unmatched: [],
    });
    const edited = '@font-face{font-family:A;font-weight:400;src:url(mine.woff2)}\n';
    expect(mergeCssRuleChanges(base, next, edited)).toEqual({
      css: edited,
      applied: [],
      conflicts: [key],
      unmatched: [],
    });
  });
});

describe('mergeCssRuleChangesFromBaseline — 変更は GrapesJS 形、ペア側は原文で比べる', () => {
  // 外部ツールが書いた原文(承認前のファイル)。一括指定・16 進色・引用符なしの url を含む。
  const rawBase = [
    '.cover-title{color:#003366}',
    '.bg{background:url(../images/110024_bg.svg) center}',
    '.page{padding:10mm}',
    '@font-face{font-family:T;src:url(fonts/t.woff2)}',
    '',
  ].join('\n');
  // 同じ CSS を GrapesJS が読み込んで getCss した形(色の正規化・一括指定の展開・url の引用符・
  // @font-face の末尾移動)。
  const gjs = (coverTitle: string): string =>
    `.cover-title{${coverTitle}}` +
    '.bg{background-image:url("../images/110024_bg.svg");background-position-x:center;' +
    'background-position-y:center;background-repeat:initial;background-attachment:initial;' +
    'background-origin:initial;background-clip:initial;background-size:initial;' +
    'background-color:initial;}' +
    '.page{padding-top:10mm;padding-right:10mm;padding-bottom:10mm;padding-left:10mm;}' +
    '@font-face{font-family:T;src:url("fonts/t.woff2");}';
  const baseline = gjs('color:rgb(0, 51, 102);');

  it('無編集(next = baseline)なら何も当てず、競合も出さない', () => {
    const r = mergeCssRuleChangesFromBaseline(rawBase, baseline, baseline, rawBase);
    expect(r).toEqual({ css: rawBase, applied: [], conflicts: [], unmatched: [] });
  });

  it('無編集なら、ペア側で版種固有に直した規則があっても偽の競合を出さない', () => {
    const target = rawBase.replace('#003366', '#990000');
    const r = mergeCssRuleChangesFromBaseline(rawBase, baseline, baseline, target);
    expect(r).toEqual({ css: target, applied: [], conflicts: [], unmatched: [] });
  });

  it('編集した規則だけを当て、GrapesJS が書き換えただけの規則には触らない', () => {
    const next = gjs('color:rgb(0, 0, 0);');
    const r = mergeCssRuleChangesFromBaseline(rawBase, baseline, next, rawBase);
    expect(r.applied).toEqual([k('.cover-title')]);
    expect(r.conflicts).toEqual([]);
    expect(r.css).toBe(
      rawBase.replace('.cover-title{color:#003366}', '.cover-title{color:rgb(0, 0, 0);}'),
    );
  });

  it('編集した規則をペア側が版種固有に直していれば競合にし、ペア側は変えない', () => {
    const next = gjs('color:rgb(0, 0, 0);');
    const target = rawBase.replace('#003366', '#990000');
    const r = mergeCssRuleChangesFromBaseline(rawBase, baseline, next, target);
    expect(r).toEqual({ css: target, applied: [], conflicts: [k('.cover-title')], unmatched: [] });
  });

  it('追加はペア側に無ければ next の直前の規則の後ろへ入れ、削除はペア側が原文のままなら消す', () => {
    const base = '.a{x:1}\n.b{y:1}\n';
    const r = mergeCssRuleChangesFromBaseline(base, '.a{x:1;}.b{y:1;}', '.a{x:1;}.n{z:1;}', base);
    expect(r.applied).toEqual([k('.b'), k('.n')]);
    expect(r.conflicts).toEqual([]);
    expect(r.css).toBe('.a{x:1}\n.n{z:1;}\n');
  });

  it('原文に無い規則の変更は、ペア側の有無によらず当てずに照合不可にする', () => {
    const r1 = mergeCssRuleChangesFromBaseline('.a{x:1}\n', '.c{z:1;}', '.c{z:2;}', '.a{x:1}\n');
    expect(r1).toEqual({ css: '.a{x:1}\n', applied: [], conflicts: [], unmatched: [k('.c')] });
    const r2 = mergeCssRuleChangesFromBaseline('.a{x:1}\n', '.c{z:1;}', '.c{z:2;}', '.c{z:9}\n');
    expect(r2).toEqual({ css: '.c{z:9}\n', applied: [], conflicts: [], unmatched: [k('.c')] });
  });

  it('baseline に無く next で現れた規則は、原文にあってペア側が消していれば競合にする', () => {
    const r = mergeCssRuleChangesFromBaseline(
      '.a{x:1}\n.c{z:1}\n',
      '.a{x:1;}',
      '.a{x:1;}.c{z:1;}',
      '.a{x:1}\n',
    );
    expect(r).toEqual({ css: '.a{x:1}\n', applied: [], conflicts: [k('.c')], unmatched: [] });
  });

  // 編集画面の getCss は文書で使っていない規則も書き出す(`useGrapes` の `keepUnusedStyles`)。
  // baseline と next の両方に同じ形で載るので、使う要素の増減は規則の変更にならない。
  it('クラスを使う最後の要素を消しても、規則が baseline と next に同じ形で残れば削除にならない', () => {
    const raw = '.a{x:1}\n.gone{color:#003366}\n';
    const both = '.a{x:1;}.gone{color:rgb(0, 51, 102);}';
    const r = mergeCssRuleChangesFromBaseline(raw, both, both, raw);
    expect(r).toEqual({ css: raw, applied: [], conflicts: [], unmatched: [] });
  });

  it('baseline で未使用だった規則を使い始めても、本文が同じなら変更にも競合にもならない', () => {
    const raw = '.a{x:1}\n.later{padding:1mm}\n';
    const target = '.a{x:1}\n.later{padding:2mm}\n';
    const gjs =
      '.a{x:1;}.later{padding-top:1mm;padding-right:1mm;padding-bottom:1mm;padding-left:1mm;}';
    const r = mergeCssRuleChangesFromBaseline(raw, gjs, gjs, target);
    expect(r).toEqual({ css: target, applied: [], conflicts: [], unmatched: [] });
  });

  it('ペア側が既に next と同じなら当てず、競合にもしない', () => {
    const r = mergeCssRuleChangesFromBaseline('.a{x:1}', '.a{x:1;}', '.a{x:2;}', '.a{x:2;}');
    expect(r).toEqual({ css: '.a{x:2;}', applied: [], conflicts: [], unmatched: [] });
  });
});

describe('属性セレクタの値の引用符', () => {
  it('引用符なし・一重・二重の値を同じキーにする', () => {
    const keys = splitCssRules(`img[src=x]{a:1}\nimg[src='x']{a:1}\nimg[src="x"]{a:1}`).map(
      (r) => r.key,
    );
    expect(keys).toEqual([k('img[src="x"]'), k('img[src="x"]', 2), k('img[src="x"]', 3)]);
  });

  it('演算子・大文字小文字の指定・値の中の引用符も、ブラウザの書き出しと同じ形にそろえる', () => {
    const keys = splitCssRules(
      `a[href ^= 'http']{}\na[title='say "hi"']{}\na[lang|=en i]{}\na[data-x="a]b"]{}`,
    ).map((r) => r.key);
    expect(keys).toEqual([
      k('a[href^="http"]'),
      k('a[title="say \\"hi\\""]'),
      k('a[lang|="en" i]'),
      k('a[data-x="a]b"]'),
    ]);
  });

  it('引用符を閉じた直後の大文字小文字の指定は、空白を挟んだ形にそろえる', () => {
    const keys = splitCssRules(`a[x='y'i]{}\na[x="y" i]{}\na[x=y i]{}`).map((r) => r.key);
    expect(keys).toEqual([k('a[x="y" i]'), k('a[x="y" i]', 2), k('a[x="y" i]', 3)]);
  });

  it('値のエスケープは解いてから二重引用符で囲み、`"` と `\\` だけを書き直す', () => {
    const keys = splitCssRules(
      `a[x=a\\]b]{}\na[x="a]b"]{}\na[x='a\\'b']{}\na[x=a\\5d b]{}\na[x='a\\\\b']{}`,
    ).map((r) => r.key);
    expect(keys).toEqual([
      k('a[x="a]b"]'),
      k('a[x="a]b"]', 2),
      k(`a[x="a'b"]`),
      k('a[x="a]b"]', 3),
      k('a[x="a\\\\b"]'),
    ]);
  });

  it('閉じた引用符の後ろの大文字の I と S は小文字にそろえる', () => {
    const keys = splitCssRules(`a[x='y'I]{}\na[x="y" S]{}\na[x=y s]{}`).map((r) => r.key);
    expect(keys).toEqual([k('a[x="y" i]'), k('a[x="y" s]'), k('a[x="y" s]', 2)]);
  });

  it('サロゲートと 0 と範囲外の符号位置のエスケープは U+FFFD にする', () => {
    const keys = splitCssRules(`a[x="\\d800"]{}\na[x="\\0"]{}\na[x="\\110000"]{}`).map(
      (r) => r.key,
    );
    expect(keys).toEqual([k('a[x="\ufffd"]'), k('a[x="\ufffd"]', 2), k('a[x="\ufffd"]', 3)]);
  });

  it('文字列の中の \\ + 改行は行の継続として消す(ほかの改行は空白に畳む)', () => {
    const keys = splitCssRules('a[x="a\\\nb"]{}\na[x="a\\\r\nb"]{}\n.p\n.q{}').map((r) => r.key);
    expect(keys).toEqual([k('a[x="ab"]'), k('a[x="ab"]', 2), k('.p .q')]);
  });

  it('GrapesJS が引用符を付け直した規則も、原文の規則と対応づけて当てる', () => {
    const raw = "img[src=x]{color:red}\nimg[src='y']{color:red}\n";
    const baseline = 'img[src="x"]{color:red;}img[src="y"]{color:red;}';
    const next = 'img[src="x"]{color:blue;}img[src="y"]{color:red;}';
    const r = mergeCssRuleChangesFromBaseline(raw, baseline, next, raw);
    expect(r).toEqual({
      css: 'img[src="x"]{color:blue;}\nimg[src=\'y\']{color:red}\n',
      applied: [k('img[src="x"]')],
      conflicts: [],
      unmatched: [],
    });
  });
});

describe('mergeCssRuleChangesFromBaseline — 重複した規則は 1 本に畳んで比べる', () => {
  it('原文と baseline の出現数が合わなければ対応が取れないので競合にし、ペア側は変えない', () => {
    const raw = '.a{color:red}.a{margin:0}';
    const r = mergeCssRuleChangesFromBaseline(
      raw,
      '.a{color:red;margin:0;}',
      '.a{color:blue;margin:0;}',
      raw,
    );
    expect(r).toEqual({ css: raw, applied: [], conflicts: [k('.a')], unmatched: [] });
  });

  it('出現数が合えば出現ごとに当て、間にある別の規則とのカスケードを保つ', () => {
    const raw = '.a{color:red}\n.b{color:green}\n.a{margin:0}\n';
    const gjs = (margin: string): string => `.a{color:red;}.b{color:green;}.a{margin:${margin};}`;
    const r = mergeCssRuleChangesFromBaseline(raw, gjs('0'), gjs('5px'), raw);
    // 編集していない最初の .a は原文のまま残り、.b より前に置かれ続ける。
    expect(r).toEqual({
      css: '.a{color:red}\n.b{color:green}\n.a{margin:5px;}\n',
      applied: [k('.a')],
      conflicts: [],
      unmatched: [],
    });
  });

  it('出現ごとに当てるとき、編集した出現だけを置き換える(後ろの重複の上書きも保つ)', () => {
    const raw = '.a{color:red}\n.b{x:1}\n.a{color:green;margin:0}\n';
    const gjs = (color: string): string => `.a{color:red;}.b{x:1;}.a{color:${color};margin:0;}`;
    const r = mergeCssRuleChangesFromBaseline(raw, gjs('green'), gjs('blue'), raw);
    expect(r).toEqual({
      css: '.a{color:red}\n.b{x:1}\n.a{color:blue;margin:0;}\n',
      applied: [k('.a')],
      conflicts: [],
      unmatched: [],
    });
  });

  it('next の出現が baseline より多ければ対応が取れないので競合にする', () => {
    const raw = '.a{color:red}\n.b{x:1}\n.a{margin:0}\n';
    const r = mergeCssRuleChangesFromBaseline(
      raw,
      '.a{color:red;margin:0;}.b{x:1;}',
      '.a{color:red;}.b{x:1;}.a{margin:5px;}',
      raw,
    );
    expect(r).toEqual({ css: raw, applied: [], conflicts: [k('.a')], unmatched: [] });
  });

  it('最後の重複の宣言を全部消した編集は、ペア側の最後の出現を消し、前の出現は残す', () => {
    const target = '.a{color:red}\n.b{color:green}\n.a{margin:0}';
    const r = mergeCssRuleChangesFromBaseline(
      target,
      '.a{color:red;}.b{color:green;}.a{margin:0;}',
      '.a{color:red;}.b{color:green;}',
      target,
    );
    expect(r).toEqual({
      css: '.a{color:red}\n.b{color:green}\n',
      applied: [k('.a')],
      conflicts: [],
      unmatched: [],
    });
  });

  it('ペア側が原文より少ない出現にまとめていれば、宣言の削除も競合にする', () => {
    const target = '.a{color:red;margin:0}\n.b{}';
    const r = mergeCssRuleChangesFromBaseline(
      '.a{color:red}\n.b{}\n.a{margin:0}',
      '.a{color:red;}.b{}.a{margin:0;}',
      '.a{color:red;}.b{}',
      target,
    );
    expect(r).toEqual({ css: target, applied: [], conflicts: [k('.a')], unmatched: [] });
  });

  it('ペア側が宣言の配り方を変えていれば、畳めば同じでも競合にする', () => {
    const target = '.a{x:1;y:1}\n.a{y:1}';
    const r = mergeCssRuleChangesFromBaseline(
      '.a{x:1}\n.a{y:1}',
      '.a{x:1;}.a{y:1;}',
      '.a{x:1;}',
      target,
    );
    expect(r).toEqual({ css: target, applied: [], conflicts: [k('.a')], unmatched: [] });
  });

  it('ペア側が後ろの重複を 1 本にまとめていれば、出現の編集も競合にする(順序を変えない)', () => {
    const target = '.a{x:1}\n.b{x:2}\n.a{y:1;z:1}';
    const gjs = (z: string): string => `.a{x:1;}.b{x:2;}.a{y:1;}.a{z:${z};}`;
    const r = mergeCssRuleChangesFromBaseline(
      '.a{x:1}\n.b{x:2}\n.a{y:1}\n.a{z:1}',
      gjs('1'),
      gjs('5'),
      target,
    );
    expect(r).toEqual({ css: target, applied: [], conflicts: [k('.a')], unmatched: [] });
  });

  it('原文の空の規則に宣言を足した編集は、ペア側の最後の空の出現を置き換える', () => {
    const raw = '.a{}\n.b{y:1}';
    const r = mergeCssRuleChangesFromBaseline(raw, '.b{y:1;}', '.b{y:1;}.a{color:red;}', raw);
    expect(r).toEqual({
      css: '.a{color:red;}\n.b{y:1}',
      applied: [k('.a')],
      conflicts: [],
      unmatched: [],
    });
    const dup = '.a{}\n.a{ }\n.b{y:1}';
    expect(
      mergeCssRuleChangesFromBaseline(dup, '.b{y:1;}', '.b{y:1;}.a{color:red;}', dup).css,
    ).toBe('.a{}\n.a{color:red;}\n.b{y:1}');
  });

  it('ペア側の空の規則が原文と違う形(原文に無い・数が違う)なら、宣言の追加は競合にする', () => {
    for (const [raw, target] of [
      ['.b{y:1}', '.a{}\n.b{y:1}'],
      ['.a{}\n.b{y:1}', '.a{}\n.a{}\n.b{y:1}'],
      ['.a{}\n.a{}\n.b{y:1}', '.a{}\n.a{}\n.a{}\n.b{y:1}'],
    ]) {
      const r = mergeCssRuleChangesFromBaseline(raw, '.b{y:1;}', '.b{y:1;}.a{color:red;}', target);
      expect(r).toEqual({ css: target, applied: [], conflicts: [k('.a')], unmatched: [] });
    }
  });

  it('宣言が空や無効の重複は対応づけから外し、前からそろえて当てる', () => {
    for (const empty of ['.a{}', '.a{garbage}', '.a{ ; }']) {
      const raw = `${empty}\n.b{color:green}\n.a{color:red}\n`;
      const r = mergeCssRuleChangesFromBaseline(
        raw,
        '.b{color:green;}.a{color:red;}',
        '.b{color:green;}.a{color:blue;}',
        raw,
      );
      expect(r).toEqual({
        css: `${empty}\n.b{color:green}\n.a{color:blue;}\n`,
        applied: [k('.a')],
        conflicts: [],
        unmatched: [],
      });
    }
  });

  it('空の重複が前にあっても、最後の出現の宣言を消した編集は最後の出現だけを消す', () => {
    const raw = '.a{}\n.a{color:red}\n.b{color:green}\n.a{margin:0}\n';
    const r = mergeCssRuleChangesFromBaseline(
      raw,
      '.a{color:red;}.b{color:green;}.a{margin:0;}',
      '.a{color:red;}.b{color:green;}',
      raw,
    );
    expect(r.css).toBe('.a{}\n.a{color:red}\n.b{color:green}\n');
  });

  it('ペア側の重複を畳んだ形が原文と違えば競合にし、ペア側は変えない', () => {
    const target = '.a{color:red}.a{margin:5px}';
    const r = mergeCssRuleChangesFromBaseline(
      '.a{color:red}.a{margin:0}',
      '.a{color:red;margin:0;}',
      '.a{color:blue;margin:0;}',
      target,
    );
    expect(r).toEqual({ css: target, applied: [], conflicts: [k('.a')], unmatched: [] });
  });

  it('ペア側が 1 本で、畳んだ原文と同じ宣言でも、出現の形が違うので競合にする', () => {
    const target = '.a{color:red;margin:0}\n';
    const r = mergeCssRuleChangesFromBaseline(
      '.a{color:red}\n.a{margin:0}\n',
      '.a{color:red;}.a{margin:0;}',
      '.a{color:blue;}.a{margin:0;}',
      target,
    );
    expect(r).toEqual({ css: target, applied: [], conflicts: [k('.a')], unmatched: [] });
  });

  it('削除は重複をすべて消す', () => {
    const raw = '.a{color:red}\n.b{x:1}\n.a{margin:0}\n';
    const r = mergeCssRuleChangesFromBaseline(
      raw,
      '.a{color:red;margin:0;}.b{x:1;}',
      '.b{x:1;}',
      raw,
    );
    expect(r).toEqual({ css: '.b{x:1}\n', applied: [k('.a')], conflicts: [], unmatched: [] });
  });

  it('畳んだ本文(foldedCssRuleTexts)では、!important の宣言は後ろの通常の宣言に負けない', () => {
    const texts = foldedCssRuleTexts('.a{color:red !important}.a{color:green;margin:0}');
    expect(texts.get(k('.a'))).toBe('.a{color:red !important;margin:0}');
  });

  it('畳んだ本文では、宣言でない中身(@keyframes)の重複は最後の 1 本を代表にする', () => {
    const texts = foldedCssRuleTexts('@keyframes k{from{x:0}}\n@keyframes k{from{x:1}}\n');
    expect(texts.get(k('@keyframes k'))).toBe('@keyframes k{from{x:1}}');
  });

  it('重複した規則の後ろへの追加は、ペア側の最後の出現の後ろへ入れる', () => {
    const raw = '.a{x:1}\n.b{y:1}\n.a{z:1}\n';
    const base = '.a{x:1;}.b{y:1;}.a{z:1;}';
    const r = mergeCssRuleChangesFromBaseline(raw, base, `${base}.c{w:1;}`, raw);
    expect(r).toEqual({
      css: '.a{x:1}\n.b{y:1}\n.a{z:1}\n.c{w:1;}\n',
      applied: [k('.c')],
      conflicts: [],
      unmatched: [],
    });
  });

  it('無編集なら重複があっても何もしない', () => {
    const raw = '.a{color:red}.a{margin:0}';
    const b = '.a{color:red;margin:0;}';
    expect(mergeCssRuleChangesFromBaseline(raw, b, b, raw)).toEqual({
      css: raw,
      applied: [],
      conflicts: [],
      unmatched: [],
    });
  });
});

describe('規則のキーの正規化', () => {
  const keyOf = (css: string): string => splitCssRules(css)[0].key;
  const sameKey = (a: string, b: string): void => expect(keyOf(a)).toBe(keyOf(b));
  const diffKey = (a: string, b: string): void => expect(keyOf(a)).not.toBe(keyOf(b));

  it.each([
    ['.a/**/.b{x:1}', '.a.b{x:1}'],
    ['.a > .b{x:1}', '.a>.b{x:1}'],
    ['.a  +  .b{x:1}', '.a+.b{x:1}'],
    ['.a ~ .b{x:1}', '.a~.b{x:1}'],
    [':not( .a ){x:1}', ':not(.a){x:1}'],
    ['li:nth-child( 2n + 1 ){x:1}', 'li:nth-child(2n+1){x:1}'],
    ['p:before{x:1}', 'p::before{x:1}'],
    ['p:AFTER{x:1}', 'p::after{x:1}'],
    ['p:first-line{x:1}', 'p::first-line{x:1}'],
    ['p:first-letter{x:1}', 'p::first-letter{x:1}'],
    ['DIV.note{x:1}', 'div.note{x:1}'],
    [':not(SPAN){x:1}', ':not(span){x:1}'],
    ['a:HOVER{x:1}', 'a:hover{x:1}'],
    ['[DATA-X=A]{x:1}', '[data-x="A"]{x:1}'],
    ['@MEDIA print{.a{x:1}}', '@media print{.a{x:1}}'],
    ['@media/**/print{.a{x:1}}', '@media print{.a{x:1}}'],
    ['@media PRINT AND (MIN-WIDTH: 10PX){.a{x:1}}', '@media print and (min-width:10px){.a{x:1}}'],
    ['@supports ( display: grid ){.a{x:1}}', '@supports (display:grid){.a{x:1}}'],
    ['@page:first{x:1}', '@page :first{x:1}'],
    ['@page  cover :FIRST{x:1}', '@page cover:first{x:1}'],
  ])('%s と %s は同じキー', (a, b) => sameKey(a, b));

  it.each([
    ['.Note{x:1}', '.note{x:1}'],
    ['#Top{x:1}', '#top{x:1}'],
    ['[data-x="A"]{x:1}', '[data-x="a"]{x:1}'],
    ['.a .b{x:1}', '.a.b{x:1}'],
    ['.a>.b{x:1}', '.a .b{x:1}'],
    ['.a+.b{x:1}', '.a~.b{x:1}'],
    ['[title="a > b"]{x:1}', '[title="a>b"]{x:1}'],
    ['.a\\:hover{x:1}', '.a:hover{x:1}'],
    ['@container Card (min-width:1px){.a{x:1}}', '@container card (min-width:1px){.a{x:1}}'],
    ['@supports (content:"A"){.a{x:1}}', '@supports (content:"a"){.a{x:1}}'],
    ['.a,.b{x:1}', '.b,.a{x:1}'],
    ['.\\31 A{x:1}', '.\\31 a{x:1}'],
    ['\\44 IV{x:1}', '\\44 iv{x:1}'],
    ['@page Cover{x:1}', '@page cover{x:1}'],
    ['@layer Base{.a{x:1}}', '@layer base{.a{x:1}}'],
    ['.x .\\31 A{x:1}', '.x .\\31 a{x:1}'],
    ['::part(Foo){x:1}', '::part(foo){x:1}'],
    [':state(Open){x:1}', ':state(open){x:1}'],
    ['::highlight(Mark){x:1}', '::highlight(mark){x:1}'],
    ['[title="a , b"]{x:1}', '[title="a,b"]{x:1}'],
    ['[title="a  b"]{x:1}', '[title="a b"]{x:1}'],
    ['@supports (content:"a  b"){.a{x:1}}', '@supports (content:"a b"){.a{x:1}}'],
  ])('%s と %s は別のキー', (a, b) => diffKey(a, b));

  it.each([
    ['@Font-Face{font-family:A}', '@font-face{font-family:A}'],
    ['@media(min-width:1px){.a{x:1}}', '@media (min-width: 1px){.a{x:1}}'],
    ['.a /*x*/ .b{x:1}', '.a .b{x:1}'],
    [':IS( .a , .b ) > P{x:1}', ':is(.a,.b)>p{x:1}'],
    ['[ DATA-X ]{x:1}', '[data-x]{x:1}'],
    ["[TITLE='a > b']{x:1}", '[title="a > b"]{x:1}'],
    ['.a DIV{x:1}', '.a div{x:1}'],
    ['TABLE TD{x:1}', 'table td{x:1}'],
    [':is(.a) DIV{x:1}', ':is(.a) div{x:1}'],
    ['DIV P, SPAN{x:1}', 'div p,span{x:1}'],
    ['.a P::BEFORE{x:1}', '.a p::before{x:1}'],
    [':HAS( > IMG ){x:1}', ':has(>img){x:1}'],
    ['::part( Foo ){x:1}', '::part(Foo){x:1}'],
    ['[ DATA-X  ]{x:1}', '[data-x]{x:1}'],
  ])('%s と %s も同じキー', (a, b) => sameKey(a, b));

  it('入れ子の前置き(atRules)も正規化した形で返し、包んだ規則が有効な CSS になる', () => {
    expect(splitCssRules('@MEDIA PRINT AND (MIN-WIDTH: 10PX){.a{x:1}}')[0].atRules).toEqual([
      '@media print and (min-width:10px)',
    ]);
  });

  it('Chromium の書き出し形と原文が同じキーになる(ブラウザ側の固定)', () => {
    // getCss が返す形(Chromium の selectorText / mediaText)を期待値に書く
    sameKey('.a > .b::before{x:1}', '.a>.b:before{x:1}');
    sameKey(
      '@media print and (min-width: 10px){.a{x:1}}',
      '@media print and (min-width:10px){.a{x:1}}',
    );
    sameKey('[src="x"]{x:1}', "[src='x']{x:1}");
  });
});

describe('照合の経路でのセレクタの並びの展開', () => {
  const keys = (css: string): string[] => [...foldedCssRuleTexts(css).keys()];

  it('.a, .b{…} は .a と .b の 2 つのキーになり、本文は原文のセレクタ + 原文の本文', () => {
    const m = foldedCssRuleTexts('.a , .b{color:red}');
    expect([...m.keys()]).toEqual([k('.a'), k('.b')]);
    expect(m.get(k('.a'))).toBe('.a{color:red}');
    expect(m.get(k('.b'))).toBe('.b{color:red}');
  });

  it('セレクタは正規化してキーにし、本文には原文の書き方(コメント込み)を残す', () => {
    const m = foldedCssRuleTexts('TD > .x ,\n  .b/*c*/.c { x : 1 }');
    expect([...m.keys()]).toEqual([k('td>.x'), k('.b.c')]);
    expect(m.get(k('td>.x'))).toBe('TD > .x{ x : 1 }');
    expect(m.get(k('.b.c'))).toBe('.b/*c*/.c{ x : 1 }');
  });

  it('@media の中でも展開し、前置きの並びを引き継ぐ', () => {
    expect(keys('@media print{.a, .b{x:1}}')).toEqual([
      k('@media print', '.a'),
      k('@media print', '.b'),
    ]);
  });

  it('括弧の中・属性値・文字列・コメント・エスケープの中の , では分けない', () => {
    expect(keys(':is(.a, .b){x:1}')).toEqual([k(':is(.a,.b)')]);
    expect(keys('[title="a,b"]{x:1}')).toEqual([k('[title="a,b"]')]);
    expect(keys('[title=a\\,b]{x:1}')).toEqual([k('[title="a,b"]')]);
    expect(keys('.a/*,*/.b{x:1}')).toEqual([k('.a.b')]);
    expect(keys('.a\\,b{x:1}')).toEqual([k('.a\\,b')]);
    expect(keys('.a:not([x="]"], .c), .b{x:1}')).toEqual([k('.a:not([x="]"],.c)'), k('.b')]);
  });

  it('at-rule と入れ子のブロックを持つ規則は展開しない', () => {
    expect(keys('@page :left, :right{margin:1mm}')).toEqual([k('@page :left,:right')]);
    expect(keys('.a, .b{ .c{x:1} }')).toEqual([k('.a,.b')]);
    expect(keys('@keyframes k{from, to{x:1}}')).toHaveLength(1);
  });

  it('並びの中に同じキーが 2 つある規則・空のセレクタを含む規則は展開しない', () => {
    expect(keys('.a, .a{x:1}')).toEqual([k('.a,.a')]);
    expect(keys('.a , .a\n{x:1}')).toEqual([k('.a,.a')]);
    expect(keys('.a, .A{x:1}')).toEqual([k('.a'), k('.A')]);
    expect(keys('.a, , .b{x:1}')).toHaveLength(1);
  });

  it('公開の splitCssRules は展開しない(canvasCssAssets 用)', () => {
    expect(splitCssRules('.a, .b{x:1}').map((r) => r.key)).toEqual([k('.a,.b')]);
  });

  it('同じ並びの見かけの規則は、並びの順に並ぶ', () => {
    expect(keys('.a{x:1}\n.c, .a{y:2}')).toEqual([k('.c'), k('.a')]);
  });

  it('3 者の mergeCssRuleChanges でも展開して照合する(出現番号は見かけの規則も数える)', () => {
    const base = '.a{x:1}\n.a, .b{y:2}\n';
    const r = mergeCssRuleChanges(base, '.a{x:9}\n.a{y:2}\n.b{y:2}\n', base);
    expect(r).toEqual({
      css: '.a{x:9}\n.a, .b{y:2}\n',
      applied: [k('.a')],
      conflicts: [],
      unmatched: [],
    });
  });

  it.each([
    // 出現の数え方(設計 3.3a 節の表): 物理の規則と見かけの規則を区別せず位置の順で数える
    ['.a{x:1}\n.a, .b{y:2}\n', '.a{x:1}\n.a{y:2}\n.b{y:2}\n'],
    ['.a, .b{y:2}\n.a{x:1}\n', '.a{y:2}\n.b{y:2}\n.a{x:1}\n'],
  ])('原文 %j と GrapesJS 形 %j が同じキー・同じ出現の並びになる', (raw, grapes) => {
    expect(foldedCssRuleTexts(raw)).toEqual(foldedCssRuleTexts(grapes));
    expect(mergeCssRuleChangesFromBaseline(raw, grapes, grapes, raw)).toEqual({
      css: raw,
      applied: [],
      conflicts: [],
      unmatched: [],
    });
    // 物理の規則 `.a{x:1}` の出現だけが変わったら、その物理の規則だけに当たる
    const next = grapes.replace('.a{x:1}', '.a{x:9}');
    expect(mergeCssRuleChangesFromBaseline(raw, grapes, next, raw)).toEqual({
      css: raw.replace('.a{x:1}', '.a{x:9}'),
      applied: [k('.a')],
      conflicts: [],
      unmatched: [],
    });
  });

  it('.a, .b{} は空の出現として扱う(GrapesJS は出さない)', () => {
    const raw = '.a{x:1}\n.a, .b{}\n';
    const grapes = '.a{x:1}\n';
    expect(mergeCssRuleChangesFromBaseline(raw, grapes, grapes, raw)).toEqual({
      css: raw,
      applied: [],
      conflicts: [],
      unmatched: [],
    });
    expect(mergeCssRuleChangesFromBaseline(raw, grapes, '.a{x:2}\n', raw)).toEqual({
      css: '.a{x:2}\n.a, .b{}\n',
      applied: [k('.a')],
      conflicts: [],
      unmatched: [],
    });
  });

  it('追加の錨が見かけの規則に当たったら、物理の規則の後ろへ入れる', () => {
    const raw = '.a, .b{color:red}\n';
    const baseline = '.a{color:red}\n.b{color:red}\n';
    const next = '.a{color:red}\n.n{x:1}\n.b{color:red}\n';
    expect(mergeCssRuleChangesFromBaseline(raw, baseline, next, raw)).toEqual({
      css: '.a, .b{color:red}\n.n{x:1}\n',
      applied: [k('.n')],
      conflicts: [],
      unmatched: [],
    });
  });
});

describe('mergeCssRuleChangesFromBaseline — セレクタの並びへの書き戻し', () => {
  const raw = '.x{color:gray}\n.a, .b{color:red}\n.y{color:gray}\n';
  const baseline = '.x{color:gray}\n.a{color:red}\n.b{color:red}\n.y{color:gray}\n';
  const merge = (next: string, target = raw) =>
    mergeCssRuleChangesFromBaseline(raw, baseline, next, target);

  it('片方だけ変わったら元の位置で分割し、残りは元の宣言のまま', () => {
    expect(merge('.x{color:gray}\n.a{color:blue}\n.b{color:red}\n.y{color:gray}\n')).toEqual({
      css: '.x{color:gray}\n.a{color:blue}\n.b{color:red}\n.y{color:gray}\n',
      applied: [k('.a')],
      conflicts: [],
      unmatched: [],
    });
  });

  it('片方だけ消えたら残りのセレクタだけを元の位置に残す', () => {
    expect(merge('.x{color:gray}\n.b{color:red}\n.y{color:gray}\n')).toEqual({
      css: '.x{color:gray}\n.b{color:red}\n.y{color:gray}\n',
      applied: [k('.a')],
      conflicts: [],
      unmatched: [],
    });
  });

  it('全部同じ変更なら並びのまま本文だけ置き換える(原文のセレクタの書き方を残す)', () => {
    expect(merge('.x{color:gray}\n.a{color:blue}\n.b{color:blue}\n.y{color:gray}\n')).toEqual({
      css: '.x{color:gray}\n.a, .b{color:blue}\n.y{color:gray}\n',
      applied: [k('.a'), k('.b')],
      conflicts: [],
      unmatched: [],
    });
    // 前置きの空白・改行も原文のまま残す(書式の違いだけの本文は同じ変更とみなす)
    const spaced = '.a ,\n.b {color:red}\n';
    expect(
      mergeCssRuleChangesFromBaseline(
        spaced,
        '.a{color:red}\n.b{color:red}\n',
        '.a{color:blue}\n.b{ color: blue; }\n',
        spaced,
      ).css,
    ).toBe('.a ,\n.b {color:blue}\n');
  });

  it('全部消えたら規則ごと消す', () => {
    expect(merge('.x{color:gray}\n.y{color:gray}\n')).toEqual({
      css: '.x{color:gray}\n.y{color:gray}\n',
      applied: [k('.a'), k('.b')],
      conflicts: [],
      unmatched: [],
    });
  });

  it('違う本文に変わったら分割して両方当てる', () => {
    expect(merge('.x{color:gray}\n.a{color:blue}\n.b{color:green}\n.y{color:gray}\n')).toEqual({
      css: '.x{color:gray}\n.a{color:blue}\n.b{color:green}\n.y{color:gray}\n',
      applied: [k('.a'), k('.b')],
      conflicts: [],
      unmatched: [],
    });
    // 片方を変え、もう片方を消す
    expect(merge('.x{color:gray}\n.a{color:blue}\n.y{color:gray}\n').css).toBe(
      '.x{color:gray}\n.a{color:blue}\n.y{color:gray}\n',
    );
  });

  it('ペア側の並びを版種固有に直してあれば、変えたセレクタは競合になり書き換えない', () => {
    const target = '.x{color:gray}\n.a, .b{color:green}\n.y{color:gray}\n';
    expect(
      merge('.x{color:gray}\n.a{color:blue}\n.b{color:red}\n.y{color:gray}\n', target),
    ).toEqual({ css: target, applied: [], conflicts: [k('.a')], unmatched: [] });
  });

  it('競合のセレクタと当てるセレクタが混ざると、競合の側は元の宣言のまま分割する', () => {
    // ペア側は 1 つ目の .a(物理の規則)だけを直してある。.a は出現の形が違うので競合、.b は当てる
    const rawBase = '.a{x:1}\n.a, .b{y:2}\n';
    const target = '.a{x:5}\n.a, .b{y:2}\n';
    expect(
      mergeCssRuleChangesFromBaseline(
        rawBase,
        '.a{x:1}\n.a{y:2}\n.b{y:2}\n',
        '.a{x:1}\n.a{y:3}\n.b{y:3}\n',
        target,
      ),
    ).toEqual({
      css: '.a{x:5}\n.a{y:2}\n.b{y:3}\n',
      applied: [k('.b')],
      conflicts: [k('.a')],
      unmatched: [],
    });
  });

  it('@media の中の並びも入れ子の中で分割する', () => {
    const media = '@media print{\n  .a, .b{color:red}\n}\n';
    expect(
      mergeCssRuleChangesFromBaseline(
        media,
        '@media print{.a{color:red}.b{color:red}}',
        '@media print{.a{color:blue}.b{color:red}}',
        media,
      ),
    ).toEqual({
      css: '@media print{\n  .a{color:blue}\n  .b{color:red}\n}\n',
      applied: [k('@media print', '.a')],
      conflicts: [],
      unmatched: [],
    });
  });

  it('字下げのある並びは、分割した各規則に同じ字下げを付ける', () => {
    const indented = '.x{}\n\t.a,\n\t.b {color:red}\n';
    expect(
      mergeCssRuleChangesFromBaseline(
        indented,
        '.a{color:red}\n.b{color:red}\n',
        '.a{color:red}\n.b{color:blue}\n',
        indented,
      ).css,
    ).toBe('.x{}\n\t.a{color:red}\n\t.b{color:blue}\n');
  });

  it('エスケープした末尾の空白はセレクタの一部として残す', () => {
    const escaped = '.a\\ , .b{color:red}\n';
    expect(
      mergeCssRuleChangesFromBaseline(
        escaped,
        '.a\\ {color:red}\n.b{color:red}\n',
        '.a\\ {color:red}\n.b{color:blue}\n',
        escaped,
      ).css,
    ).toBe('.a\\ {color:red}\n.b{color:blue}\n');
    expect(foldedCssRuleTexts('.q\\ , .b{x:1}\n.q\\ {y:2}').get(k('.q\\'))).toBe('.q\\ {x:1;y:2}');
  });

  it('重複との組み合わせ: .a{x:1} と .a, .b{y:2} で 2 つ目の出現だけ変わると、並びの規則だけを分割する', () => {
    const dup = '.a{x:1}\n.a, .b{y:2}\n';
    expect(
      mergeCssRuleChangesFromBaseline(
        dup,
        '.a{x:1}\n.a{y:2}\n.b{y:2}\n',
        '.a{x:1}\n.a{y:9}\n.b{y:2}\n',
        dup,
      ),
    ).toEqual({
      css: '.a{x:1}\n.a{y:9}\n.b{y:2}\n',
      applied: [k('.a')],
      conflicts: [],
      unmatched: [],
    });
  });

  it('空の並び .a, .b{} の .a に宣言を足すと .a{…} と .b{} に分かれる', () => {
    const empty = '.a, .b{}\n';
    expect(mergeCssRuleChangesFromBaseline(empty, '', '.a{x:1}\n', empty)).toEqual({
      css: '.a{x:1}\n.b{}\n',
      applied: [k('.a')],
      conflicts: [],
      unmatched: [],
    });
    // 両方に同じ宣言を足したら並びのまま
    expect(mergeCssRuleChangesFromBaseline(empty, '', '.a{x:1}\n.b{x:1}\n', empty).css).toBe(
      '.a, .b{x:1}\n',
    );
    // next に同じセレクタの規則が 2 つあれば、その位置に 2 つとも書く
    expect(mergeCssRuleChangesFromBaseline(empty, '', '.a{x:1}\n.a{y:1}\n', empty).css).toBe(
      '.a{x:1}\n.a{y:1}\n.b{}\n',
    );
  });

  it('追加の錨が並びの規則に当たったら、その規則の後ろへ入れる(分割と重ならない)', () => {
    expect(
      merge('.x{color:gray}\n.a{color:blue}\n.b{color:red}\n.n{x:1}\n.y{color:gray}\n'),
    ).toEqual({
      css: '.x{color:gray}\n.a{color:blue}\n.b{color:red}\n.n{x:1}\n.y{color:gray}\n',
      applied: [k('.a'), k('.n')],
      conflicts: [],
      unmatched: [],
    });
  });

  it('3 者の mergeCssRuleChanges でも同じ書き戻しになる', () => {
    expect(
      mergeCssRuleChanges(
        raw,
        '.x{color:gray}\n.a{color:blue}\n.b{color:red}\n.y{color:gray}\n',
        raw,
      ),
    ).toEqual({
      css: '.x{color:gray}\n.a{color:blue}\n.b{color:red}\n.y{color:gray}\n',
      applied: [k('.a')],
      conflicts: [],
      unmatched: [],
    });
    expect(
      mergeCssRuleChanges(
        raw,
        '.x{color:gray}\n.a{color:blue}\n.b{color:blue}\n.y{color:gray}\n',
        raw,
      ).css,
    ).toBe('.x{color:gray}\n.a, .b{color:blue}\n.y{color:gray}\n');
    expect(mergeCssRuleChanges(raw, '.x{color:gray}\n.y{color:gray}\n', raw).css).toBe(
      '.x{color:gray}\n.y{color:gray}\n',
    );
  });
});

describe('mergeCssRuleChangesFromBaseline — 原文と照合できないキー', () => {
  // 正規化と展開で吸収できない食い違いを模す(並びの中の重複は展開しないので、GrapesJS の .a と合わない)
  const raw = '.a, .a{color:red}\n.c{color:red}\n';
  const baseline = '.a{color:red}\n.a{color:red}\n.c{color:red}\n';

  it('変更: 黙って追記せず unmatched に出す', () => {
    const r = mergeCssRuleChangesFromBaseline(
      raw,
      baseline,
      '.a{color:red}\n.a{color:blue}\n.c{color:red}\n',
      raw,
    );
    expect(r.unmatched).toEqual([k('.a')]);
    expect(r.applied).toEqual([]);
    expect(r.conflicts).toEqual([]);
    expect(r.css).toBe(raw);
  });

  it('削除: 何もしなかったことにせず unmatched に出す', () => {
    const r = mergeCssRuleChangesFromBaseline(raw, baseline, '.c{color:red}\n', raw);
    expect(r.unmatched).toEqual([k('.a')]);
    expect(r.applied).toEqual([]);
    expect(r.css).toBe(raw);
  });

  it('ペア側が既に next と同じ形なら unmatched にしない', () => {
    const target = `${raw}.a{color:red}\n.a{color:blue}\n`;
    const r = mergeCssRuleChangesFromBaseline(
      raw,
      baseline,
      '.a{color:red}\n.a{color:blue}\n.c{color:red}\n',
      target,
    );
    expect(r.unmatched).toEqual([]);
    expect(r.conflicts).toEqual([]);
    expect(r.css).toBe(target);
  });

  it('照合できるキーの変更は今までどおり当てる(unmatched は空)', () => {
    const r = mergeCssRuleChangesFromBaseline(
      raw,
      baseline,
      '.a{color:red}\n.a{color:red}\n.c{color:blue}\n',
      raw,
    );
    expect(r.unmatched).toEqual([]);
    expect(r.applied).toEqual([k('.c')]);
    expect(r.css).toBe('.a, .a{color:red}\n.c{color:blue}\n');
  });

  it('3 者が同じ物差しの mergeCssRuleChanges では unmatched は常に空', () => {
    const changed = mergeCssRuleChanges('.a{color:red}\n', '.a{color:blue}\n', '.a{color:red}\n');
    expect(changed.unmatched).toEqual([]);
    expect(changed.applied).toEqual([k('.a')]);
    const removed = mergeCssRuleChanges('.a{color:red}\n.b{x:1}\n', '.b{x:1}\n', '.b{x:1}\n');
    expect(removed.unmatched).toEqual([]);
  });
});
