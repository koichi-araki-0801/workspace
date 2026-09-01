# 編集キャンバスの赤入れ表示 実装計画

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 編集タブのキャンバスで、確定版から変わった旧文言を取り消し線付きでインライン表示し、追加・削除された要素を枠色で示す（トグルで OFF 可、保存内容には一切載せない）。

**Architecture:** 差分は GrapesJS の **モデル木**（live）と `Parser.parseHtml(確定版 HTML)` の **定義木**（基準）を同じ平坦ツリーへ写して純関数で計算する。表示は canvas iframe の **生 DOM だけ**に `<del data-redline>` と属性・CSS Highlight を置き、モデルには載せない（`getHtml()` はモデルから再生成するので draft に混入しない）。選択・drag・RTE のたびに装飾を外して RTE の再取込に巻き込まれないようにする。

**Tech Stack:** Vue 3 / GrapesJS 0.23.6 / TypeScript / vitest (jsdom) / Playwright / Biome

**Spec:** `docs/superpowers/specs/2026-09-02-editor-canvas-redline-design.md`

## Global Constraints

- 編集 2 系統の原則: 経路判定は `route.query.created === '1'` のみ。作成経路では赤入れ機能を無効（`available=false`）にし、トグルも出さない。`jinjaComponents.ts` / `setVarsHighlight` の挙動は変えない。
- 保存経路（`getHtml` / snapshot / 申請 / PDF）へ触らない。装飾はモデルに載せない。
- コメント規約は `docs/コメント規約.md`（なぜを書く / 日本語散文 + 英語ドメイン用語 / 識別子はバッククォート / 100 桁）。経緯・日付・所見番号は書かない。
- `editor/**` を変更したコミットの前に `pnpm exec biome check --write editor/web/<対象ファイル>` を先行実行する（lint-staged のステージ入れ替わり事故の回避）。
- 全コマンドはリポジトリルート `C:\Users\caads\workspace` から実行する。単体テストは `pnpm exec vitest run <path>`（ルート `vitest.config.ts` の projects 経由。web は jsdom）。
- コミットメッセージは日本語の Conventional Commits（例: `feat(editor): …`）。末尾に次の 1 行を必ず付ける:
  `Claude-Session: https://claude.ai/code/session_01NS7sXef8dsEyg8qNYRtcYv`
- 作業ツリーに本件と無関係の未コミット変更がある（`editor/web/src/features/reviews/ReviewQueueView.vue` / `editor/web/test/reviewQueueView.test.ts` / `docs/editor/images/*.png` / `docs/editor/editor_手引き.html`）。**これらは `git add` しない**。各タスクで対象ファイルだけを明示的に add する。
- GrapesJS の事実（変更不可の前提）: live view の要素には自動 `id` と `data-gjs-type` が必ず付く。`Component.get('attributes')` には明示属性しか無い。パーサは「子がテキスト 1 つだけの要素」を `type:'text'` + `components: {type:'textnode', content}`（**配列でなくオブジェクト**）にする。`classes` は文字列配列。RTE は開始時（`onActive`）に `el.innerHTML` を読み、終了時に変化があれば `resetFromString` でモデルへ再取込する。

---

## ファイル構成

| 種別 | パス | 責務 |
|---|---|---|
| 変更 | `editor/web/src/lib/blockKey.ts` | 整列キー規則を要素依存でない `rawKeyFromParts` に切り出し、`rawKey(el)` はそれを呼ぶ |
| 新規 | `editor/web/src/features/editor/redline/redlineTree.ts` | 平坦ツリー型 `RedlineNode` と 2 アダプタ（`fromDefinitions` / `fromComponents`）、削除要素の DOM 構築 `renderDefinition` |
| 新規 | `editor/web/src/features/editor/redline/redlineDiff.ts` | 純関数 `diffRedline(base, live, budget) → RedlineOp[]` |
| 新規 | `editor/web/src/features/editor/redline/redlineApply.ts` | `applyRedline` / `clearRedline` / `clearRedlineWithin`（生 DOM 操作） |
| 新規 | `editor/web/src/features/editor/redline/redlineCss.ts` | canvas 注入 CSS と body クラス名 |
| 新規 | `editor/web/src/features/editor/redline/useRedline.ts` | composable（基準確保・再計算スケジュール・安全弁・トグル） |
| 変更 | `editor/web/src/features/editor/partKey.ts` | `partEls` から `[data-redline]` を除外 |
| 変更 | `editor/web/src/features/editor/useGrapes.ts` | canvas CSS に `redlineCanvasCss` を連結 |
| 変更 | `editor/web/src/features/editor/useTemplateEditor.ts` | `useRedline` の配線（基準セット・選択・drag・RTE 終了・トグル公開） |
| 変更 | `editor/web/src/features/editor/EditorTopBar.vue` / `EditorView.vue` | トグルボタン |
| 変更 | `vitest.config.ts` | coverage include へ 4 ファイル追加 |
| 新規 | `editor/web/test/redlineTree.test.ts` / `redlineDiff.test.ts` / `redlineApply.test.ts` | 単体テスト |
| 変更 | `editor/web/test/partKey.test.ts` | `[data-redline]` 除外のテスト |
| 変更 | `editor/e2e/canvas.spec.ts` | 実画面テスト |
| 変更 | `docs/editor/src/設計正典.md` / `設計書.md` / `操作手順書.md` / `Editor_仕様一覧.md` / 設計書 spec | ドキュメント |

---

### Task 1: `blockKey.rawKeyFromParts` — 要素に依存しない整列キー

**Files:**
- Modify: `editor/web/src/lib/blockKey.ts`
- Test: `editor/web/test/partKey.test.ts`（既存の `describe('blockKey.rawKey')` の隣へ追加）

**Interfaces:**
- Produces: `export function rawKeyFromParts(p: { partId?: string | null; id?: string | null; firstClass?: string | null; tag: string }): string` — `data-part-id → id → .先頭class → tag（小文字）` の優先順。空文字・null は「無し」扱い。
- `rawKey(el)` の戻り値は従来と不変（`partKey.test.ts` の既存テストが固定）。

- [ ] **Step 1: 失敗するテストを書く**

`editor/web/test/partKey.test.ts` の import を `import { occurrenceKey, rawKey, rawKeyFromParts } from '@/lib/blockKey';` に変え、`describe('blockKey.rawKey', …)` の直後へ追加:

```ts
describe('blockKey.rawKeyFromParts', () => {
  it('rawKey(el) と同じ優先順で、要素を持たずにキーを作る', () => {
    expect(rawKeyFromParts({ partId: 'cover', id: 'x', firstClass: 'c', tag: 'div' })).toBe('cover');
    expect(rawKeyFromParts({ id: 'x', firstClass: 'c', tag: 'div' })).toBe('x');
    expect(rawKeyFromParts({ firstClass: 'c', tag: 'div' })).toBe('.c');
    expect(rawKeyFromParts({ tag: 'SECTION' })).toBe('section');
    // 空文字・null は「無し」として次の候補へ落ちる
    expect(rawKeyFromParts({ partId: '', id: null, firstClass: '', tag: 'p' })).toBe('p');
  });
});
```

- [ ] **Step 2: 失敗を確認**

Run: `pnpm exec vitest run editor/web/test/partKey.test.ts`
Expected: FAIL（`rawKeyFromParts` が export されていない）

- [ ] **Step 3: 実装**

`editor/web/src/lib/blockKey.ts` の `rawKey` を次に置き換える:

```ts
/**
 * 要素を持たずにアンカーを決める版。編集キャンバスの赤入れ（`features/editor/redline/`）は
 * GrapesJS のモデル木と定義木を整列させるため、DOM 要素ではなく属性の断片からキーを作る
 * 必要がある。規則は `rawKey` と 1 か所で共有する（片方だけ変わると版を跨ぐ対応づけが崩れる）。
 */
export function rawKeyFromParts(p: {
  partId?: string | null;
  id?: string | null;
  firstClass?: string | null;
  tag: string;
}): string {
  return p.partId || p.id || (p.firstClass ? `.${p.firstClass}` : '') || p.tag.toLowerCase();
}

/** element のアンカー: catalog part id → element id → 先頭 class → tag 名 の順で決める。 */
export function rawKey(el: HTMLElement): string {
  return rawKeyFromParts({
    partId: el.getAttribute('data-part-id'),
    id: el.id,
    firstClass: el.classList[0] ?? null,
    tag: el.tagName,
  });
}
```

- [ ] **Step 4: テスト通過を確認**

Run: `pnpm exec vitest run editor/web/test/partKey.test.ts editor/web/test/htmlBlockDiff.test.ts`
Expected: PASS（`htmlBlockDiff` は `rawKey` の利用側。挙動不変の確認）

- [ ] **Step 5: コミット**

```bash
pnpm exec biome check --write editor/web/src/lib/blockKey.ts editor/web/test/partKey.test.ts
git add editor/web/src/lib/blockKey.ts editor/web/test/partKey.test.ts
git commit -m "refactor(editor): 整列キーの規則を要素非依存の rawKeyFromParts へ切り出す

Claude-Session: https://claude.ai/code/session_01NS7sXef8dsEyg8qNYRtcYv"
```

---

### Task 2: `redlineTree.ts` — 平坦ツリーと 2 つのアダプタ

**Files:**
- Create: `editor/web/src/features/editor/redline/redlineTree.ts`
- Test: `editor/web/test/redlineTree.test.ts`

**Interfaces:**
- Consumes: `rawKeyFromParts`（Task 1）、`ComponentDefinition` / `Component`（`grapesjs` の型）。
- Produces:

```ts
export type NodeResolver = () => Node | null;
export interface RedlineNode {
  kind: 'el' | 'text';
  /** 兄弟内で一意。要素は `rawKey#n`、テキストは `#text#n`。 */
  key: string;
  tag?: string;
  text?: string;
  children: RedlineNode[];
  /** live 側: canvas DOM 上の対応ノード（要素 or Text）。基準側は常に null を返す。 */
  node: NodeResolver;
  /** 基準側のみ: removed 表示のための定義。 */
  def?: ComponentDefinition;
}
export function fromDefinitions(defs: ComponentDefinition | ComponentDefinition[] | undefined): RedlineNode[];
export function fromComponents(root: Component): RedlineNode[];
export function renderDefinition(def: ComponentDefinition, doc: Document): Node;
```

- 空白のみのテキストは両アダプタとも除く（`htmlBlockDiff.childUnits` と同じ）。
- `type:'text'` で子が無く `content` が非空の要素は、`content` を 1 個のテキスト子として正規化する。live 側のそのテキストの `node` は `親el.firstChild`（Text なら）を返す。

- [ ] **Step 1: 失敗するテストを書く**

`editor/web/test/redlineTree.test.ts`:

```ts
import type { Component, ComponentDefinition } from 'grapesjs';
import { describe, expect, it } from 'vitest';
import {
  fromComponents,
  fromDefinitions,
  renderDefinition,
} from '@/features/editor/redline/redlineTree';

/** GrapesJS パーサが返す定義の形（子テキスト 1 つは配列でなくオブジェクト）を手で組む。 */
const textDef = (content: string): ComponentDefinition => ({ type: 'textnode', content });

