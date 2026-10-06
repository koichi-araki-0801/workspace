// =============================================================================
// jinjaReproCases.ts — dig で見つけた往復の再現ケース
// =============================================================================
// `fillJinja.repro.dom.test.ts`(jsdom で読み直す経路)と `fillJinja.corpus.dom.test.ts`(linkedom・
// キャンバス経由)の両方が同じ表を使う。テストファイルから表を export すると、import した側でも
// そのファイルの describe が登録されて二重に走るため、表だけをここに置く。

/** [名前, 原文, サンプル]。 */
export const REPRO_CASES: [string, string, Record<string, unknown>][] = [
  [
    'if の中の for',
    '<div>{% if show %}<table><tbody>{% for r in rows %}<tr><td>{{ r.a }}</td></tr>{% endfor %}</tbody></table>{% endif %}</div>',
    { show: true, rows: [{ a: 1 }, { a: 2 }] },
  ],
  [
    'if の中の script と数式',
    '<div>{% if show %}<div class="c"><script>f()</script>$$x^2$$</div>{% endif %}</div>',
    { show: true },
  ],
  [
    '入れ子の if',
    '<div>{% if a %}<p>1</p>{% if b %}<p>2</p>{% endif %}{% endif %}</div>',
    { a: true, b: true },
  ],
  [
    'tbody の中の複数行の if',
    '<table><tbody>{% if x %}<tr><td>a</td></tr><tr><td>b</td></tr>{% endif %}</tbody></table>',
    { x: true },
  ],
  ['svg の text の出力', '<svg><text x="1">{{ v }}</text></svg>', { v: 3 }],
  [
    '複数の兄弟を持つ for',
    '<table><tbody>{% for r in rows %}<tr><td>{{ r }}</td></tr><tr><td>sub</td></tr>{% endfor %}</tbody></table>',
    { rows: [1, 2] },
  ],
  [
    'elif',
    '<div>{% if a %}<p>A</p>{% elif b %}<p>B</p>{% else %}<p>C</p>{% endif %}</div>',
    { a: false, b: true },
  ],
  ['空白制御', '<div>{% if a -%}<p>A</p>{%- endif %}</div>', { a: true }],
  ['本文中の style', '<div><style>.a{color:{{ c }}}</style></div>', { c: 'red' }],
  [
    '表の中の地の出力',
    '<table><tbody>{% for r in rows %}{{ r }}{% endfor %}</tbody></table>',
    { rows: [1] },
  ],
  [
    'td の中の固めた表',
    '<table><tbody><tr><td><table><tbody>{% for r in rows %}{{ r }}{% endfor %}</tbody></table></td></tr></tbody></table>',
    { rows: [1, 2] },
  ],
  ['raw ブロック', '<p>a{% raw %}{{ x }}{% endraw %}b</p>', {}],
  [
    'endif -%} と複数要素の枝',
    '<div>{% if a %}<p>1</p><p>2</p>{% endif -%}\n<p>3</p></div>',
    { a: true },
  ],
  [
    'for-else の空の列',
    '<ul>{% for x in xs %}<li>{{ x }}</li>{% else %}<li>無</li>{% endfor %}</ul>',
    { xs: [] },
  ],
  [
    '属性値の中の if',
    '<p class="{% if a %}up{% else %}down{% endif %}">{{ v }}</p>',
    { a: true, v: 1 },
  ],
  ['タグの中の if', '<p {% if a %}hidden{% endif %}>x</p>', { a: true }],
  [
    '枝をまたぐ要素',
    '<section><div>{% if a %}<p>1</p></div><div>{% else %}<p>2</p>{% endif %}</div></section>',
    { a: true },
  ],
  ['表の中の set', '<table><tbody>{% set n = 1 %}<tr><td>{{ n }}</td></tr></tbody></table>', {}],
  ['本文の先頭のブロック', '{% if a %}<p>x</p>{% endif %}<p>y</p>', { a: true }],
];
