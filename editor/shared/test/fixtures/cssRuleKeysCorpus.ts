// =============================================================================
// cssRuleKeysCorpus.ts — CSS 規則のキーの正規化を実 GrapesJS と突き合わせる合成ケース
// =============================================================================
// web の dom テスト(jsdom 上の GrapesJS)と e2e の Chromium の spec が同じコーパスを回す。
// 実テンプレの代表(`web/src/api/fixtures/css/*.css`)は各テストが読み込み、ここには書き方を
// 変えた合成ケースと、正規化と並びの展開で吸収できない既知の食い違いだけを置く。

/** 正規化の規則(設計 3.2 節)と並びの展開(3.3a 節)ごとに、原文の書き方を変えた CSS。 */
export const SYNTHETIC: Record<string, string> = {
  combinators: '.a > .b{color:red}\n.a + .b{color:red}\n.a ~ .b{color:red}\n',
  legacyPseudo: 'p:before{content:"x"}\np:after{content:"y"}\n',
  upper: 'DIV.note{color:red}\n[DATA-X=a]{color:red}\na:HOVER{color:red}\n',
  media: '@MEDIA PRINT AND (MIN-WIDTH: 10PX){.a{color:red}}\n',
  page: '@page:first{margin:0}\n',
  comment: '.a/**/.b{color:red}\n',
  parens: ':not( .a ){color:red}\n',
  // GrapesJS はセレクタごとの規則に分けて書き出すので、原文側の展開で一致する。
  list: '.a, .b{color:red}\n',
  // クラスでないセレクタは直前の規則の `selectorsAdd` に寄る。
  listAdd: '.a, div p{color:red}\n',
  listDup: '.a{color:red}\n.a, .b{color:blue}\n',
  listMedia: '@media print{.a, .b{color:red}}\n',
  listEmpty: '.a, .b{}\n',
  // 括弧の中の `,` では分けない。
  isList: ':is(.a, .b){color:red}\n',
  // 並びの中に同じセレクタが 2 つある規則は展開しない(KNOWN_UNMATCHED を見よ)。
  listSame: '.a, .a{color:red}\n',
};

/**
 * 正規化と展開で吸収できない既知の食い違い(コーパスの名前 → getCss 側にだけ現れるキー)。
 * ここに載ったキーは照合不可の競合になる。
 */
export const KNOWN_UNMATCHED: Record<string, string[]> = {
  // GrapesJS は `.a{…}` を 2 つ書き出すが、原文は 1 つの物理の規則なので、2 つの出現を規則の中で
  // 分けて当てる先が無い。展開せず並びのキー(`.a,.a`)のまま残し、`.a` の変更は照合不可にする。
  listSame: [JSON.stringify(['.a'])],
};