describe('fromDefinitions', () => {
  it('要素は rawKey#n、テキストは #text#n のキーになり、空白のみテキストは除く', () => {
    const defs: ComponentDefinition[] = [
      { tagName: 'div', attributes: { 'data-part-id': 'cover' }, components: [textDef(' ')] },
      { tagName: 'p', classes: ['lead'], components: [textDef('a'), { tagName: 'b', components: textDef('x') }, textDef('c')] },
      { tagName: 'p', classes: ['lead'], components: textDef('second') },
    ];
    const t = fromDefinitions(defs);
    expect(t.map((n) => n.key)).toEqual(['cover#1', '.lead#1', '.lead#2']);
    expect(t[0].children).toEqual([]);
    expect(t[1].children.map((n) => n.key)).toEqual(['#text#1', 'b#1', '#text#2']);
    expect(t[1].children[0].text).toBe('a');
    expect(t[1].children[1].children[0].text).toBe('x');
  });

  it('components がオブジェクト 1 個でも配列でも同じ木になる', () => {
    const a = fromDefinitions([{ tagName: 'p', components: textDef('hi') }]);
    const b = fromDefinitions([{ tagName: 'p', components: [textDef('hi')] }]);
    expect(a[0].children.map((n) => n.text)).toEqual(['hi']);
    expect(b[0].children.map((n) => n.text)).toEqual(['hi']);
  });

  it('text 型で子が無く content だけ持つ要素は content をテキスト子へ正規化する', () => {
    const t = fromDefinitions([{ tagName: 'p', type: 'text', content: 'body' }]);
    expect(t[0].children).toHaveLength(1);
    expect(t[0].children[0]).toMatchObject({ kind: 'text', key: '#text#1', text: 'body' });
  });

  it('jinja chip は要素として保持し、classes が {name} 形式でも先頭 class を読む', () => {
    const t = fromDefinitions([
      {
        tagName: 'span',
        type: 'jinja-var',
        classes: [{ name: 'jinja-chip' }, { name: 'jinja-var' }] as unknown as string[],
        attributes: { 'data-jinja': '{{ fund.name }}' },
        components: textDef('ファンドA'),
      },
    ]);
    expect(t[0]).toMatchObject({ kind: 'el', key: '.jinja-chip#1', tag: 'span' });
    expect(t[0].children[0].text).toBe('ファンドA');
    expect(t[0].node()).toBeNull();
    expect(t[0].def).toBeDefined();
  });
});

/** GrapesJS Component の最小フェイク（読むメソッドだけ）。 */
function fakeComp(o: {
  type?: string;
  tagName?: string;
  attributes?: Record<string, string>;
  classes?: string[];
  content?: string;
  children?: Component[];
  el?: Node | null;
}): Component {
  const kids = o.children ?? [];
  return {
    get: (k: string) => (o as Record<string, unknown>)[k],
    getClasses: () => o.classes ?? [],
    components: () => ({ length: kids.length, map: <T>(f: (c: Component) => T) => kids.map(f) }),
    getEl: () => o.el ?? null,
  } as unknown as Component;
}

describe('fromComponents', () => {
  it('モデル木を同じ形へ写し、node が live の要素 / Text を返す', () => {
    const p = document.createElement('p');
    p.textContent = 'hello';
    const textEl = p.firstChild as Text;
    const root = fakeComp({
      type: 'wrapper',
      children: [
        fakeComp({
          tagName: 'p',
          type: 'text',
          classes: ['lead'],
          // GrapesJS の自動 id は view の属性で、モデルの attributes には現れない。
          attributes: { 'data-x': '1' },
          el: p,
          children: [fakeComp({ type: 'textnode', content: 'hello', el: textEl })],
        }),
      ],
    });
    const t = fromComponents(root);
    expect(t.map((n) => n.key)).toEqual(['.lead#1']);
    expect(t[0].node()).toBe(p);
    expect(t[0].children[0]).toMatchObject({ kind: 'text', key: '#text#1', text: 'hello' });
    expect(t[0].children[0].node()).toBe(textEl);
  });

  it('text 型で子が無く content だけの Component は親 el の firstChild をテキストとして返す', () => {
    const p = document.createElement('p');
    p.textContent = 'body';
    const root = fakeComp({
      children: [fakeComp({ tagName: 'p', type: 'text', content: 'body', el: p })],
    });
    const t = fromComponents(root);
    expect(t[0].children[0].text).toBe('body');
    expect(t[0].children[0].node()).toBe(p.firstChild);
  });

  it('空白のみの textnode は除く', () => {
    const root = fakeComp({
      children: [fakeComp({ type: 'textnode', content: '\n  ' }), fakeComp({ tagName: 'hr' })],
    });
    expect(fromComponents(root).map((n) => n.key)).toEqual(['hr#1']);
  });
});

describe('renderDefinition', () => {
  it('定義から DOM を組み、本文と属性値はエスケープされた文字列のまま出る', () => {
    const node = renderDefinition(
      {
        tagName: 'p',
        classes: ['x'],
        attributes: { title: '"><img onerror=alert(1)>', id: 'dup', 'data-gjs-type': 'text', onclick: 'x()' },
        components: [textDef('<img src=x onerror=alert(1)>'), { tagName: 'br' }],
      },
      document,
    );
    const el = node as HTMLElement;
    expect(el.tagName).toBe('P');
    expect(el.className).toBe('x');
    expect(el.getAttribute('title')).toBe('"><img onerror=alert(1)>');
    // id（重複 id を作らない）・`on*`・`data-gjs-*` は写さない
    expect(el.hasAttribute('id')).toBe(false);
    expect(el.hasAttribute('onclick')).toBe(false);
    expect(el.hasAttribute('data-gjs-type')).toBe(false);
    expect(el.querySelector('img')).toBeNull();
    expect(el.firstChild?.nodeType).toBe(Node.TEXT_NODE);
    expect(el.textContent).toBe('<img src=x onerror=alert(1)>');
    expect(el.querySelector('br')).not.toBeNull();
  });
});
```

- [ ] **Step 2: 失敗を確認**

Run: `pnpm exec vitest run editor/web/test/redlineTree.test.ts`
Expected: FAIL（モジュールが無い）

- [ ] **Step 3: 実装**

`editor/web/src/features/editor/redline/redlineTree.ts`:

```ts
// =============================================================================
// redlineTree.ts — 赤入れ表示のための平坦ツリーと 2 つのアダプタ
// =============================================================================
// 役割: 編集キャンバスの赤入れ（確定版からの変更箇所の表示）は、GrapesJS のモデル木（live）と
// `Parser.parseHtml(確定版 HTML)` の定義木（基準）を比べて計算する。DOM 同士で比べないのは、
// canvas の live 要素に GrapesJS が自動 `id` を必ず付けるため、id 優先の整列キー
// （`lib/blockKey`）が基準側と一致しないから。モデルの `attributes` には明示属性しか無く、
// 両者は同じパーサと `parse:html:root` の刈り取りを通るので、この層で形が揃う。
// ここは 2 つの木を同じ `RedlineNode` へ写すだけで、差分の判断は `redlineDiff.ts` が持つ。

import type { Component, ComponentDefinition } from 'grapesjs';
import { rawKeyFromParts } from '@/lib/blockKey';

/** live 側のノード解決子。基準側は常に null を返す。 */
export type NodeResolver = () => Node | null;

export interface RedlineNode {
  kind: 'el' | 'text';
  /** 兄弟内で一意な整列キー。要素は `rawKey#n`、テキストは `#text#n`。 */
  key: string;
  tag?: string;
  text?: string;
  children: RedlineNode[];
  /** live 側: canvas DOM 上の対応ノード（要素または Text）。基準側は null。 */
  node: NodeResolver;
  /** 基準側のみ: 削除要素をキャンバスへ描くための定義。 */
  def?: ComponentDefinition;
}

const NULL_NODE: NodeResolver = () => null;

/** 空白だけのテキストは整列にも差分にも使わない（`htmlBlockDiff.childUnits` と同じ）。 */
function isBlankText(s: string | undefined): boolean {
  return (s ?? '').trim() === '';
}

/** 同一親の子に、基底キーの出現順 `#n` を付けて一意化する（`htmlBlockDiff.keyedUnits` と同規則）。 */
function assignKeys(nodes: { base: string; node: Omit<RedlineNode, 'key'> }[]): RedlineNode[] {
  const seen = new Map<string, number>();
  return nodes.map(({ base, node }) => {
    const n = (seen.get(base) ?? 0) + 1;
    seen.set(base, n);
    return { ...node, key: `${base}#${n}` };
  });
}

/** 定義の `classes` は文字列配列だが、モデル由来では `{ name }` の配列になることもある。 */
function firstClassOf(classes: unknown): string | null {
  if (!Array.isArray(classes) || classes.length === 0) return null;
  const c = classes[0] as string | { name?: string };
  return typeof c === 'string' ? c : (c?.name ?? null);
}

function elKey(attrs: Record<string, unknown> | undefined, classes: unknown, tag: string): string {
  return rawKeyFromParts({
    partId: typeof attrs?.['data-part-id'] === 'string' ? (attrs['data-part-id'] as string) : null,
    id: typeof attrs?.id === 'string' ? (attrs.id as string) : null,
    firstClass: firstClassOf(classes),
    tag,
  });
}

// ── 1. 基準側: パーサの定義木 ────────────────────────────────────────────────

/** パーサは子テキスト 1 つを配列でなくオブジェクトで返す。どちらでも配列に揃える。 */
function childDefs(def: ComponentDefinition): ComponentDefinition[] {
  const c = def.components as ComponentDefinition | ComponentDefinition[] | string | undefined;
  if (c == null || typeof c === 'string') return [];
  return Array.isArray(c) ? c : [c];
}

function defToNode(def: ComponentDefinition): { base: string; node: Omit<RedlineNode, 'key'> } | null {
  if (def.type === 'textnode') {
    const text = typeof def.content === 'string' ? def.content : '';
    if (isBlankText(text)) return null;
    return { base: '#text', node: { kind: 'text', text, children: [], node: NULL_NODE } };
  }
  const tag = (def.tagName || 'div').toLowerCase();
  let kids = childDefs(def);
  // 子を持たず `content` だけの text 要素は、その content を 1 個のテキスト子として扱う。
  if (kids.length === 0 && typeof def.content === 'string' && def.content !== '') {
    kids = [{ type: 'textnode', content: def.content }];
  }
  return {
    base: elKey(def.attributes as Record<string, unknown> | undefined, def.classes, tag),
    node: { kind: 'el', tag, children: fromDefinitions(kids), node: NULL_NODE, def },
  };
}

/** `Parser.parseHtml(html).html` の定義列を平坦ツリーへ写す。 */
export function fromDefinitions(
  defs: ComponentDefinition | ComponentDefinition[] | undefined,
): RedlineNode[] {
  if (!defs) return [];
  const list = Array.isArray(defs) ? defs : [defs];
  const out: { base: string; node: Omit<RedlineNode, 'key'> }[] = [];
  for (const d of list) {
    const n = defToNode(d);
    if (n) out.push(n);
  }
  return assignKeys(out);
}

// ── 2. live 側: GrapesJS のモデル木 ───────────────────────────────────────────

function compChildren(comp: Component): Component[] {
  const coll = comp.components();
  return coll.map((c) => c);
}

function compToNode(comp: Component): { base: string; node: Omit<RedlineNode, 'key'> } | null {
  const type = String(comp.get('type') ?? '');
  if (type === 'textnode') {
    const text = String(comp.get('content') ?? '');
    if (isBlankText(text)) return null;
    return {
      base: '#text',
      node: { kind: 'text', text, children: [], node: () => comp.getEl() ?? null },
    };
  }
  const tag = String(comp.get('tagName') || 'div').toLowerCase();
  const kids = compChildren(comp);
  let children: RedlineNode[];
  const content = comp.get('content');
  if (kids.length === 0 && typeof content === 'string' && content !== '' && !isBlankText(content)) {
    // 子 Component を持たず `content` だけの text。DOM では要素の最初の子 Text がその本文。
    children = assignKeys([
      {
        base: '#text',
        node: {
          kind: 'text',
          text: content,
          children: [],
          node: () => {
            const first = comp.getEl()?.firstChild ?? null;
            return first && first.nodeType === Node.TEXT_NODE ? first : null;
          },
        },
      },
    ]);
  } else {
    children = fromComponents(comp);
  }
  return {
    base: elKey(comp.get('attributes') as Record<string, unknown> | undefined, comp.getClasses(), tag),
    node: { kind: 'el', tag, children, node: () => comp.getEl() ?? null },
  };
}

