// =============================================================================
// jinjaCorpusGen.ts — 往復コーパスの乱数生成ケース
// =============================================================================
// 種(seed)を固定した小さい生成器。依存(fast-check)を足さずに、要素とブロックの入れ子を
// 組み合わせた往復の入力を作る。失敗した種と番号はテスト名に出るので、その 1 件だけを再現できる。
// 生成する入力は作成タブが扱う文法の内側に留める(閉じたブロック・既知のタグ・対応の取れた要素)。

/** 32 bit の種から [0, 1) の一様乱数列を作る(mulberry32)。同じ種なら同じ列になる。 */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

type Gen = { r: () => number; depth: number };
const pick = <T>(g: Gen, xs: readonly T[]): T => xs[Math.floor(g.r() * xs.length)] as T;

function flow(g: Gen): string {
  if (g.depth > 3) return pick(g, ['text', '{{ v }}', '<b>{{ w }}</b>']);
  const d = { ...g, depth: g.depth + 1 };
  const n = 1 + Math.floor(g.r() * 3);
  return Array.from({ length: n }, () =>
    pick(g, [
      () => `<p>${inline(d)}</p>`,
      () => `<div class="c">${flow(d)}</div>`,
      () => `{% if a %}${flow(d)}{% elif b %}${flow(d)}{% else %}${flow(d)}{% endif %}`,
      () => `{% if c -%}${flow(d)}{%- endif %}`,
      () => `{% for x in xs %}${flow(d)}{% else %}<p>無</p>{% endfor %}`,
      () => `<ul>{% for x in xs %}<li>{{ x }}</li><li>補</li>{% endfor %}</ul>`,
      () => `<table><tbody>${rows(d)}</tbody></table>`,
      () => `<svg viewBox="0 0 9 9"><text>${pick(g, ['{{ v }}', '固定'])}</text></svg>`,
      () => '<script>f({{ v }})</script>',
      () => '{# メモ #}',
    ])(),
  ).join(pick(g, ['', '\n', ' ']));
}

function inline(g: Gen): string {
  return pick(g, [
    '{{ v }} 円',
    '{% if a %}はい{% else %}いいえ{% endif %}',
    '前{% for x in xs %}{{ x }},{% endfor %}後',
    '地の文',
  ]);
}

function rows(g: Gen): string {
  return pick(g, [
    '{% for x in xs %}<tr><td>{{ x }}</td></tr><tr><td>副</td></tr>{% endfor %}',
    '{% if a %}<tr><td>A</td></tr>{% elif b %}<tr><td>B</td></tr>{% endif %}',
    '{% set n = 1 %}<tr><td>{{ n }}</td></tr>',
    '{% for x in xs %}{{ x }}{% endfor %}',
  ]);
}

export function generateCases(
  seed: number,
  count: number,
): { raw: string; sample: Record<string, unknown> }[] {
  const r = mulberry32(seed);
  return Array.from({ length: count }, () => {
    const g = { r, depth: 0 };
    return {
      raw: flow(g),
      sample: {
        a: r() < 0.5,
        b: r() < 0.5,
        c: r() < 0.5,
        v: 7,
        w: '<x>',
        xs: r() < 0.3 ? [] : ['甲', '乙', '丙'],
      },
    };
  });
}
