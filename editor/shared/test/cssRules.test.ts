// =============================================================================
// cssRules.test.ts — CSS の規則分割と、承認で変わった規則だけをペア側へ当てる 3 者比較
// =============================================================================
import { describe, expect, it } from 'vitest';
import { mergeCssRuleChanges, sameCssRule, splitCssRules } from '../src/css/cssRules.js';

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
    expect(splitCssRules('.a   >  .b ,\n .c {x:1}').map((r) => r.key)).toEqual([k('.a > .b,.c')]);
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
    expect(r).toEqual({ css: '.a{x:2}\n.b{y:1}\n.t{z:1}\n', applied: [k('.a')], conflicts: [] });
  });

  it('ペア側が base と違えば競合として飛ばす', () => {
    const target = '.a{x:9}\n.b{y:1}\n';
    const r = mergeCssRuleChanges('.a{x:1}\n.b{y:1}\n', '.a{x:2}\n.b{y:1}\n', target);
    expect(r).toEqual({ css: target, applied: [], conflicts: [k('.a')] });
  });

  it('ペア側に無い規則の変更は競合', () => {
    const r = mergeCssRuleChanges('.a{x:1}\n', '.a{x:2}\n', '.t{z:1}\n');
    expect(r).toEqual({ css: '.t{z:1}\n', applied: [], conflicts: [k('.a')] });
  });

  it('ペア側が既に next と同じなら何もしない', () => {
    const r = mergeCssRuleChanges('.a{x:1}\n', '.a{x:2}\n', '.a{x:2}\n');
    expect(r).toEqual({ css: '.a{x:2}\n', applied: [], conflicts: [] });
  });

  it('変わっていない規則には、ペア側が違っていても触らない', () => {
    const r = mergeCssRuleChanges('.b{y:1}\n', '.b{y:1}\n', '.b{y:7}\n');
    expect(r).toEqual({ css: '.b{y:7}\n', applied: [], conflicts: [] });
  });

  it('空白だけの違いは同じ規則とみなす', () => {
    const r = mergeCssRuleChanges('.a{x:1}', '.a{x:2}', '.a { x: 1 }\n');
    expect(r).toEqual({ css: '.a{x:2}\n', applied: [k('.a')], conflicts: [] });
  });

  it('削除は、ペア側が base と同じなら行ごと消す', () => {
    const r = mergeCssRuleChanges('.a{x:1}\n.b{y:1}\n', '.b{y:1}\n', '.a{x:1}\n.b{y:1}\n');
    expect(r).toEqual({ css: '.b{y:1}\n', applied: [k('.a')], conflicts: [] });
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
    expect(r).toEqual({ css: target, applied: [], conflicts: [k('.a')] });
  });

  it('削除で、ペア側に既に無ければ何もしない', () => {
    const r = mergeCssRuleChanges('.a{x:1}\n.b{y:1}\n', '.b{y:1}\n', '.b{y:1}\n');
    expect(r).toEqual({ css: '.b{y:1}\n', applied: [], conflicts: [] });
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
    });
  });

  it('連続する追加は next の順でまとめて入れる', () => {
    const r = mergeCssRuleChanges('.a{}', '.a{}\n.b{}\n.c{}', '.a{}');
    expect(r).toEqual({ css: '.a{}\n.b{}\n.c{}', applied: [k('.b'), k('.c')], conflicts: [] });
  });

  it('直前の規則がペア側に無ければ末尾へ入れる', () => {
    const r = mergeCssRuleChanges('.a{x:1}\n', '.n{q:1}\n.a{x:1}\n', '.a{x:1}\n.t{w:1}');
    expect(r).toEqual({ css: '.a{x:1}\n.t{w:1}\n.n{q:1}\n', applied: [k('.n')], conflicts: [] });
  });

  it('@media の中の追加は、同じ @media の直前の規則の後ろへインデントを合わせて入れる', () => {
    const base = '@media print {\n  .a{x:1}\n}\n';
    const next = '@media print {\n  .a{x:1}\n  .b{y:1}\n}\n';
    const r = mergeCssRuleChanges(base, next, base);
    expect(r).toEqual({ css: next, applied: [k('@media print', '.b')], conflicts: [] });
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
    });
  });

  it('追加した規則がペア側に既にあれば、同じなら何もせず、違えば競合', () => {
    expect(mergeCssRuleChanges('', '.a{x:1}', '.a{x:1}')).toEqual({
      css: '.a{x:1}',
      applied: [],
      conflicts: [],
    });
    expect(mergeCssRuleChanges('', '.a{x:1}', '.a{x:2}')).toEqual({
      css: '.a{x:2}',
      applied: [],
      conflicts: [k('.a')],
    });
  });

  it('重複セレクタは出現順の番号で対応づけて当てる', () => {
    const r = mergeCssRuleChanges('.a{x:1}\n.a{x:2}\n', '.a{x:1}\n.a{x:3}\n', '.a{x:1}\n.a{x:2}\n');
    expect(r).toEqual({ css: '.a{x:1}\n.a{x:3}\n', applied: [k('.a', 2)], conflicts: [] });
  });

  it('文字列やコメントに括弧を含む規則も壊さずに当てる', () => {
    const base = '/* } */\n.q::before{content:"{"}\n.r{x:1}\n';
    const next = '/* } */\n.q::before{content:"}"}\n.r{x:1}\n';
    const r = mergeCssRuleChanges(base, next, base);
    expect(r).toEqual({ css: next, applied: [k('.q::before')], conflicts: [] });
  });

  it('規則の間のコメントだけの違いは同期しない', () => {
    const target = '/* t */\n.a{x:1}\n';
    const r = mergeCssRuleChanges('/* c1 */\n.a{x:1}\n', '/* c2 */\n.a{x:1}\n', target);
    expect(r).toEqual({ css: target, applied: [], conflicts: [] });
  });

  it('空の CSS どうし・空のペア側への追加', () => {
    expect(mergeCssRuleChanges('', '', '')).toEqual({ css: '', applied: [], conflicts: [] });
    expect(mergeCssRuleChanges('', '', '.t{}')).toEqual({
      css: '.t{}',
      applied: [],
      conflicts: [],
    });
    expect(mergeCssRuleChanges('', '.a{x:1}', '')).toEqual({
      css: '.a{x:1}\n',
      applied: [k('.a')],
      conflicts: [],
    });
  });

  it('空白だけの base でも追加を当てる', () => {
    expect(mergeCssRuleChanges('  \n', '.a{x:1}', '')).toEqual({
      css: '.a{x:1}\n',
      applied: [k('.a')],
      conflicts: [],
    });
  });

  it('@media の中の規則の置き換えは本体だけを差し替え、前置きと閉じ括弧を保つ', () => {
    const base = '@media print {\n  .a{x:1}\n  .b{y:1}\n}\n';
    const next = '@media print {\n  .a{x:2}\n  .b{y:1}\n}\n';
    const r = mergeCssRuleChanges(base, next, base);
    expect(r).toEqual({ css: next, applied: [k('@media print', '.a')], conflicts: [] });
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
    expect(r).toEqual({ css: '.a{x:2}\n.b{y:1}\n', applied: [k('.a'), k('.b')], conflicts: [] });
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
    expect(r).toEqual({ css: target, applied: [], conflicts: [k('@page')] });
  });

  it('@page の変更をペア側が base のままならその場で置き換える', () => {
    const r = mergeCssRuleChanges(
      '@page{margin:10mm}\n.a{}\n',
      '@page{margin:12mm}\n.a{}\n',
      '@page{margin:10mm}\n.a{}\n',
    );
    expect(r).toEqual({ css: '@page{margin:12mm}\n.a{}\n', applied: [k('@page')], conflicts: [] });
  });

  it('@font-face の src 変更は同じ family/weight/style の変更として扱う', () => {
    const base = '@font-face{font-family:A;font-weight:400;src:url(a.woff2)}\n';
    const next = '@font-face{font-family:A;font-weight:400;src:url(a2.woff2)}\n';
    const key = k('@font-face{font-family:a;font-weight:400;font-style:}');
    expect(mergeCssRuleChanges(base, next, base)).toEqual({
      css: next,
      applied: [key],
      conflicts: [],
    });
    const edited = '@font-face{font-family:A;font-weight:400;src:url(mine.woff2)}\n';
    expect(mergeCssRuleChanges(base, next, edited)).toEqual({
      css: edited,
      applied: [],
      conflicts: [key],
    });
  });
});