/** `root`（wrapper など）の子 Component 列を平坦ツリーへ写す。 */
export function fromComponents(root: Component): RedlineNode[] {
  const out: { base: string; node: Omit<RedlineNode, 'key'> }[] = [];
  for (const c of compChildren(root)) {
    const n = compToNode(c);
    if (n) out.push(n);
  }
  return assignKeys(out);
}

// ── 3. 削除要素の描画 ─────────────────────────────────────────────────────────

/** 写さない属性: 重複 id を作る `id`、実行を伴う `on*`、GrapesJS の内部指示 `data-gjs-*`。 */
function isRenderableAttr(name: string): boolean {
  const n = name.toLowerCase();
  return n !== 'id' && n !== 'contenteditable' && !n.startsWith('on') && !n.startsWith('data-gjs-');
}

/**
 * 基準側の定義から表示用 DOM を組む。文字列連結や `innerHTML` を使わず `createElement` /
 * `setAttribute` / `createTextNode` で組むので、本文や属性値に HTML の字面が入っていても
 * 文字列のまま出る（削除要素の中身は他ユーザが書いた本文である）。
 */
export function renderDefinition(def: ComponentDefinition, doc: Document): Node {
  if (def.type === 'textnode') return doc.createTextNode(typeof def.content === 'string' ? def.content : '');
  const el = doc.createElement((def.tagName || 'div').toLowerCase());
  const attrs = (def.attributes ?? {}) as Record<string, unknown>;
  for (const [k, v] of Object.entries(attrs)) {
    if (!isRenderableAttr(k) || v == null || v === false) continue;
    el.setAttribute(k, v === true ? '' : String(v));
  }
  const classes = Array.isArray(def.classes)
    ? (def.classes as (string | { name?: string })[]).map((c) => (typeof c === 'string' ? c : (c?.name ?? '')))
    : [];
  const cls = classes.filter(Boolean).join(' ');
  if (cls) el.setAttribute('class', cls);
  let kids = childDefs(def);
  if (kids.length === 0 && typeof def.content === 'string' && def.content !== '') {
    kids = [{ type: 'textnode', content: def.content }];
  }
  for (const k of kids) el.appendChild(renderDefinition(k, doc));
  return el;
}
```

- [ ] **Step 4: テスト通過を確認**

Run: `pnpm exec vitest run editor/web/test/redlineTree.test.ts`
Expected: PASS

- [ ] **Step 5: コミット**

```bash
pnpm exec biome check --write editor/web/src/features/editor/redline/redlineTree.ts editor/web/test/redlineTree.test.ts
git add editor/web/src/features/editor/redline/redlineTree.ts editor/web/test/redlineTree.test.ts
git commit -m "feat(editor): 赤入れ表示の平坦ツリーとモデル木/定義木アダプタを追加する

Claude-Session: https://claude.ai/code/session_01NS7sXef8dsEyg8qNYRtcYv"
```

---

### Task 3: `redlineDiff.ts` — 純関数の差分計算

**Files:**
- Create: `editor/web/src/features/editor/redline/redlineDiff.ts`
- Test: `editor/web/test/redlineDiff.test.ts`

**Interfaces:**
- Consumes: `RedlineNode` / `NodeResolver`（Task 2）、`tokenize` / `diffTokens` / `createLcsBudget` / `LcsBudget` / `DiffOp`（`@/features/compare/htmlBlockDiff`）。
- Produces:

```ts
export type RedlineOp =
  | { kind: 'delText'; node: NodeResolver; ops: DiffOp[] }
  | { kind: 'insText'; node: NodeResolver; ops: DiffOp[] }
  | { kind: 'addedEl'; node: NodeResolver }
  | {
      kind: 'removedEl';
      /** 挿入先の親（null = ルート）。 */
      parent: NodeResolver | null;
      /** この live ノードの直前へ挿す。null = 親の末尾。 */
      before: NodeResolver | null;
      /** 削除されたのがテキストなら inline（`<del>`）、要素なら block（`<del class="redline-block">`）。 */
      inline: boolean;
      def?: ComponentDefinition;
      text?: string;
    };
export function diffRedline(base: RedlineNode[], live: RedlineNode[], budget: LcsBudget): RedlineOp[];
```

- [ ] **Step 1: 失敗するテストを書く**

`editor/web/test/redlineDiff.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { createLcsBudget, MAX_LCS_CELLS } from '@/features/compare/htmlBlockDiff';
import { diffRedline } from '@/features/editor/redline/redlineDiff';
import type { NodeResolver, RedlineNode } from '@/features/editor/redline/redlineTree';

const NIL: NodeResolver = () => null;
const el = (key: string, children: RedlineNode[] = [], node: NodeResolver = NIL, tag = 'p'): RedlineNode => ({
  kind: 'el', key, tag, children, node, def: { tagName: tag },
});
const tx = (key: string, text: string, node: NodeResolver = NIL): RedlineNode => ({
  kind: 'text', key, text, children: [], node,
});
const ref = (): NodeResolver => {
  const n = document.createElement('span');
  return () => n;
};

describe('diffRedline', () => {
  it('同一の木では空配列', () => {
    const t = () => [el('p#1', [tx('#text#1', 'こんにちは')])];
    expect(diffRedline(t(), t(), createLcsBudget())).toEqual([]);
  });

  it('空白の違いだけのテキストは差分にしない', () => {
    const a = [el('p#1', [tx('#text#1', 'a  b\n')])];
    const b = [el('p#1', [tx('#text#1', 'a b')])];
    expect(diffRedline(a, b, createLcsBudget())).toEqual([]);
  });

  it('語句の削除は delText、挿入は insText として live の Text へ向ける', () => {
    const live = ref();
    const a = [el('p#1', [tx('#text#1', '受益者のみなさまへ')])];
    const b = [el('p#1', [tx('#text#1', '受益者の皆様へ', live)])];
    const ops = diffRedline(a, b, createLcsBudget());
    const del = ops.find((o) => o.kind === 'delText');
    const ins = ops.find((o) => o.kind === 'insText');
    expect(del && del.kind === 'delText' && del.node()).toBe(live());
    expect(del && del.kind === 'delText' && del.ops.filter((o) => o.type === 'del').map((o) => o.text).join('')).toBe('みなさま');
    expect(ins && ins.kind === 'insText' && ins.ops.filter((o) => o.type === 'ins').map((o) => o.text).join('')).toBe('皆様');
  });

  it('削除だけなら insText は出さず、挿入だけなら delText は出さない', () => {
    const onlyDel = diffRedline([el('p#1', [tx('#text#1', 'abc def')])], [el('p#1', [tx('#text#1', 'abc', ref())])], createLcsBudget());
    expect(onlyDel.map((o) => o.kind)).toEqual(['delText']);
    const onlyIns = diffRedline([el('p#1', [tx('#text#1', 'abc')])], [el('p#1', [tx('#text#1', 'abc def', ref())])], createLcsBudget());
    expect(onlyIns.map((o) => o.kind)).toEqual(['insText']);
  });

  it('live にだけある要素は addedEl、基準にだけある要素は removedEl（挿入位置つき）', () => {
    const p2 = ref();
    const p3 = ref();
    const base = [el('p#1'), el('p#2'), el('p#3')];
    const live = [el('p#1', [], ref()), el('p#3', [], p3), el('p#4', [], p2)];
    const ops = diffRedline(base, live, createLcsBudget());
    // 基準の p#2 は live に無い → 基準側で次に live にも在る兄弟 p#3 の直前へ
    const removed = ops.find((o) => o.kind === 'removedEl');
    expect(removed && removed.kind === 'removedEl' && removed.before?.()).toBe(p3());
    expect(removed && removed.kind === 'removedEl' && removed.parent).toBeNull();
    expect(removed && removed.kind === 'removedEl' && removed.inline).toBe(false);
    expect(removed && removed.kind === 'removedEl' && removed.def).toEqual({ tagName: 'p' });
    const added = ops.find((o) => o.kind === 'addedEl');
    expect(added && added.kind === 'addedEl' && added.node()).toBe(p2());
  });

  it('基準側の末尾要素が消えた場合は before が null（親の末尾へ）で、親は live の要素', () => {
    const parent = ref();
    const base = [el('div#1', [el('p#1'), el('p#2')], NIL, 'div')];
    const live = [el('div#1', [el('p#1', [], ref())], parent, 'div')];
    const ops = diffRedline(base, live, createLcsBudget());
    const removed = ops.find((o) => o.kind === 'removedEl');
    expect(removed && removed.kind === 'removedEl' && removed.before).toBeNull();
    expect(removed && removed.kind === 'removedEl' && removed.parent?.()).toBe(parent());
  });

  it('同キーで tag が違う要素は removedEl + addedEl になる', () => {
    const ops = diffRedline(
      [el('.x#1', [], NIL, 'p')],
      [el('.x#1', [], ref(), 'div')],
      createLcsBudget(),
    );
    expect(ops.map((o) => o.kind).sort()).toEqual(['addedEl', 'removedEl']);
  });

  it('基準にだけあるテキストは inline の removedEl になる', () => {
    const ops = diffRedline(
      [el('p#1', [tx('#text#1', 'a'), el('b#1'), tx('#text#2', 'tail')])],
      [el('p#1', [tx('#text#1', 'a', ref()), el('b#1', [], ref())], ref())],
      createLcsBudget(),
    );
    const removed = ops.find((o) => o.kind === 'removedEl');
    expect(removed && removed.kind === 'removedEl' && removed.inline).toBe(true);
    expect(removed && removed.kind === 'removedEl' && removed.text).toBe('tail');
  });

  it('予算を超えたテキストは全文 del + ins の粗い差分になる（取り消し線は出る）', () => {
    // `diffTokens` は共通の先頭を先に落とすので、先頭から違わせて 3001 x 3001 セルを踏ませる。
    const big = 'あ'.repeat(3000);
    const ops = diffRedline(
      [el('p#1', [tx('#text#1', `x${big}`)])],
      [el('p#1', [tx('#text#1', `y${big}`, ref())])],
      { remaining: MAX_LCS_CELLS },
    );
    const del = ops.find((o) => o.kind === 'delText');
    expect(del && del.kind === 'delText' && del.ops.filter((o) => o.type === 'del').map((o) => o.text).join('')).toBe(`x${big}`);
  });
});
```

- [ ] **Step 2: 失敗を確認**

Run: `pnpm exec vitest run editor/web/test/redlineDiff.test.ts`
Expected: FAIL（モジュールが無い）

- [ ] **Step 3: 実装**

`editor/web/src/features/editor/redline/redlineDiff.ts`:

```ts
// =============================================================================
// redlineDiff.ts — 赤入れ表示の差分計算（純関数）
// =============================================================================
// 役割: 基準（確定版）と live（編集中）の平坦ツリーを整列し、キャンバスへ置く装飾の指示
// （`RedlineOp`）を返す。再帰の考え方は精査画面の `htmlBlockDiff.diffElement` と同じで、
// 同キーの要素対は降りる、片側にしか無いものは追加 / 削除、テキスト対は語句 LCS。
// DOM には触らず、live ノードの解決子だけを op に載せる（適用は `redlineApply.ts`）。

import type { ComponentDefinition } from 'grapesjs';
import {
  type DiffOp,
  diffTokens,
  type LcsBudget,
  tokenize,
} from '@/features/compare/htmlBlockDiff';
import type { NodeResolver, RedlineNode } from './redlineTree';

export type RedlineOp =
  | { kind: 'delText'; node: NodeResolver; ops: DiffOp[] }
  | { kind: 'insText'; node: NodeResolver; ops: DiffOp[] }
  | { kind: 'addedEl'; node: NodeResolver }
  | {
      kind: 'removedEl';
      /** 挿入先の親（null = ルート）。 */
      parent: NodeResolver | null;
      /** この live ノードの直前へ挿す。null = 親の末尾。 */
      before: NodeResolver | null;
      /** 削除されたのがテキストなら inline、要素なら block。 */
      inline: boolean;
      def?: ComponentDefinition;
      text?: string;
    };

/** 空白の違いだけを差分にしない（`htmlBlockDiff.collapse` と同じ正規化）。 */
function collapse(s: string | undefined): string {
  return (s ?? '').replace(/\s+/g, ' ').trim();
}

function diffText(b: RedlineNode, l: RedlineNode, budget: LcsBudget, out: RedlineOp[]): void {
  if (collapse(b.text) === collapse(l.text)) return;
  const { ops } = diffTokens(tokenize(b.text ?? ''), tokenize(l.text ?? ''), budget);
  if (ops.some((o) => o.type === 'del')) out.push({ kind: 'delText', node: l.node, ops });
  if (ops.some((o) => o.type === 'ins')) out.push({ kind: 'insText', node: l.node, ops });
}

function removedOp(b: RedlineNode, parent: NodeResolver | null, before: NodeResolver | null): RedlineOp {
  return b.kind === 'text'
    ? { kind: 'removedEl', parent, before, inline: true, text: b.text }
    : { kind: 'removedEl', parent, before, inline: false, def: b.def };
}

/**
 * 基準側で `index` より後にある兄弟のうち、live にも存在する最初のものの live ノードを返す。
 * 削除要素は「基準でその直前にあった位置」へ置きたいので、次に残っている兄弟の前に挿す。
 */
function insertionPoint(
  base: RedlineNode[],
  index: number,
  liveByKey: Map<string, RedlineNode>,
): NodeResolver | null {
  for (let i = index + 1; i < base.length; i++) {
    const l = liveByKey.get(base[i].key);
    if (l) return l.node;
  }
  return null;
}

function diffChildren(
  base: RedlineNode[],
  live: RedlineNode[],
  parent: NodeResolver | null,
  budget: LcsBudget,
  out: RedlineOp[],
): void {
  const baseByKey = new Map(base.map((n) => [n.key, n]));
  const liveByKey = new Map(live.map((n) => [n.key, n]));

  for (const l of live) {
    const b = baseByKey.get(l.key);
    if (!b) {
      if (l.kind === 'el') out.push({ kind: 'addedEl', node: l.node });
      // live にだけあるテキストは着色手段が無い（挿入語句として全文をハイライトする）。
      else out.push({ kind: 'insText', node: l.node, ops: [{ type: 'ins', text: l.text ?? '' }] });
      continue;
    }
    if (b.kind === 'text' && l.kind === 'text') {
      diffText(b, l, budget, out);
    } else if (b.kind === 'el' && l.kind === 'el' && b.tag === l.tag) {
      diffChildren(b.children, l.children, l.node, budget, out);
    } else {
      // 同じスロットだが種別 / tag が違う → 削除 + 追加。
      out.push(removedOp(b, parent, l.node));
      if (l.kind === 'el') out.push({ kind: 'addedEl', node: l.node });
    }
  }

  base.forEach((b, i) => {
    if (liveByKey.has(b.key)) return;
    out.push(removedOp(b, parent, insertionPoint(base, i, liveByKey)));
  });
}

/** 基準と live の平坦ツリーを比べ、キャンバスへ置く装飾の指示列を返す。 */
export function diffRedline(base: RedlineNode[], live: RedlineNode[], budget: LcsBudget): RedlineOp[] {
  const out: RedlineOp[] = [];
  diffChildren(base, live, null, budget, out);
  return out;
}
```

- [ ] **Step 4: テスト通過を確認**

Run: `pnpm exec vitest run editor/web/test/redlineDiff.test.ts`
Expected: PASS。「同キーで tag が違う」のテストで `sort()` 後の順が `['addedEl','removedEl']` になることも確認。

- [ ] **Step 5: コミット**

```bash
pnpm exec biome check --write editor/web/src/features/editor/redline/redlineDiff.ts editor/web/test/redlineDiff.test.ts
git add editor/web/src/features/editor/redline/redlineDiff.ts editor/web/test/redlineDiff.test.ts
git commit -m "feat(editor): 赤入れ表示の差分計算(純関数)を追加する

Claude-Session: https://claude.ai/code/session_01NS7sXef8dsEyg8qNYRtcYv"
```

---

### Task 4: `redlineApply.ts` + `redlineCss.ts` — 生 DOM への適用と除去

**Files:**
- Create: `editor/web/src/features/editor/redline/redlineApply.ts`
- Create: `editor/web/src/features/editor/redline/redlineCss.ts`
- Test: `editor/web/test/redlineApply.test.ts`

**Interfaces:**
- Consumes: `RedlineOp`（Task 3）、`renderDefinition`（Task 2）。
- Produces（`redlineApply.ts`）:

```ts
export const REDLINE_ATTR = 'data-redline';
export const REDLINE_ADDED_ATTR = 'data-redline-added';
export const REDLINE_BLOCK_CLASS = 'redline-block';
export const REDLINE_HIGHLIGHT = 'redline-ins';
export function applyRedline(rootEl: HTMLElement, ops: RedlineOp[]): void;
export function clearRedline(rootEl: HTMLElement): void;
export function clearRedlineWithin(el: HTMLElement): void;
```

- Produces（`redlineCss.ts`）: `export const REDLINE_BODY_CLASS = 'redline-on'; export const redlineCanvasCss: string;`

- [ ] **Step 1: 失敗するテストを書く**

`editor/web/test/redlineApply.test.ts`:

```ts
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  applyRedline,
  clearRedline,
  clearRedlineWithin,
  REDLINE_ADDED_ATTR,
  REDLINE_ATTR,
  REDLINE_BLOCK_CLASS,
  REDLINE_HIGHLIGHT,
} from '@/features/editor/redline/redlineApply';
import { REDLINE_BODY_CLASS, redlineCanvasCss } from '@/features/editor/redline/redlineCss';
import type { RedlineOp } from '@/features/editor/redline/redlineDiff';

function root(html: string): HTMLElement {
  const r = document.createElement('div');
  r.innerHTML = html;
  document.body.appendChild(r);
  return r;
}
const textOf = (el: Element): Text => el.firstChild as Text;

afterEach(() => {
  document.body.innerHTML = '';
});

describe('applyRedline — delText', () => {
  it('削除語句を新文言の直前へ <del data-redline contenteditable=false> として割り込ませる', () => {
    const r = root('<p>受益者の皆様へ</p>');
    const p = r.querySelector('p') as HTMLElement;
    const ops: RedlineOp[] = [
      {
        kind: 'delText',
        node: () => textOf(p),
        ops: [
          { type: 'same', text: '受' }, { type: 'same', text: '益' }, { type: 'same', text: '者' }, { type: 'same', text: 'の' },
          { type: 'del', text: 'み' }, { type: 'del', text: 'な' }, { type: 'del', text: 'さ' }, { type: 'del', text: 'ま' },
          { type: 'ins', text: '皆' }, { type: 'ins', text: '様' },
          { type: 'same', text: 'へ' },
        ],
      },
    ];
    applyRedline(r, ops);
    const del = p.querySelector(`del[${REDLINE_ATTR}]`) as HTMLElement;
    expect(del).not.toBeNull();
    expect(del.textContent).toBe('みなさま');
    expect(del.getAttribute('contenteditable')).toBe('false');
    expect(del.classList.contains(REDLINE_BLOCK_CLASS)).toBe(false);
    // 表示上の並び: 受益者の[みなさま]皆様へ
    expect(p.textContent).toBe('受益者のみなさま皆様へ');
    // 先頭の Text ノード（GrapesJS の view が持つ参照）はそのまま残っている
    expect(p.firstChild?.nodeType).toBe(Node.TEXT_NODE);
    expect((p.firstChild as Text).data).toBe('受益者の');
  });

  it('先頭 / 末尾の削除は Text を分割せずに前後へ置く', () => {
    const r = root('<p>bc</p><p>ab</p>');
    const [p1, p2] = Array.from(r.querySelectorAll('p')) as HTMLElement[];
    applyRedline(r, [
      { kind: 'delText', node: () => textOf(p1), ops: [{ type: 'del', text: 'a' }, { type: 'same', text: 'bc' }] },
      { kind: 'delText', node: () => textOf(p2), ops: [{ type: 'same', text: 'ab' }, { type: 'del', text: 'c' }] },
    ]);
    expect(p1.innerHTML).toBe(`<del ${REDLINE_ATTR}="" contenteditable="false">a</del>bc`);
    expect(p2.innerHTML).toBe(`ab<del ${REDLINE_ATTR}="" contenteditable="false">c</del>`);
    expect(p1.childNodes).toHaveLength(2);
    expect(p2.childNodes).toHaveLength(2);
  });

  it('node が null や Text でないときは何もしない（例外を出さない）', () => {
    const r = root('<p>x</p>');
    expect(() =>
      applyRedline(r, [
        { kind: 'delText', node: () => null, ops: [{ type: 'del', text: 'a' }] },
        { kind: 'delText', node: () => r.querySelector('p'), ops: [{ type: 'del', text: 'a' }] },
      ]),
    ).not.toThrow();
    expect(r.querySelector(`[${REDLINE_ATTR}]`)).toBeNull();
  });
});

describe('applyRedline — 要素', () => {
  it('addedEl は live 要素へ属性を付け、removedEl は基準の定義を <del class=redline-block> で挿す', () => {
    const r = root('<div class="page"><p id="a">A</p><p id="c">C</p></div>');
    const page = r.querySelector('.page') as HTMLElement;
    const c = r.querySelector('#c') as HTMLElement;
    applyRedline(r, [
      { kind: 'addedEl', node: () => c },
      {
        kind: 'removedEl',
        parent: () => page,
        before: () => c,
        inline: false,
        def: { tagName: 'p', components: { type: 'textnode', content: 'B' } },
      },
      { kind: 'removedEl', parent: null, before: null, inline: true, text: 'tail' },
    ]);
    expect(c.hasAttribute(REDLINE_ADDED_ATTR)).toBe(true);
    const block = page.querySelector(`del.${REDLINE_BLOCK_CLASS}[${REDLINE_ATTR}]`) as HTMLElement;
    expect(block.nextElementSibling).toBe(c);
    expect(block.textContent).toBe('B');
    expect(block.getAttribute('contenteditable')).toBe('false');
    // parent=null はルート末尾。inline はブロッククラス無し
    const tail = r.lastElementChild as HTMLElement;
    expect(tail.tagName).toBe('DEL');
    expect(tail.textContent).toBe('tail');
    expect(tail.classList.contains(REDLINE_BLOCK_CLASS)).toBe(false);
  });
});

describe('applyRedline — insText と CSS Highlight', () => {
  it('CSS.highlights が無い環境では例外を出さず何もしない', () => {
    const r = root('<p>abc</p>');
    const p = r.querySelector('p') as HTMLElement;
    expect(() =>
      applyRedline(r, [{ kind: 'insText', node: () => textOf(p), ops: [{ type: 'same', text: 'ab' }, { type: 'ins', text: 'c' }] }]),
    ).not.toThrow();
    expect(p.innerHTML).toBe('abc');
  });

  it('CSS.highlights があれば挿入語句の Range を登録し、clearRedline で消す', () => {
    const r = root('<p>abc</p>');
    const p = r.querySelector('p') as HTMLElement;
    const ranges: Range[] = [];
    const registry = new Map<string, unknown>();
    class FakeHighlight {
      add(range: Range) { ranges.push(range); }
    }
    // jsdom は `Highlight` も `CSS.highlights` も持たない。実装は `doc.defaultView`（= jsdom では
    // globalThis）から読むので、グローバルを差し替えて API がある環境を再現する。
    vi.stubGlobal('Highlight', FakeHighlight);
    vi.stubGlobal('CSS', { highlights: registry });
    try {
      applyRedline(r, [{ kind: 'insText', node: () => textOf(p), ops: [{ type: 'same', text: 'ab' }, { type: 'ins', text: 'c' }] }]);
      expect(registry.has(REDLINE_HIGHLIGHT)).toBe(true);
      expect(ranges).toHaveLength(1);
      expect(ranges[0].startOffset).toBe(2);
      expect(ranges[0].endOffset).toBe(3);
      clearRedline(r);
      expect(registry.has(REDLINE_HIGHLIGHT)).toBe(false);
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

describe('clearRedline / clearRedlineWithin', () => {
  it('装飾を全て外し、分割した Text を結合して元の innerHTML に戻す', () => {
    const r = root('<div class="page"><p>受益者の皆様へ</p><p class="k">keep</p></div>');
    const before = r.innerHTML;
    const p = r.querySelector('p') as HTMLElement;
    const k = r.querySelector('.k') as HTMLElement;
    applyRedline(r, [
      { kind: 'delText', node: () => textOf(p), ops: [{ type: 'same', text: '受益者の' }, { type: 'del', text: 'みなさま' }, { type: 'same', text: '皆様へ' }] },
      { kind: 'addedEl', node: () => k },
      { kind: 'removedEl', parent: () => r.firstElementChild as HTMLElement, before: () => k, inline: false, def: { tagName: 'p', content: 'gone' } },
    ]);
    expect(r.innerHTML).not.toBe(before);
    clearRedline(r);
    expect(r.innerHTML).toBe(before);
    expect(p.childNodes).toHaveLength(1);
  });

  it('clearRedlineWithin は指定要素の配下だけを戻す', () => {
    const r = root('<div class="page"><p>ab</p><p>cd</p></div>');
    const [p1, p2] = Array.from(r.querySelectorAll('p')) as HTMLElement[];
    applyRedline(r, [
      { kind: 'delText', node: () => textOf(p1), ops: [{ type: 'del', text: 'x' }, { type: 'same', text: 'ab' }] },
      { kind: 'delText', node: () => textOf(p2), ops: [{ type: 'del', text: 'y' }, { type: 'same', text: 'cd' }] },
    ]);
    clearRedlineWithin(p1);
    expect(p1.innerHTML).toBe('ab');
    expect(p2.querySelector(`[${REDLINE_ATTR}]`)).not.toBeNull();
  });
});

describe('redlineCanvasCss', () => {
  it('表示は body クラスで出し分け、OFF では del を display:none にする', () => {
    expect(redlineCanvasCss).toContain(`.${REDLINE_BODY_CLASS} [${REDLINE_ATTR}]`);
    expect(redlineCanvasCss).toContain('line-through');
    expect(redlineCanvasCss).toContain(`body:not(.${REDLINE_BODY_CLASS}) [${REDLINE_ATTR}]`);
    expect(redlineCanvasCss).toContain(`::highlight(${REDLINE_HIGHLIGHT})`);
    expect(redlineCanvasCss).toContain(`[${REDLINE_ADDED_ATTR}]`);
  });
});
```

- [ ] **Step 2: 失敗を確認**

Run: `pnpm exec vitest run editor/web/test/redlineApply.test.ts`
Expected: FAIL（モジュールが無い）

- [ ] **Step 3: 実装（CSS）**

`editor/web/src/features/editor/redline/redlineCss.ts`:

```ts
// =============================================================================
// redlineCss.ts — 赤入れ表示のキャンバス注入 CSS
// =============================================================================
// 役割: `useGrapes.init` が canvas iframe の head へ入れる CSS の一部。表示の ON/OFF は
// body のクラス `redline-on` で出し分ける（差し込み値ハイライトの `jinja-vars-highlight`
// と同じ手法。body 直書きのクラスは `getHtml()` に載らないので保存出力を汚さない）。
// 配色は精査画面（`htmlBlockDiff.diffHighlightCss`）に揃える: 削除 = 赤、追加 = 緑、
// 削除された要素 = 橙の左帯。

import {
  REDLINE_ADDED_ATTR,
  REDLINE_ATTR,
  REDLINE_BLOCK_CLASS,
  REDLINE_HIGHLIGHT,
} from './redlineApply';

/** 赤入れを見せている間だけ canvas body に付けるクラス。 */
export const REDLINE_BODY_CLASS = 'redline-on';

export const redlineCanvasCss = `
.${REDLINE_BODY_CLASS} [${REDLINE_ATTR}] {
  text-decoration: line-through;
  text-decoration-thickness: 1.5px;
  color: #b91c1c;
  background: rgba(220, 38, 38, 0.12);
  border-radius: 2px;
  user-select: none;
  cursor: default;
}
.${REDLINE_BODY_CLASS} del.${REDLINE_BLOCK_CLASS}[${REDLINE_ATTR}] {
  display: block;
  box-shadow: inset 3px 0 0 #d97706;
  background: rgba(217, 119, 6, 0.08);
}
.${REDLINE_BODY_CLASS} [${REDLINE_ADDED_ATTR}] { box-shadow: inset 3px 0 0 #16a34a; }
.${REDLINE_BODY_CLASS} ::highlight(${REDLINE_HIGHLIGHT}) {
  background: rgba(22, 163, 74, 0.2);
  color: #15803d;
}
/* トグル OFF: 旧文言を流れから外し、行送り・改ページを PDF と同じに戻す。 */
body:not(.${REDLINE_BODY_CLASS}) [${REDLINE_ATTR}] { display: none; }
`;
```

- [ ] **Step 4: 実装（適用・除去）**

`editor/web/src/features/editor/redline/redlineApply.ts`:

```ts
// =============================================================================
// redlineApply.ts — 赤入れ装飾の生 DOM への適用と除去
// =============================================================================
// 役割: `redlineDiff` の指示列を canvas iframe の DOM に反映する。装飾は **生 DOM だけ**に置き、
// GrapesJS のモデルには載せない（`getHtml()` はモデルから再生成するため draft に混入しない。
// ページ表示マーカー `PV_ATTR` と同じ方針）。除去は完全復元が要件で、削除語句のために分割した
// Text ノードは `normalize()` で結合し直す。`normalize()` は先頭ノードを残して後続を吸収する
// ので、GrapesJS の textnode view が持つ先頭 Text への参照は生きたままになる。

import { renderDefinition } from './redlineTree';
import type { RedlineOp } from './redlineDiff';

export const REDLINE_ATTR = 'data-redline';
export const REDLINE_ADDED_ATTR = 'data-redline-added';
export const REDLINE_BLOCK_CLASS = 'redline-block';
/** CSS Custom Highlight API の登録名（挿入語句の着色。DOM を変えない）。 */
export const REDLINE_HIGHLIGHT = 'redline-ins';

type HighlightCtor = new () => { add(range: Range): void };
interface HighlightWindow {
  Highlight?: HighlightCtor;
  CSS?: { highlights?: Map<string, unknown> };
}

function isText(n: Node | null): n is Text {
  return !!n && n.nodeType === Node.TEXT_NODE;
}

function makeDel(doc: Document, inline: boolean): HTMLElement {
  const del = doc.createElement('del');
  del.setAttribute(REDLINE_ATTR, '');
  // RTE の contenteditable 領域の中に入っても編集対象にならないようにする。
  del.setAttribute('contenteditable', 'false');
  if (!inline) del.classList.add(REDLINE_BLOCK_CLASS);
  return del;
}

/** `same` / `ins` の文字数で進み、`del` の位置に旧語句を割り込ませる。 */
function applyDelText(text: Text, ops: RedlineOp & { kind: 'delText' }): void {
  const doc = text.ownerDocument;
  let cur = text;
  let offset = 0;
  let pendingDel = '';
  const flush = () => {
    if (!pendingDel) return;
    const del = makeDel(doc, true);
    del.textContent = pendingDel;
    pendingDel = '';
    const parent = cur.parentNode;
    if (!parent) return;
    if (offset === 0) {
      parent.insertBefore(del, cur);
    } else if (offset >= cur.data.length) {
      parent.insertBefore(del, cur.nextSibling);
    } else {
      const rest = cur.splitText(offset);
      parent.insertBefore(del, rest);
      cur = rest;
      offset = 0;
    }
  };
  for (const op of ops.ops) {
    if (op.type === 'del') {
      pendingDel += op.text;
      continue;
    }
    flush();
    offset += op.text.length;
  }
  flush();
}

/** 挿入語句の Range を CSS Highlight として登録する。API が無い環境では何もしない。 */
function applyInsText(text: Text, ops: RedlineOp & { kind: 'insText' }, highlight: { add(r: Range): void } | null): void {
  if (!highlight) return;
  const doc = text.ownerDocument;
  let offset = 0;
  for (const op of ops.ops) {
    if (op.type === 'del') continue;
    if (op.type === 'ins') {
      const end = Math.min(offset + op.text.length, text.data.length);
      if (end > offset) {
        const r = doc.createRange();
        r.setStart(text, offset);
        r.setEnd(text, end);
        highlight.add(r);
      }
    }
    offset += op.text.length;
  }
}

function highlightRegistry(doc: Document): { ctor: HighlightCtor; registry: Map<string, unknown> } | null {
  const win = doc.defaultView as unknown as HighlightWindow | null;
  const ctor = win?.Highlight;
  const registry = win?.CSS?.highlights;
  return ctor && registry ? { ctor, registry } : null;
}

/**
 * 装飾を適用する。順序: `insText`（Range 登録）→ `delText`（Text 分割）→ 要素系。Range は
 * `splitText` に追従して境界を更新するが、分割前に登録する方が読みやすく検証もしやすい。
 */
export function applyRedline(rootEl: HTMLElement, ops: RedlineOp[]): void {
  const doc = rootEl.ownerDocument;
  const hl = highlightRegistry(doc);
  const highlight = hl ? new hl.ctor() : null;

  for (const op of ops) {
    if (op.kind !== 'insText') continue;
    const n = op.node();
    if (isText(n)) applyInsText(n, op, highlight);
  }
  if (hl && highlight) hl.registry.set(REDLINE_HIGHLIGHT, highlight);

  for (const op of ops) {
    if (op.kind !== 'delText') continue;
    const n = op.node();
    if (isText(n)) applyDelText(n, op);
  }

  for (const op of ops) {
    if (op.kind === 'addedEl') {
      const n = op.node();
      if (n instanceof Element) n.setAttribute(REDLINE_ADDED_ATTR, '');
    } else if (op.kind === 'removedEl') {
      const parent = op.parent ? op.parent() : rootEl;
      if (!(parent instanceof Element)) continue;
      const del = makeDel(doc, op.inline);
      if (op.inline) del.textContent = op.text ?? '';
      else if (op.def) del.appendChild(renderDefinition(op.def, doc));
      const before = op.before ? op.before() : null;
      parent.insertBefore(del, before && before.parentNode === parent ? before : null);
    }
  }
}

/** `scope` 配下の装飾を全て外し、分割した Text を結合して元の DOM に戻す。 */
function clearWithin(scope: HTMLElement, dropHighlight: boolean): void {
  const parents = new Set<Node>();
  for (const del of Array.from(scope.querySelectorAll(`[${REDLINE_ATTR}]`))) {
    if (del.parentNode) parents.add(del.parentNode);
    del.remove();
  }
  for (const el of Array.from(scope.querySelectorAll(`[${REDLINE_ADDED_ATTR}]`))) {
    el.removeAttribute(REDLINE_ADDED_ATTR);
  }
  scope.removeAttribute(REDLINE_ADDED_ATTR);
  for (const p of parents) p.normalize();
  if (dropHighlight) highlightRegistry(scope.ownerDocument)?.registry.delete(REDLINE_HIGHLIGHT);
}

export function clearRedline(rootEl: HTMLElement): void {
  clearWithin(rootEl, true);
}

/**
 * 指定要素の配下だけ装飾を外す（選択パーツ用）。挿入語句のハイライトは Range が要素を跨がず
 * 表示だけの存在なので残す（RTE の再取込に関与しない）。
 */
export function clearRedlineWithin(el: HTMLElement): void {
  clearWithin(el, false);
}
```

- [ ] **Step 5: テスト通過を確認**

Run: `pnpm exec vitest run editor/web/test/redlineApply.test.ts`
Expected: PASS。「先頭 / 末尾の削除」の `innerHTML` 期待値が jsdom の属性直列化（`data-redline=""`）と一致することを確認し、違えば期待値側を jsdom の出力に合わせる（意味は「属性が付いている」で変わらない）。

- [ ] **Step 6: コミット**

```bash
pnpm exec biome check --write editor/web/src/features/editor/redline/redlineApply.ts editor/web/src/features/editor/redline/redlineCss.ts editor/web/test/redlineApply.test.ts
git add editor/web/src/features/editor/redline/redlineApply.ts editor/web/src/features/editor/redline/redlineCss.ts editor/web/test/redlineApply.test.ts
git commit -m "feat(editor): 赤入れ装飾の生 DOM 適用・除去とキャンバス CSS を追加する

Claude-Session: https://claude.ai/code/session_01NS7sXef8dsEyg8qNYRtcYv"
```

---

### Task 5: `partKey.partEls` から `[data-redline]` を除外

**Files:**
- Modify: `editor/web/src/features/editor/partKey.ts:33-36`（`partEls`）
- Test: `editor/web/test/partKey.test.ts`

**Interfaces:**
- Consumes: `REDLINE_ATTR`（Task 4）。
- `partEls(pageEl)` の戻り値から `[data-redline]` 要素が除かれる。`partLabelMap` / `partPathKeyFor` は `partEls` 経由なので自動で追従する。

- [ ] **Step 1: 失敗するテストを書く**

`editor/web/test/partKey.test.ts` の末尾へ追加:

```ts
describe('partEls — 赤入れ装飾はパーツとして数えない', () => {
  it('[data-redline] の兄弟が挿入されてもパーツ採番とキーが変わらない', () => {
    const plain = root('<div class="page"><p class="a">A</p><p class="b">B</p></div>');
    const withDel = root(
      '<div class="page"><p class="a">A</p><del data-redline="" class="redline-block"><p class="x">gone</p></del><p class="b">B</p></div>',
    );
    const pagePlain = q(plain, '.page');
    const pageDel = q(withDel, '.page');
    expect(partEls(pageDel).map((e) => e.className)).toEqual(partEls(pagePlain).map((e) => e.className));
    expect(partPathKeyFor(q(withDel, '.b'), withDel)).toBe(partPathKeyFor(q(plain, '.b'), plain));
    expect([...partLabelMap(withDel).values()]).toEqual([...partLabelMap(plain).values()]);
  });
});
```

- [ ] **Step 2: 失敗を確認**

Run: `pnpm exec vitest run editor/web/test/partKey.test.ts`
Expected: FAIL（`del` がパーツとして数えられ、ラベルが 3 件になる）

- [ ] **Step 3: 実装**

`partKey.ts` の import に `import { REDLINE_ATTR } from './redline/redlineApply';` を足し、`partEls` を次に置き換える:

```ts
/**
 * page 直下の top-level block(= パーツ)列。要素ノードのみ。赤入れ表示が挿す削除要素
 * （`[data-redline]`。生 DOM だけに在りモデルには無い）は除く — 数えるとメモの構造キーと
 * 「ページN・パーツM」の採番が表示の ON/OFF で変わってしまう。
 */
export function partEls(pageEl: HTMLElement): HTMLElement[] {
  return Array.from(pageEl.children).filter(
    (el): el is HTMLElement => el instanceof HTMLElement && !el.hasAttribute(REDLINE_ATTR),
  );
}
```

- [ ] **Step 4: テスト通過を確認**

Run: `pnpm exec vitest run editor/web/test/partKey.test.ts editor/web/test/noteBubbleLayout.test.ts editor/web/test/usePartNote.test.ts`
Expected: PASS

- [ ] **Step 5: コミット**

```bash
pnpm exec biome check --write editor/web/src/features/editor/partKey.ts editor/web/test/partKey.test.ts
git add editor/web/src/features/editor/partKey.ts editor/web/test/partKey.test.ts
git commit -m "fix(editor): パーツ列挙から赤入れの削除要素を除きメモキーの採番を不変にする

Claude-Session: https://claude.ai/code/session_01NS7sXef8dsEyg8qNYRtcYv"
```

---

### Task 6: `useRedline.ts` と編集画面への配線

**Files:**
- Create: `editor/web/src/features/editor/redline/useRedline.ts`
- Modify: `editor/web/src/features/editor/useGrapes.ts:434`（`canvasCss` の連結）
- Modify: `editor/web/src/features/editor/useTemplateEditor.ts`（load 後の基準セット・選択 / drag / RTE 終了の配線・戻り値）

**Interfaces:**
- Consumes: Task 2–5 の全 export、`getBodyInner`（`@/lib/templateDoc`）、`createLcsBudget`、`logError` / `toAppError`。
- Produces:

```ts
export function useRedline(deps: {
  editor: ShallowRef<Editor | undefined>;
  revision: Ref<number>;
  editing: Ref<boolean>;
  dirty: Ref<boolean>;
}): {
  enabled: Ref<boolean>;        // トグル状態（既定 true）
  available: Ref<boolean>;      // 基準があり機能を出せるか
  setBaseline(filledHtml: string | undefined): void;
  toggle(): void;
  recompute(): void;
  schedule(): void;
  onSelected(comp: Component | undefined): void;
  onDragStart(): void;
  onDragEnd(): void;
};
```

- `useTemplateEditor` の戻り値に `redlineEnabled: Ref<boolean>` / `redlineAvailable: Ref<boolean>` / `toggleRedline: () => void` を追加する。

- [ ] **Step 1: composable を書く**

`editor/web/src/features/editor/redline/useRedline.ts`:

```ts
// =============================================================================
// useRedline.ts — 編集キャンバスの赤入れ表示（確定版からの変更箇所）の composable
// =============================================================================
// 役割: 基準（確定版 `Template.filled`）を 1 回だけ定義木に写して保持し、canvas の変更のたびに
// live のモデル木と比べて装飾を置き直す。装飾は生 DOM だけに置く（`redlineApply.ts`）。
//
// RTE（インライン文字編集）は開始時に `el.innerHTML` を読み、終了時に変わっていればモデルへ
// 再取込する。編集対象の要素に旧文言の `<del>` が残っていると **旧文言が draft に混入**する
// ため、選択のたびにその選択パーツの装飾を外す（click は dblclick = RTE 開始に先行する）。
// 並べ替え（Sorter）はドロップ先の DOM 子要素からモデルを引くので、drag 開始で全装飾を外す。

import type { Component, Editor } from 'grapesjs';
import { toAppError } from '@editor/shared';
import { type Ref, ref, type ShallowRef, watch } from 'vue';
import { createLcsBudget } from '@/features/compare/htmlBlockDiff';
import { logError } from '@/lib/appError';
import { getBodyInner } from '@/lib/templateDoc';
import { applyRedline, clearRedline, clearRedlineWithin } from './redlineApply';
import { REDLINE_BODY_CLASS } from './redlineCss';
import { diffRedline } from './redlineDiff';
import { fromComponents, fromDefinitions, type RedlineNode } from './redlineTree';

/** 連続する変更をまとめる待ち時間。autosave（800ms）より短く、入力の手応えを損ねない範囲。 */
const RECOMPUTE_DEBOUNCE_MS = 300;

interface RedlineDeps {
  editor: ShallowRef<Editor | undefined>;
  revision: Ref<number>;
  editing: Ref<boolean>;
  /** draft が確定版と違う可能性があるか。false なら差分を計算せず装飾を外すだけ。 */
  dirty: Ref<boolean>;
}

export function useRedline(deps: RedlineDeps) {
  const enabled = ref(true);
  const available = ref(false);
  let baseline: RedlineNode[] | null = null;
  let dragging = false;
  let timer: ReturnType<typeof setTimeout> | null = null;

  function rootEl(): HTMLElement | undefined {
    return deps.editor.value?.getWrapper()?.getEl() ?? undefined;
  }

  function applyBodyClass(): void {
    deps.editor.value?.Canvas.getBody()?.classList.toggle(REDLINE_BODY_CLASS, enabled.value && available.value);
  }

  function clear(): void {
    const root = rootEl();
    if (root) clearRedline(root);
  }

  /**
   * 基準を確保する。編集経路（`?created=1` でない）で `Template.filled` を渡す。作成経路や
   * filled が無い版では undefined を渡し、機能ごと無効にする（トグルも出ない）。
   */
  function setBaseline(filledHtml: string | undefined): void {
    const ed = deps.editor.value;
    if (!ed || !filledHtml) {
      baseline = null;
      available.value = false;
      return;
    }
    const parsed = ed.Parser.parseHtml(getBodyInner(filledHtml)).html;
    baseline = fromDefinitions(parsed);
    available.value = baseline.length > 0;
    applyBodyClass();
    schedule();
  }

  /** `comp` が属するパーツ（`.page` 直下の block）の配下だけ装飾を外す。 */
  function clearPartOf(comp: Component | undefined): void {
    const el = comp?.getEl();
    const root = rootEl();
    if (!el || !root) return;
    let part: HTMLElement = el;
    while (part.parentElement && part.parentElement !== root && !part.parentElement.classList.contains('page')) {
      part = part.parentElement;
    }
    clearRedlineWithin(part);
  }

  /**
   * 装飾を置き直す。選択中のパーツは常に素の本文のままにする — RTE は選択後の dblclick で
   * 始まり、開始時に `innerHTML` を読むので、選択パーツに `<del>` があってはならない。
   */
  function recompute(): void {
    const ed = deps.editor.value;
    const root = rootEl();
    applyBodyClass();
    if (!ed || !root || !baseline) return;
    clearRedline(root);
    if (!enabled.value || !deps.dirty.value || deps.editing.value || dragging) return;
    try {
      const live = fromComponents(ed.getWrapper() as Component);
      applyRedline(root, diffRedline(baseline, live, createLcsBudget()));
      clearPartOf(ed.getSelected());
    } catch (e) {
      // 表示の失敗で編集を止めない。装飾は外した状態にして記録だけ残す。
      logError(toAppError(e));
      clearRedline(root);
    }
  }

  function schedule(): void {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = null;
      recompute();
    }, RECOMPUTE_DEBOUNCE_MS);
  }

  function toggle(): void {
    enabled.value = !enabled.value;
    recompute();
  }

  /**
   * 選択変更。選択パーツの装飾は**同期的に**外し（dblclick より前に済ませる）、直前まで
   * 選んでいたパーツの装飾は debounce 後の再計算で戻す（再計算は選択パーツを避ける）。
   * 選択解除（`comp` 無し）でも再計算して、外していた装飾を戻す。
   */
  function onSelected(comp: Component | undefined): void {
    clearPartOf(comp);
    schedule();
  }

  function onDragStart(): void {
    dragging = true;
    if (timer) clearTimeout(timer);
    timer = null;
    clear();
  }

  function onDragEnd(): void {
    dragging = false;
    schedule();
  }

  watch(deps.revision, schedule);
  watch(deps.dirty, schedule);

  return { enabled, available, setBaseline, toggle, recompute, schedule, onSelected, onDragStart, onDragEnd };
}
```

- [ ] **Step 2: canvas CSS を連結する**

`editor/web/src/features/editor/useGrapes.ts` の import に `import { redlineCanvasCss } from './redline/redlineCss';` を足し、`wireGrapesEvents` へ渡す `canvasCss` を次に変える:

```ts
      canvasCss: `${jinjaChipCanvasCss}\n${a4CanvasCss}\n${redlineCanvasCss}`,
```

- [ ] **Step 3: `useTemplateEditor` へ配線する**

`editor/web/src/features/editor/useTemplateEditor.ts`:

1. import に `import { useRedline } from './redline/useRedline';` を足す。
2. `const autosave = useAutosave(...)` の直後に:

```ts
  // 確定版からの変更箇所の赤入れ（旧文言の取り消し線）。基準は load 後に `setBaseline` で入れる。
  const redline = useRedline({ editor: g.editor, revision: g.revision, editing: g.editing, dirty });
```

3. `onMounted` 内、`g.setEditable(allowEdit.value);` の直後に:

```ts
    // 赤入れの基準は確定版（`filled`）。作成経路（`?created=1`）は確定版が無いので機能を出さない。
    redline.setBaseline(route.query.created === '1' ? undefined : res.value.template.filled);
```

4. `onMounted` 内の `g.onTextEditEnd((changed) => { ... })` の本体先頭に `redline.schedule();` を足す（`changed` の真偽に関わらず。RTE 中は抑止しているので終了時に必ず 1 回計算し直す）。
5. `g.onReorderStart(() => beginUndo());` を `g.onReorderStart(() => { beginUndo(); redline.onDragStart(); });` に、`g.onReorderEnd((moved) => {` の本体先頭に `redline.onDragEnd();` を足す。
6. `onMounted` の末尾（`g.onReorderEnd` の後）に:

```ts
    // 選択のたびに選択パーツの装飾を外す。RTE が開始時に読む `innerHTML` に旧文言を残さない
    // ため、Vue の flush を待たず同期で処理する（click は dblclick に先行する）。
    watch(g.selected, () => redline.onSelected(g.editor.value?.getSelected()), { flush: 'sync' });
```

7. 戻り値へ追加:

```ts
    redlineEnabled: redline.enabled,
    redlineAvailable: redline.available,
    toggleRedline: redline.toggle,
```

- [ ] **Step 4: 型チェックと既存テスト**

Run: `pnpm typecheck`（`@editor/shared` の先行ビルド込み）。
Expected: エラー 0。`ed.Parser.parseHtml(...).html` の型が `ComponentDefinitionDefined[]` で `fromDefinitions` の引数型に合わない場合は、`fromDefinitions` の引数型を `ComponentDefinition | ComponentDefinition[] | undefined` のまま保ち、呼び出し側で `as ComponentDefinition[]` を付ける（定義木の中身は同じ形）。

Run: `pnpm exec vitest run editor/web/test`
Expected: PASS（`twoSystems.guard.test.ts` / `canvasActiveContent.guard.test.ts` を含む）

- [ ] **Step 5: コミット**

```bash
pnpm exec biome check --write editor/web/src/features/editor/redline/useRedline.ts editor/web/src/features/editor/useGrapes.ts editor/web/src/features/editor/useTemplateEditor.ts
git add editor/web/src/features/editor/redline/useRedline.ts editor/web/src/features/editor/useGrapes.ts editor/web/src/features/editor/useTemplateEditor.ts
git commit -m "feat(editor): 確定版からの変更箇所を編集キャンバスへ赤入れ表示する

Claude-Session: https://claude.ai/code/session_01NS7sXef8dsEyg8qNYRtcYv"
```

---

### Task 7: 上部バーのトグル

**Files:**
- Modify: `editor/web/src/features/editor/EditorTopBar.vue`（props / emits / ボタン）
- Modify: `editor/web/src/features/editor/EditorView.vue`（destructure と props 配線）

**Interfaces:**
- Consumes: `redlineEnabled` / `redlineAvailable` / `toggleRedline`（Task 6）。
- `EditorTopBar` の新 props: `showRedline: boolean` / `redlineAvailable: boolean`、新 emit: `toggleRedline: []`。ボタンの `aria-label` は `showRedline ? '変更箇所の赤入れを隠す' : '変更箇所を赤入れで表示'`（e2e がこの名前で押す）。

- [ ] **Step 1: `EditorTopBar.vue`**

1. `@lucide/vue` の import に `Strikethrough` を足す（アルファベット順を保つ: `Save` の後、`Undo2` の前）。
2. props に追加:

```ts
  /** 確定版からの変更箇所を赤入れ（旧文言の取り消し線）で表示しているか。 */
  showRedline: boolean;
  /** 赤入れの基準（確定版）があるか。作成経路では無いのでボタンを出さない。 */
  redlineAvailable: boolean;
```

3. emits に `toggleRedline: [];` を追加。
4. テンプレートの「ページ境界 guide のトグル」ブロックの直後（同じ `div` 内）に:

```vue
      <!-- 確定版からの変更箇所の赤入れ。旧文言をインラインで挿すため行送りが PDF とずれる —
           OFF で流れを戻せる。作成経路は確定版が無いので出さない。 -->
      <Tooltip
        v-if="redlineAvailable"
        :text="showRedline ? '変更箇所の赤入れを隠す' : '変更箇所を赤入れで表示（旧文言に取り消し線）'"
      >
        <Button
          variant="ghost"
          size="icon"
          :aria-label="showRedline ? '変更箇所の赤入れを隠す' : '変更箇所を赤入れで表示'"
          :class="showRedline ? 'text-primary' : ''"
          @click="emit('toggleRedline')"
        >
          <Strikethrough class="h-[17px] w-[17px]" />
        </Button>
      </Tooltip>
```

- [ ] **Step 2: `EditorView.vue`**

1. destructure に `redlineEnabled, redlineAvailable, toggleRedline,` を追加（`dirty,` の後）。
2. `<EditorTopBar` の props に追加:

```vue
      :show-redline="redlineEnabled"
      :redline-available="redlineAvailable"
      @toggle-redline="toggleRedline"
```

- [ ] **Step 3: 型チェック**

Run: `pnpm typecheck`
Expected: エラー 0

- [ ] **Step 4: コミット**

```bash
pnpm exec biome check --write editor/web/src/features/editor/EditorTopBar.vue editor/web/src/features/editor/EditorView.vue
git add editor/web/src/features/editor/EditorTopBar.vue editor/web/src/features/editor/EditorView.vue
git commit -m "feat(editor): 上部バーに変更箇所の赤入れ表示トグルを追加する

Claude-Session: https://claude.ai/code/session_01NS7sXef8dsEyg8qNYRtcYv"
```

---

### Task 8: coverage include と e2e

**Files:**
- Modify: `vitest.config.ts`（`'editor/web/src/features/editor/partKey.ts',` の直後）
- Modify: `editor/e2e/canvas.spec.ts`（末尾へ 2 テスト追加）

- [ ] **Step 1: coverage include**

`vitest.config.ts` の `'editor/web/src/features/editor/partKey.ts',` の直後へ:

```ts
        // 編集キャンバスの赤入れ（旧文言の取り消し線）。装飾が draft に混入しないことは
        // 「モデルに載せない」設計で担保しており、この 4 ファイルの純粋部分を被覆に入れる。
        'editor/web/src/features/editor/redline/redlineTree.ts',
        'editor/web/src/features/editor/redline/redlineDiff.ts',
        'editor/web/src/features/editor/redline/redlineApply.ts',
        'editor/web/src/features/editor/redline/redlineCss.ts',
```

Run: `pnpm exec vitest run --coverage editor/web/test/redlineTree.test.ts editor/web/test/redlineDiff.test.ts editor/web/test/redlineApply.test.ts`
Expected: 4 ファイルとも全指標 85% 以上。足りない行があればテストを足す（実装を薄くしない）。

- [ ] **Step 2: e2e を書く**

`editor/e2e/canvas.spec.ts` の末尾へ:

```ts
/**
 * canvas 文書へ直接 dblclick を配送して RTE を開き、末尾へ文字列を追記して確定する。
 * Playwright の合成ダブルクリックは選択後に出る GrapesJS のオーバーレイに 2 打目を吸われて
 * 発火しない（`smoke.spec.ts` と同じ理由）。
 */
async function appendToParagraph(page: Page, frame: ReturnType<Page['frameLocator']>, needle: string, text: string) {
  await frame.getByText(needle).first().click();
  await page.evaluate((n) => {
    const doc = document.querySelector<HTMLIFrameElement>('iframe.gjs-frame')?.contentDocument;
    const p = [...(doc?.querySelectorAll('p') ?? [])].find((e) => (e.textContent ?? '').includes(n));
    p?.dispatchEvent(new MouseEvent('dblclick', { bubbles: true, cancelable: true }));
  }, needle);
  const editing = frame.locator('[contenteditable="true"]').first();
  await expect(editing).toBeVisible({ timeout: 10_000 });
  await editing.evaluate((el, t) => {
    el.append(t);
    el.dispatchEvent(new InputEvent('input', { bubbles: true }));
  }, text);
  await frame.locator('.page').first().click({ position: { x: 5, y: 5 } });
}

test('赤入れ: 文言を編集すると旧文言が取り消し線で出て、トグルで隠せ、draft には混入しない', async ({ page }) => {
  test.setTimeout(120_000);
  await login(page);
  const frame = await openEditor(page);

  // 変更前は装飾なし（draft も無い）
  await expect(frame.locator('[data-redline]')).toHaveCount(0);

  await page.getByRole('button', { name: '閲覧のみ(クリックで編集を許可)' }).click();
  await appendToParagraph(page, frame, '受益者のみなさまへ', 'E2E赤入れ');

  // 追記が canvas に入り、語句差分の結果として挿入語句の直前には旧文言の del は出ない
  // （純追記なので del は無し）。次に 1 語を置換して del を出す。
  await expect(frame.getByText('E2E赤入れ').first()).toBeVisible({ timeout: 10_000 });
  await frame.getByText('E2E赤入れ').first().click();
  await page.evaluate(() => {
    const doc = document.querySelector<HTMLIFrameElement>('iframe.gjs-frame')?.contentDocument;
    const p = [...(doc?.querySelectorAll('p') ?? [])].find((e) => (e.textContent ?? '').includes('E2E赤入れ'));
    p?.dispatchEvent(new MouseEvent('dblclick', { bubbles: true, cancelable: true }));
  });
  const editing = frame.locator('[contenteditable="true"]').first();
  await expect(editing).toBeVisible({ timeout: 10_000 });
  await editing.evaluate((el) => {
    // 「みなさま」→「皆様」に置換（旧文言 = みなさま が del として出るはず）
    for (const t of Array.from(el.childNodes)) {
      if (t.nodeType === Node.TEXT_NODE && (t.textContent ?? '').includes('みなさま')) {
        t.textContent = (t.textContent ?? '').replace('みなさま', '皆様');
      }
    }
    el.dispatchEvent(new InputEvent('input', { bubbles: true }));
  });
  await frame.locator('.page').first().click({ position: { x: 5, y: 5 } });

  // 旧文言が取り消し線 del として出る（再計算は 300ms debounce）
  const del = frame.locator('del[data-redline]', { hasText: 'みなさま' }).first();
  await expect(del).toBeVisible({ timeout: 15_000 });
  await expect(frame.locator('body')).toHaveClass(/redline-on/);

  // トグル OFF で消える（DOM からも外れる）
  await page.getByRole('button', { name: '変更箇所の赤入れを隠す' }).click();
  await expect(frame.locator('[data-redline]')).toHaveCount(0, { timeout: 10_000 });
  await expect(frame.locator('body')).not.toHaveClass(/redline-on/);
  await page.getByRole('button', { name: '変更箇所を赤入れで表示' }).click();
  await expect(frame.locator('del[data-redline]', { hasText: 'みなさま' }).first()).toBeVisible({ timeout: 15_000 });

  // 選択すると当該パーツの装飾が外れる（RTE の再取込に巻き込まない安全弁）
  await frame.getByText('皆様').first().click();
  await expect(frame.locator('del[data-redline]', { hasText: 'みなさま' })).toHaveCount(0, { timeout: 10_000 });

  // autosave 済みの draft（local モードは localStorage）に装飾が一切無い
  await expect(page.getByText(/に自動保存/)).toBeVisible({ timeout: 15_000 });
  const leaked = await page.evaluate(() =>
    Object.keys(localStorage).some((k) => (localStorage.getItem(k) ?? '').includes('data-redline')),
  );
  expect(leaked).toBe(false);
});

test('赤入れ: 作成経路(?created=1)ではトグルを出さない', async ({ page }) => {
  await login(page);
  await openEditor(page, '?created=1');
  await expect(page.getByRole('button', { name: /赤入れ/ })).toHaveCount(0);
  // 編集経路では出る
  await openEditor(page);
  await expect(page.getByRole('button', { name: /赤入れ/ })).toHaveCount(1, { timeout: 15_000 });
});
```

- [ ] **Step 3: e2e を実行**

Run: `cd editor && pnpm exec playwright test e2e/canvas.spec.ts`（既存の dev サーバがあれば再利用される）。
Expected: PASS。失敗したら `--trace on` で trace を開き、`del` の出現タイミング（debounce）と選択クリアの順序を確認する。

- [ ] **Step 4: 実機確認（Edge）**

`editor/start.bat dev local` で起動し、次の 3 経路を目視: (1) 文字編集後に del が出る → その段落を dblclick 編集 → 確定 → **draft に旧文言が混入していない**（右ペインの本文 / プレビューで確認）。(2) パーツを drag 並べ替え → 装飾が一旦消え、終了で戻る。(3) Ctrl+Z で undo → 装飾が追従する。問題があれば該当タスクへ戻して修正する。

- [ ] **Step 5: コミット**

```bash
pnpm exec biome check --write editor/e2e/canvas.spec.ts
git add vitest.config.ts editor/e2e/canvas.spec.ts
git commit -m "test(editor): 赤入れ表示の被覆対象追加と実画面テストを追加する

Claude-Session: https://claude.ai/code/session_01NS7sXef8dsEyg8qNYRtcYv"
```

---

### Task 9: ドキュメント

**Files:**
- Modify: `docs/superpowers/specs/2026-09-02-editor-canvas-redline-design.md`（§4.2 / §4.3 の `html: string` を `def` + `renderDefinition` に合わせる）
- Modify: `docs/editor/src/設計正典.md`（中核原則 + 却下済み設計）
- Modify: `docs/editor/src/設計書.md`（6.4 節に小節）
- Modify: `docs/editor/src/操作手順書.md`（5.1 上部バー / 5.3 紙面）
- Modify: `docs/editor/src/Editor_仕様一覧.md`（画面項目 1 行 + テスト仕様 1 行）
- 再生成: `docs/editor/editor_設計.html` / `docs/editor/editor_手引き.html`

- [ ] **Step 1: 設計書（spec）の追随**

`2026-09-02-editor-canvas-redline-design.md` §4.2 の `removedEl{parentRef, beforeRef|null, html}` を `removedEl{parent, before|null, inline, def|text}` に、§4.3 の `removedEl` 項を「`renderDefinition(def, doc)` で `createElement` / `setAttribute` / `createTextNode` により DOM を組む（`id` / `on*` / `data-gjs-*` は写さない）」に書き換える。§4.1 の `ref?: Component` を `node: NodeResolver` に揃える。§4.5 の「`partKey.partEls` と `pageView` の列挙から除外」は「`partKey.partEls` から除外（`pageView.enumeratePageEls` は `.page` だけを拾うので変更不要）」に直す。§4.5 の安全弁に「再計算は選択中のパーツを常に素のままにし、選択解除で戻す」を足す。

- [ ] **Step 2: 設計正典**

`docs/editor/src/設計正典.md` の中核原則、「**編集 canvas の能動コンテンツは入口で刈る**」項の直後へ:

```markdown
- **編集キャンバスの赤入れ表示は生 DOM の装飾で、モデルには載せない**: 確定版（`Template.filled`）
  からの変更箇所は、GrapesJS のモデル木と `Parser.parseHtml(確定版)` の定義木を比べて計算し
  （`features/editor/redline/`）、旧文言の `<del data-redline>`・追加要素の属性・挿入語句の
  CSS Highlight を canvas iframe の DOM にだけ置く。DOM 同士で比べないのは live 要素に自動 `id`
  が付くため。RTE は開始時に `innerHTML` を読んで終了時にモデルへ再取込するので、**選択のたびに
  選択パーツの装飾を外し**（click は dblclick に先行）、drag 開始で全装飾を外す。`partEls` は
  `[data-redline]` を除く（メモキー・採番を不変に保つ）。保存経路（`getHtml` / snapshot /
  申請 / PDF）には関与しない。作成経路（`?created=1`）は基準が無いので機能ごと出さない。
  表示 ON では行送り・改ページが PDF とずれる — これは仕様で、トグル OFF で戻す。
```

「却下済み設計」の「**canvas 入口の刈り取りを denylist へ戻す**」項の直前へ:

```markdown
- **赤入れの旧文言を GrapesJS component（`toHTML()` が空を返す専用 type）として挿す**: しない。
  `component:add` が dirty / undo / レイヤへ流れ、RTE の再取込で `data-gjs-type` が許可リスト外
  になって汎用 `del` として**モデルに吸収**される。装飾は生 DOM に限る。
```

- [ ] **Step 3: 設計書 6.4 節**

`docs/editor/src/設計書.md` の「## 6.4 編集画面のオーケストレーション」の箇条書き末尾（`useSnapshotHistory` の項の後）へ:

```markdown
- **`useRedline`**（`web/src/features/editor/redline/`）: 確定版からの変更箇所の赤入れ。基準は load 後に `Parser.parseHtml(Template.filled)` の定義木を 1 回だけ保持し、`revision` の変化を 300 ms debounce して live のモデル木と `diffRedline`（語句 LCS は `htmlBlockDiff` の `tokenize` / `diffTokens` を共有）で比べ、`applyRedline` が旧文言の `<del data-redline>`・追加要素の `data-redline-added`・挿入語句の CSS Highlight を canvas の生 DOM に置く。モデルに載せないので `getHtml()`（draft / snapshot / 申請）に現れない。選択・drag・RTE のたびに装飾を外して RTE の再取込に巻き込まない。上部バーのトグル（既定 ON）で OFF にでき、作成経路では出さない。
```

- [ ] **Step 4: 操作手順書**

`docs/editor/src/操作手順書.md` の「## 5.1 上部バー」の段落を次に置き換える:

```markdown
ファンド名と属性が表示されます。**元に戻す ／ やり直し**、**拡大 ／ 縮小（ズーム）**、**変更箇所を赤入れで表示**（取り消し線ボタン）、**自動保存の状態**（「○○ に自動保存」など）、**プレビュー**ボタンがあります。
```

「## 5.3 中央の区画：紙面（キャンバス）」の箇条書き末尾へ:

```markdown
- 文字を書き換えると、**元の文字が赤い取り消し線付き**で新しい文字の前に表示されます（追加したブロックは緑、削除したブロックは橙の帯）。これは「精査者が承認するまで、何を変えたか」を紙面上で確かめるための表示で、保存・申請・PDF には入りません。承認されると自動的に消えます。
  - 取り消し線の分だけ行送りが PDF とずれます。仕上がりの流れを確認したいときは、上部バーの**取り消し線ボタン**で表示を隠してください。
  - ブロックを選ぶと、そのブロックの取り消し線は一時的に消えます（編集中は元の文字だけが見えます）。他をクリックすると戻ります。
```

- [ ] **Step 5: 仕様一覧**

`docs/editor/src/Editor_仕様一覧.md` の画面項目表、`| 15 | 編集 | CSS | …` の直後へ（以降の No は振り直さない。No は表内で一意であればよいので末尾番号を採る。既存の最大 No を確認して +1 にする）:

```markdown
| <最大No+1> | 編集 | 変更箇所の赤入れ表示 | `showRedline` | `boolean` |  | 既定 ON。確定版と draft の差分を canvas の生 DOM に取り消し線で表示（保存・申請・PDF には載らない）。作成経路では非表示 |
```

テスト仕様表の末尾へ:

```markdown
| <最大No+1> | 編集（E2E） | 赤入れ表示 | 文言を置換 → トグル OFF/ON → パーツ選択 → autosave | 旧文言が `del[data-redline]` で出る／OFF で消える／選択パーツの装飾が外れる／draft に `data-redline` が無い | 済 |  |
```

- [ ] **Step 6: HTML 再生成と確認**

Run: `py -3.13 docs/_build/build_all.py --project editor`
Expected: `docs/editor/editor_設計.html` / `docs/editor/editor_手引き.html` が更新される。`pnpm run check:comments` も通す。

- [ ] **Step 7: コミット**

```bash
git add docs/superpowers/specs/2026-09-02-editor-canvas-redline-design.md docs/editor/src/設計正典.md docs/editor/src/設計書.md docs/editor/src/操作手順書.md docs/editor/src/Editor_仕様一覧.md docs/editor/editor_設計.html docs/editor/editor_手引き.html
git commit -m "docs(editor): 編集キャンバスの赤入れ表示を設計正典・設計書・手引き・仕様一覧へ記載する

Claude-Session: https://claude.ai/code/session_01NS7sXef8dsEyg8qNYRtcYv"
```

> `docs/editor/editor_手引き.html` は本件前から未コミットの差分がある。本タスクの再生成で上書きされるため、コミットに含めてよい（内容は最新の原稿から生成される）。`docs/editor/images/*.png` の未コミット差分は本件と無関係なので add しない。

---

## 完了条件

- `pnpm exec vitest run editor/web/test` が全件 PASS。
- `pnpm typecheck` がエラー 0。
- `cd editor && pnpm exec playwright test e2e/canvas.spec.ts` が PASS。
- 実機（Edge）で「RTE 再取込」「drag」「undo」の 3 経路を確認し、draft に `data-redline` が混入しない。
- docs 4 冊 + spec が更新され HTML が再生成されている。
