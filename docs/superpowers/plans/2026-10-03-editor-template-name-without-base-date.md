# editor: テンプレート(templates/)のファイル名から基準日を外す 実装計画

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** テンプレート(`templates/`)の ID とファイル名を基準日の無い `会社_ファンド_版種` にし、値入り HTML(`filled/`)の `会社_ファンド_基準日_版種` と形で見分ける。作成済みのテンプレートは作成タブから開いて直し、作業中のものがあるときの作り直しは確認ダイアログで同意を得てから行う。

**Architecture:** shared の `domain/template.ts` に 3 つ区切りの解析・組み立てと「どちらの形も受ける」判定を足し、`TemplateAttributes.baseDate` を省略可にする(Task 1)。server は置き場ごとに受ける形をパス解決の関数で強制する。まず「どちらの形も受ける」入口(pending・下書き・メモ・申請・版の一覧・ペア同期)を広げ(Task 2)、次に生成と `templates/` を 3 つ区切りへ切り替える(Task 3。生成の 409 は 3 種類、下書きと pending の破棄は生成器の成功後)。web は作成タブの「既存のテンプレートを開く」「作成中のテンプレートを開く」と作り直しの確認、同じタブの編集状態の破棄、基準日の項目の非表示、local モードの同じ規則を入れる(Task 4)。最後に文書(Task 5)と差分パッチ(Task 6)。

**Tech Stack:** TypeScript(Fastify / Vue 3 / Pinia / Zod / reka-ui)、vitest、Playwright、Python 3.13(テスト用の偽の生成器)。

**Spec:** `docs/superpowers/specs/2026-10-03-editor-template-name-without-base-date-design.md`(b3d9620 で作り直しの守り・生成器・移行の扱いを追記した版)

**前段の計画(書式の手本):** `docs/superpowers/plans/2026-10-03-editor-create-tab-fund-attributes.md`

**Reviews:** 初版を /dig と Fable でレビューし、指摘(版の一覧の 3 つ区切り、ファンド画像の解決の前倒し、文書の版番号、RED にならないテスト、confirmedWrite の対称ケース、pairSyncService のカバレッジ、CreateTabView のテストの組み方、撮影の状態、操作手順書のハイライトの注記、カバレッジの実行、local の作り直し)と、仕様の追記(作り直しの守り・生成器失敗時に消さない・同じタブの編集状態の破棄・生成器と移行の README)を反映した版。

## Global Constraints

- 範囲: `templates/` のファイル名だけ基準日を外す(`会社_ファンド_版種.html`)。`filled/` は `会社_ファンド_基準日_版種.html` のまま。
- ID の区別は形で行う。3 つ区切り = テンプレート、4 つ区切り = 値入り HTML。
- 置き場ごとの受ける ID: `templates/` は 3 つ区切りだけ、`filled/` は 4 つ区切りだけ、`pending/`・`drafts/`・`notes/`・`reviews/`・作成履歴はどちらの形も。パスを組み立てる関数が形を強制する(呼び出し側に任せない)。
- 移行はしない(別環境の `templates/` にファイルが無く、作成タブも未使用で、4 つ区切りの `pending/`・作成の申請も無い)。`templates/` に残った 4 つ区切りのファイルは、作成済み・コピー元の判定にも一覧にも数えない。パッチの README には念のため「当てる前に作成タブの申請を片付ける」と書く。
- 生成(`POST /api/generate`)の確認順: ① `templates/<ID>.html` がある → 409「作成済みです。既存のテンプレートを開いてください」 ② 同じ ID の承認待ちの申請(origin=create)がある → 409「申請中です。承認か却下を待ってください」 ③ 同じ ID の下書きか `pending/` があり、要求に `replaceExisting: true` が無い → 409「作成中のテンプレートがあります」 ④ 生成器を呼ぶ。成功したら同じ ID の下書き(`drafts/`)と `pending/` を消してから `pending/<ID>.html` に置く。生成器が失敗したら何も消さない。
- コメント(`notes/`)とパーツ変更履歴は作り直しでも消さない。作り直したときは、同じタブに残る編集状態(Undo のスタックと永続ミラー、下書きの持ち主)も捨てる。
- 生成器へ渡す JSON は `companyCode`・`fundCode`・`editionType` と、あれば `sourceFundCode`・`isRedemption`。`baseDate` は渡さない。偽の生成器のコピー元は `TEMPLATES_DIR/会社_コピー元_版種.html`(会社コードの大文字小文字は問わない)。本番の生成器は別途この約束へ改修する(パッチの README とリリースノートに明記)。
- `CreatableInfo.templateId` は作成済みのときだけ、`inProgressId` は作業中(同じ ID の下書きか `pending/`)のときだけ付ける。作成済みなら「既存のテンプレートを開く」を出し、「属性から新規作成」「シリーズから作成」は押せない。作業中なら「作成中のテンプレートを開く」を出し、新規作成・シリーズから作成は押せるが「作業中の内容を捨てて作り直しますか」と確認し、同意したら `replaceExisting: true` で生成する。どちらも `editorRoute(id, { created: true })` で開く。
- 版の一覧(`listVersions`。`filled/` の git 履歴)は 3 つ区切りの ID に空の配列を返す。
- 基準日を持たないテンプレートを開いているときは、`EditorTopBar` と `AttributeBar` から基準日の項目を丸ごと隠す。一覧の表(`TemplateTable`)は空欄。共通サンプルの `report.baseDate`(差し込み値)は今のまま。
- ペア同期はテンプレート側(作成の承認)にも掛ける。状態ファイルはテンプレート側 `sync/会社_ファンド.json`、値入り側 `sync/会社_ファンド_基準日.json`。設計正典の却下済み設計 #46 を改訂する。
- local モード: 生成の ID は 3 つ区切り。作成済み・作業中・申請中・コピー元・取得・`replaceExisting` の規則を server と同じにする。fixtures の `templates/`(4 つ区切り)は値入りとして扱う今の動きを保つ。
- 2 系統の原則(編集タブ = `tpl.filled` + ハイライト無し、作成タブ = `/edit/:id?created=1` + ハイライト有り)は崩さない。作成タブから開く既存・作業中のテンプレートは作成経路。
- 各コミットで `pnpm typecheck` と `pnpm run test:editor` が通ること(pre-push の `ci-affected` は editor を触ると typecheck + `test:editor` + build + `e2e:editor` を走らせる)。追加 → 切り替え → 削除の順に並べ、壊れる既存テストは同じコミットで書き換える。カバレッジ(`pnpm run test:coverage`)は pre-push に入らないので Task 2 と Task 4 の後に自分で走らせる。
- `editor/**` を変えたコミットの前に `pnpm exec biome check --write <対象>`。vitest はリポジトリ直下から `pnpm exec vitest run --project server <path>` / `--project shared <path>` / `--project "web-*" <path>` で走らせる。
- openapi.json の再生成は `pnpm exec tsc -b editor/shared` → `pnpm --filter server run openapi:gen`(スキーマを変えたコミットで必ず)。新しいルートは足さない(`ROUTE_POLICY` の追加は無い)。
- カバレッジは root `vitest.config.ts` の include 列挙 = テスト済みのファイルだけ・ファイル単位で 85%。新しく作ってテストしたファイルは include に足す。
- コメントに経緯(変更日・移植元・所見番号・「以前は」)を書かない。コミットメッセージに Co-Authored-By / Claude-Session の行を付けない。
- フルの pre-push は 10 分を超えうる。push が終わったかは `git ls-remote origin chore/deps-latest-offline-bundle` で確かめ、止まっていたらユーザーに `! git push` を頼む。

## Review Focus

1. 生成器が失敗した作り直しで、前回の下書きと `pending/` が消えて作業が失われる。生成器が失敗したら何も消さず、成功したときだけ消す(Task 3 の `generate.routes.test.ts` の `generateMock.mockRejectedValueOnce` で固定)。
2. 作業中(同じ ID の下書きか pending)のテンプレートを、同意なしに作り直して上書きする。`replaceExisting` が無ければ 409「作成中のテンプレートがあります」、画面は確認で断れば生成しない(Task 3 の server テスト、Task 4 の `CreateTabView.dom.test.ts` と local のテストで固定)。作り直してもコメントとパーツ変更履歴は残る(Task 3 で固定)。
3. 会社コードの大文字小文字だけが違うテンプレート(`am01_510037_交付版.html`)や、`templates/` に残った旧形式(4 つ区切り)のファイルがあるときの作成済み・コピー元の判定。前者は作成済み(`templateId` はファイルの綴り)で 409、後者は数えない(Task 3 の `generate.routes.test.ts`・`templateRepo.creatable.test.ts`・`fakeGenerator.test.ts`・`templateRepo.filled.test.ts` で固定)。
4. 編集タブの一覧に pending の 3 つ区切りの行が出たとき、版数を問う `GET /templates/:id/versions` が 400 になって一覧の版数が壊れる。3 つ区切りは 200 `[]`(Task 2 の `history.routes.test.ts` で固定)。
5. テンプレートの承認後のペア同期の状態ファイルが、同じ会社・ファンドの値入り側の状態ファイルを上書きする。テンプレート側は `sync/AM01_510037.json`、値入り側は `sync/AM01_510037_20240710.json`(Task 2 の `pairSyncService.test.ts` で固定)。

---

### Task 1: shared — テンプレート(3 つ区切り)の名前と、どちらの形も受ける判定を足す

振る舞いは変えない(3 つ区切りの ID を作る経路はまだ無い)。`TemplateAttributes.baseDate` を省略可にした型の波及だけを直す。

**Files:**
- Modify: `editor/shared/src/domain/template.ts`(下の Step 3)
- Modify: `editor/shared/src/schemas.ts:52-81`(`TemplateId`・`TemplateAttributes`)、`editor/shared/src/index.ts:19`(コメント)
- Modify: `editor/shared/src/domain/sampleData.ts:25-30,58-79`(`applyTemplateAttributes`)
- Modify(型の波及): `editor/server/src/repositories/templateRepo.ts:54-83`、`editor/server/src/routes/generate.routes.ts:13-22,55-60`、`editor/web/src/api/local/templateRepo.ts:226-250,280,295-302`、`editor/web/src/api/local/store.ts:206`、`editor/web/src/api/local/reviewRepo.ts:14-21,77`、`editor/web/src/features/templates/HistoryTabView.vue:11,54,79`
- Test: `editor/shared/test/templateName.test.ts`、`editor/shared/test/pathGuards.test.ts`、`editor/shared/test/templatePair.test.ts`、`editor/shared/test/sampleData.test.ts`
- Regenerate: `editor/server/openapi/openapi.json`

**Interfaces:**
- Produces(`@editor/shared`。`index.ts` が `export * from './domain/template.js'` で再輸出する):
  - `type FilledTemplateAttributes = TemplateAttributes & { baseDate: string }`
  - `type SkeletonAttributes = Omit<TemplateAttributes, 'baseDate'>`
  - `parseTemplateFileName(fileName: string): FilledTemplateAttributes | null`(4 つ区切りだけ。戻り値の型だけ狭める)
  - `templateFileName(a: FilledTemplateAttributes): string`
  - `SKELETON_FILENAME_RE: RegExp`、`parseSkeletonFileName(fileName: string): SkeletonAttributes | null`、`skeletonFileName(a: SkeletonAttributes): string`
  - `parseAnyTemplateFileName(fileName: string): TemplateAttributes | null`、`anyTemplateFileName(a: TemplateAttributes): string`
  - `isValidSkeletonId(id: string): boolean`、`isValidAnyTemplateId(id: string): boolean`、`assertAnyTemplateId(id: string): string`、`assertSkeletonFileName(fileName: string): string`
  - `pairedTemplateId(id)` は両方の形、`templatePairKey(a)` はテンプレートなら `会社_ファンド`、値入りなら `会社_ファンド_基準日`、`isValidPairKey(key)` は 2 つ区切りと 3 つ区切りを受ける
  - `TemplateAttributes.baseDate?: string`、`TemplateId`(Zod)は `isValidAnyTemplateId` で判定
- 変えないもの: `TEMPLATE_FILENAME_RE`・`isValidTemplateId`・`assertTemplateId`・`assertTemplateFileName` は 4 つ区切り専用のまま。

- [ ] **Step 1: 失敗するテストを書く**

`editor/shared/test/templateName.test.ts`: import に `anyTemplateFileName`・`type FilledTemplateAttributes`・`parseAnyTemplateFileName`・`parseSkeletonFileName`・`skeletonFileName` を足し、`const SAMPLE: TemplateAttributes` を `const SAMPLE: FilledTemplateAttributes` に変える(`templateFileName` の引数が基準日必須になるため。`type TemplateAttributes` の import は使わなくなれば消す)。末尾に追加:

```ts
describe('テンプレート(3 つ区切り)のファイル名', () => {
  const SKELETON = { companyCode: 'AM01', fundCode: '510037', editionType: '交付版' };

  it('parseSkeletonFileName は 3 つ区切りだけを解析する', () => {
    expect(parseSkeletonFileName('AM01_510037_交付版.html')).toEqual(SKELETON);
    expect(parseSkeletonFileName('AM01_510037_20240710_交付版.html')).toBeNull();
    expect(parseSkeletonFileName('AM01_510037.html')).toBeNull();
  });

  it('parseTemplateFileName は 3 つ区切りを解析しない(2 つの形は重ならない)', () => {
    expect(parseTemplateFileName('AM01_510037_交付版.html')).toBeNull();
  });

  it('skeletonFileName は基準日を入れない', () => {
    expect(skeletonFileName(SKELETON)).toBe('AM01_510037_交付版.html');
  });

  it('parseAnyTemplateFileName は形に応じて基準日の有無を返す', () => {
    expect(parseAnyTemplateFileName('AM01_510037_交付版.html')).toEqual(SKELETON);
    expect(parseAnyTemplateFileName(SAMPLE_FILE)).toEqual(SAMPLE);
    expect(parseAnyTemplateFileName('AM01.html')).toBeNull();
  });

  it('anyTemplateFileName は基準日があれば 4 つ、無ければ 3 つ区切りで組む', () => {
    expect(anyTemplateFileName(SAMPLE)).toBe(SAMPLE_FILE);
    expect(anyTemplateFileName(SKELETON)).toBe('AM01_510037_交付版.html');
  });

  it('templateIdFromFileName は形を問わず .html を外す', () => {
    expect(templateIdFromFileName('AM01_510037_交付版.html')).toBe('AM01_510037_交付版');
  });
});
```

`editor/shared/test/pathGuards.test.ts`: import に `assertAnyTemplateId`・`assertSkeletonFileName`・`isValidAnyTemplateId`・`isValidSkeletonId` を足し、`import { TemplateId } from '../src/schemas';` を足す。

既存ケースの書き換え(2 つ区切りのペアキーを受けるようになるため): `'rejects a key with too few or too many tokens'` の `expect(isValidPairKey('AM01_510037')).toBe(false);` を `expect(isValidPairKey('AM01')).toBe(false);` にし、ケース名を `'rejects a key with one token or four tokens'` にする。`'accepts the canonical company_fund_baseDate form'` の後に追加:

```ts
  it('テンプレート側の company_fund(2 つ区切り)も受ける', () => {
    expect(isValidPairKey('AM01_510037')).toBe(true);
    expect(isValidPairKey('AM01_../evil')).toBe(false);
  });
```

ファイル末尾に追加:

```ts
describe('テンプレート(3 つ区切り)の id とどちらの形も受ける入口', () => {
  const SKELETON_ID = 'AM01_510037_交付版';

  it('isValidSkeletonId は 3 つ区切りだけ、isValidTemplateId は 4 つ区切りだけを受ける', () => {
    expect(isValidSkeletonId(SKELETON_ID)).toBe(true);
    expect(isValidSkeletonId(VALID_ID)).toBe(false);
    expect(isValidTemplateId(SKELETON_ID)).toBe(false);
  });

  it('isValidAnyTemplateId は両方の形を受け、どちらでもない形は受けない', () => {
    expect(isValidAnyTemplateId(SKELETON_ID)).toBe(true);
    expect(isValidAnyTemplateId(VALID_ID)).toBe(true);
    expect(isValidAnyTemplateId('AM01_510037')).toBe(false);
    expect(isValidAnyTemplateId('AM01_510037_20240710_交付版_extra')).toBe(false);
  });

  it('どちらの形でもトラバーサル・空白・制御文字・長すぎる値は通らない(片方だけ緩む穴が無い)', () => {
    for (const payload of TRAVERSAL_PAYLOADS) expect(isValidAnyTemplateId(payload)).toBe(false);
    expect(isValidAnyTemplateId('AM01_510037_../../evil')).toBe(false);
    expect(isValidAnyTemplateId('AM01 _510037_交付版')).toBe(false);
    expect(isValidAnyTemplateId(`${SKELETON_ID} `)).toBe(false);
    expect(isValidAnyTemplateId(`${SKELETON_ID}.`)).toBe(false);
    expect(isValidAnyTemplateId('AM01_510037_\u001f版')).toBe(false);
    expect(isValidAnyTemplateId(`AM01_510037_${'あ'.repeat(300)}`)).toBe(false);
  });

  it('assertAnyTemplateId は通らなければ validation を投げ、通れば入力を返す', () => {
    expect(assertAnyTemplateId(SKELETON_ID)).toBe(SKELETON_ID);
    expect(() => assertAnyTemplateId('../evil')).toThrowError(
      expect.objectContaining({ kind: 'validation' }),
    );
  });

  it('assertSkeletonFileName は 3 つ区切りのファイル名だけを受ける', () => {
    expect(assertSkeletonFileName(`${SKELETON_ID}.html`)).toBe(`${SKELETON_ID}.html`);
    for (const bad of [`${VALID_ID}.html`, '../../evil.html', 'AM01 _510037_交付版.html']) {
      expect(() => assertSkeletonFileName(bad)).toThrowError(
        expect.objectContaining({ kind: 'validation' }),
      );
    }
  });

  it('契約の TemplateId は両方の形を受ける', () => {
    expect(TemplateId.safeParse(SKELETON_ID).success).toBe(true);
    expect(TemplateId.safeParse(VALID_ID).success).toBe(true);
    expect(TemplateId.safeParse('../evil').success).toBe(false);
  });
});
```

`editor/shared/test/templatePair.test.ts`: `describe('pairedTemplateId', ...)` の中に追加:

```ts
  it('テンプレート(3 つ区切り)は 3 つ区切りのペアを返す', () => {
    expect(pairedTemplateId('AM01_510037_交付版')).toBe('AM01_510037_全体版');
    expect(pairedTemplateId('AM01_510037_全体版')).toBe('AM01_510037_交付版');
    expect(pairedTemplateId('AM01_510037_kr')).toBeNull();
  });
```

`describe('templatePairKey', ...)` の中に追加:

```ts
  it('基準日の無いテンプレートは会社_ファンド(値入り HTML のキーとは別になる)', () => {
    const t = { companyCode: 'AM01', fundCode: '510037' };
    expect(templatePairKey({ ...t, editionType: '交付版' })).toBe('AM01_510037');
    expect(templatePairKey({ ...t, editionType: '全体版' })).toBe('AM01_510037');
  });
```

`editor/shared/test/sampleData.test.ts` の `describe('applyTemplateAttributes', ...)` に追加:

```ts
  it('基準日を持たないテンプレートでは共通サンプルの report.baseDate を残す', () => {
    const out = applyTemplateAttributes(
      { report: { baseDate: '2025年1月1日' } },
      { editionType: '全体版' },
    );
    expect(out.report).toEqual({ baseDate: '2025年1月1日', editionType: '全体版' });
  });
```

- [ ] **Step 2: 失敗を確かめる**

Run: `pnpm exec vitest run --project shared editor/shared/test/templateName.test.ts editor/shared/test/pathGuards.test.ts editor/shared/test/templatePair.test.ts editor/shared/test/sampleData.test.ts`
Expected: FAIL(`parseSkeletonFileName is not a function` など。`isValidPairKey('AM01_510037')` は false のまま、`applyTemplateAttributes` は `baseDate: undefined` を整形しようとして `report.baseDate` が `undefined` になる)。

- [ ] **Step 3: `domain/template.ts` を実装する**

ファイル先頭のコメント(2〜5 行)を次に替える:

```ts
// =============================================================================
// template.ts — テンプレート identity の値オブジェクトとファイル名規約の純関数
// =============================================================================
// ファイル名規約は 2 つで、区切りの数で見分ける。値入り HTML(`filled/`)は基準日ごとに別物なので
// `company_fund_date_edition.html`、テンプレート(`templates/`)は基準日で使い回さないので
// `company_fund_edition.html`。純粋・依存なしなので `web` と `server` の双方で再利用できる。
```

`TEMPLATE_FILENAME_RE` の直前に型を足し、解析・組み立てを次にする(`TEMPLATE_FILENAME_RE` 自体と直前のコメントは変えない):

```ts
/** 値入り HTML(`filled/`)の属性。基準日を必ず持つ。 */
export type FilledTemplateAttributes = TemplateAttributes & { baseDate: string };

/** テンプレート(`templates/`)の属性。基準日を持たない。 */
export type SkeletonAttributes = Omit<TemplateAttributes, 'baseDate'>;

/** 値入り HTML のファイル名(4 つ区切り)を解析する。3 つ区切りは null。 */
export function parseTemplateFileName(fileName: string): FilledTemplateAttributes | null {
  const m = TEMPLATE_FILENAME_RE.exec(fileName);
  if (!m?.groups) return null;
  const { companyCode, fundCode, baseDate, editionType } = m.groups;
  return { companyCode, fundCode, baseDate, editionType };
}

export function templateFileName(a: FilledTemplateAttributes): string {
  return `${a.companyCode}_${a.fundCode}_${a.baseDate}_${a.editionType}.html`;
}

/** テンプレート(`templates/`)のファイル名規約。トークンの許可文字は `TEMPLATE_FILENAME_RE` と同じ。 */
export const SKELETON_FILENAME_RE =
  /^(?<companyCode>[^_/\\]+)_(?<fundCode>[^_/\\]+)_(?<editionType>[^_/\\]+)\.html$/;

/** テンプレートのファイル名(3 つ区切り)を解析する。4 つ区切りは null。 */
export function parseSkeletonFileName(fileName: string): SkeletonAttributes | null {
  const m = SKELETON_FILENAME_RE.exec(fileName);
  if (!m?.groups) return null;
  const { companyCode, fundCode, editionType } = m.groups;
  return { companyCode, fundCode, editionType };
}

export function skeletonFileName(a: SkeletonAttributes): string {
  return `${a.companyCode}_${a.fundCode}_${a.editionType}.html`;
}

/**
 * どちらの形も受ける置き場(`pending/`・下書き・メモ・申請・履歴)用の解析。4 つ区切りなら
 * 基準日付き、3 つ区切りなら基準日の無い属性を返す。
 */
export function parseAnyTemplateFileName(fileName: string): TemplateAttributes | null {
  return parseTemplateFileName(fileName) ?? parseSkeletonFileName(fileName);
}

/** 属性からファイル名を組む。基準日があれば値入り HTML、無ければテンプレートの形。 */
export function anyTemplateFileName(a: TemplateAttributes): string {
  return a.baseDate === undefined
    ? skeletonFileName(a)
    : templateFileName({ ...a, baseDate: a.baseDate });
}
```

`templateIdFromFileName` はそのまま(形を問わず `.html` を外す)。ペアの節を次にする(`EDITION_SYNC_PAIRS` とその上のコメントは変えない):

```ts
/**
 * テンプレート ID から同期ペアの ID を導く。形(3 つ区切り / 4 つ区切り)はそのままで版種だけを
 * 入れ替える。版種がペア対象外・ID が規約外なら null。
 * ペア実体(ファイル)の存在確認は呼び出し側の責務(ここは純粋な名前変換のみ)。
 */
export function pairedTemplateId(templateId: string): string | null {
  const attrs = parseAnyTemplateFileName(`${templateId}.html`);
  if (!attrs) return null;
  const paired = EDITION_SYNC_PAIRS[attrs.editionType];
  if (!paired) return null;
  return templateIdFromFileName(anyTemplateFileName({ ...attrs, editionType: paired }));
}

/**
 * ペア単位の識別子(版種を除いた属性)。同期状態ファイル `sync/<pairKey>.json` の名に使う。
 * テンプレートは `会社_ファンド`、値入り HTML は `会社_ファンド_基準日` になり、状態ファイルは別になる。
 */
export function templatePairKey(a: TemplateAttributes): string {
  return a.baseDate === undefined
    ? `${a.companyCode}_${a.fundCode}`
    : `${a.companyCode}_${a.fundCode}_${a.baseDate}`;
}
```

パス安全性の節を次のとおり直す:

```ts
/** `TemplateAttributes` のトークン(基準日は持つときだけ)がすべて安全か。 */
function attributesAreSafe(a: TemplateAttributes): boolean {
  const tokens = [a.companyCode, a.fundCode, a.editionType];
  if (a.baseDate !== undefined) tokens.push(a.baseDate);
  return tokens.every(isValidTemplateToken);
}

/** 値入り HTML の id(4 つ区切り)がファイル名規約に一致し、全体もトークン単位でも安全か。 */
export function isValidTemplateId(templateId: string): boolean {
  const attrs = parseTemplateFileName(`${templateId}.html`);
  return attrs !== null && isSafeFileNameSegment(templateId) && attributesAreSafe(attrs);
}

/** テンプレートの id(3 つ区切り)がファイル名規約に一致し、全体もトークン単位でも安全か。 */
export function isValidSkeletonId(templateId: string): boolean {
  const attrs = parseSkeletonFileName(`${templateId}.html`);
  return attrs !== null && isSafeFileNameSegment(templateId) && attributesAreSafe(attrs);
}

/**
 * どちらの形でもよい置き場(`pending/`・下書き・メモ・申請・履歴)の id の検査。判定は 2 つの
 * 関数の論理和にして、片方の形だけ検査が緩む書き方をしない。
 */
export function isValidAnyTemplateId(templateId: string): boolean {
  return isValidTemplateId(templateId) || isValidSkeletonId(templateId);
}
```

`isValidPairKey` のコメントと本体:

```ts
/**
 * ペアキー(`templatePairKey` の形。テンプレートは `companyCode_fundCode`、値入り HTML は
 * `companyCode_fundCode_baseDate`)が全体・トークン単位ともに安全か。`syncFiles.ts` が
 * `sync/<pairKey>.json` へ連結する前の検査に使う。
 */
export function isValidPairKey(pairKey: string): boolean {
  const tokens = pairKey.split('_');
  return (tokens.length === 2 || tokens.length === 3) && tokens.every(isValidTemplateToken);
}
```

`assertTemplateId` の後に追加:

```ts
/** `isValidAnyTemplateId` に通らなければ `validation` を投げ、通れば入力をそのまま返す。 */
export function assertAnyTemplateId(templateId: string): string {
  if (!isValidAnyTemplateId(templateId)) {
    throw validation(`不正なテンプレート id です: ${templateId}`);
  }
  return templateId;
}
```

`assertTemplateFileName` のコメントの「テンプレート本体のファイル名」を「値入り HTML のファイル名(4 つ区切り)」にし、その後に追加:

```ts
/**
 * テンプレート(`templates/`)のファイル名(3 つ区切り)として安全か検査し、正規化した名前を返す。
 * 検査はファイル名全体と 3 トークンそれぞれの両方に掛ける(`assertTemplateFileName` と同じ)。
 */
export function assertSkeletonFileName(fileName: string): string {
  const attrs = parseSkeletonFileName(fileName);
  if (!attrs || !isSafeFileNameSegment(fileName) || !attributesAreSafe(attrs)) {
    throw validation(`不正なテンプレートファイル名です: ${fileName}`);
  }
  return skeletonFileName(attrs);
}
```

- [ ] **Step 4: スキーマとサンプルを直す**

`schemas.ts`: import を `import { isValidAnyTemplateId } from './domain/template.js';` にする。`TemplateId` の doc コメントの `assertTemplateId` を `assertAnyTemplateId` にし、本体を:

```ts
export const TemplateId = z
  .string()
  .refine(isValidAnyTemplateId, { message: '不正なテンプレート id です' })
  .meta({
    id: 'TemplateId',
    example: 'AM01_510037_20240710_交付版',
    // (既存の 3 行のコメントはそのまま)
    description:
      'ファイル名規約(拡張子なし)。値入り HTML は `<会社コード>_<ファンドコード>_<基準日>_<版種>`、' +
      'テンプレートは `<会社コード>_<ファンドコード>_<版種>`。' +
      'パス区切り・`..`・制御文字・末尾のドット/空白を含まない単一のファイル名セグメントに限る' +
      '(判定は `isValidAnyTemplateId`)。',
  });
```

`TemplateAttributes`:

```ts
/**
 * テンプレートを識別する属性。値入り HTML は 4 つ(company_fund_date_edition.html)、
 * テンプレートは基準日を除く 3 つ(company_fund_edition.html)。
 */
export const TemplateAttributes = z
  .object({
    companyCode: z.string().meta({ description: '委託会社コード' }),
    fundCode: z.string().meta({ description: 'ファンドコード' }),
    baseDate: z.string().optional().meta({
      description: '基準日 (yyyymmdd)。値入り HTML(filled/)だけが持ち、テンプレート(templates/)は持たない',
      example: '20240710',
    }),
    editionType: z.string().meta({ description: '版種' }),
  })
  .meta({ id: 'TemplateAttributes' });
```

`index.ts:19` のコメントを `/** テンプレートを識別する属性(値入り HTML は 4 つ、テンプレートは基準日を除く 3 つ)。 */` にする。

`sampleData.ts` の `SampleTemplateAttributes` の doc に「テンプレート(基準日を持たない)を開く文脈では基準日は無い」を 1 文足し、`applyTemplateAttributes` を:

```ts
export function applyTemplateAttributes(
  sample: SampleData,
  attrs: SampleTemplateAttributes,
): SampleData {
  const report = (sample.report ?? {}) as Record<string, unknown>;
  return {
    ...sample,
    report: {
      ...report,
      editionType: attrs.editionType,
      // テンプレート(基準日を持たない)を開いているときは、共通サンプルの基準日を差し込み値として残す。
      ...(attrs.baseDate === undefined ? {} : { baseDate: formatBaseDate(attrs.baseDate) }),
    },
  };
}
```

- [ ] **Step 5: shared のテストを通す**

Run: Step 2 と同じコマンド。
Expected: PASS。

- [ ] **Step 6: 型の波及を直す(振る舞いは変えない)**

- `editor/server/src/repositories/templateRepo.ts`:
  - `matchesUpTo`: `return !want || sameCi(m.attributes[k] ?? '', want);`
  - `optionsFromMetas` の `at`: 候補に空の値を入れない:

```ts
  const at = (depth: number, key: (typeof ATTR_KEYS)[number]) =>
    uniqCi(metas.filter((m) => matchesUpTo(m, q, depth)).flatMap((m) => m.attributes[key] ?? []));
```

- `editor/server/src/routes/generate.routes.ts`: import の `type TemplateAttributes` を `type FilledTemplateAttributes` にし、`const attributes: FilledTemplateAttributes = {`。
- `editor/web/src/api/local/templateRepo.ts`:
  - `matchesUpper`: `return !want || (m.attributes[f] ?? '').toLowerCase() === want.toLowerCase();`
  - `baseDates`: `.map((m) => m.attributes.baseDate)` を `.flatMap((m) => m.attributes.baseDate ?? [])`
  - `generate` のコピー元の並べ替え: `.sort((a, b) => (a.attributes.baseDate ?? '').localeCompare(b.attributes.baseDate ?? ''))`
  - `generate` の `const attrs: TemplateAttributes` を `const attrs: FilledTemplateAttributes`(import も入れ替える。`TemplateAttributes` を他で使っていれば残す)
- `editor/web/src/api/local/store.ts:206`: `(!q.baseDate || sameCi(m.attributes.baseDate ?? '', q.baseDate)) &&`
- `editor/web/src/api/local/reviewRepo.ts`: import の `templateFileName` を `anyTemplateFileName` にし、`assertEditSubmissionAllowed` の `resolveFilled(templateId, templateFileName(attrs))` を `resolveFilled(templateId, anyTemplateFileName(attrs))` にする。
- `editor/web/src/features/templates/HistoryTabView.vue`: import の `templateFileName` を `anyTemplateFileName` にし、54 行と 79 行の `templateFileName(e.attributes)` を `anyTemplateFileName(e.attributes)` にする(作成履歴の「生成ファイル」は、基準日の無い履歴なら `会社_ファンド_版種.html` と出る)。

`EditorTopBar.vue` / `AttributeBar.vue` / `TemplateTable.vue` / `CompareCandidateTable.vue` / `MergeSelectionList.vue` はテンプレート内で表示するだけなので型は通る(隠す処理は Task 4)。

Run: `pnpm typecheck`
Expected: exit 0。通らない箇所が残れば、上と同じ形(`?? ''` で比べる、`?? []` で候補から外す、ファイル名は `anyTemplateFileName`)で直す。

- [ ] **Step 7: openapi を作り直して全体を確かめる**

```bash
pnpm exec tsc -b editor/shared
pnpm --filter server run openapi:gen
pnpm run test:editor
```

Expected: `openapi.json` の `TemplateAttributes.required` から `baseDate` が外れ、`TemplateId` の説明が変わる。`test:editor` は全件 PASS(`openapiArtifact.guard` を含む)。

- [ ] **Step 8: コミット**

```bash
pnpm exec biome check --write editor/shared/src editor/shared/test editor/server/src editor/web/src
git add editor/shared/src/domain/template.ts editor/shared/src/schemas.ts editor/shared/src/index.ts editor/shared/src/domain/sampleData.ts editor/shared/test/templateName.test.ts editor/shared/test/pathGuards.test.ts editor/shared/test/templatePair.test.ts editor/shared/test/sampleData.test.ts editor/server/src/repositories/templateRepo.ts editor/server/src/routes/generate.routes.ts editor/web/src/api/local/templateRepo.ts editor/web/src/api/local/store.ts editor/web/src/api/local/reviewRepo.ts editor/web/src/features/templates/HistoryTabView.vue editor/server/openapi/openapi.json
git commit -m "feat(shared): テンプレート(3 つ区切り)のファイル名と、どちらの形も受ける入口の判定を足す"
```

---

### Task 2: server — どちらの形も受ける置き場で、テンプレート(3 つ区切り)の id を受ける

生成はまだ 4 つ区切りを作る。ここでは「どちらの形も」の置き場と、承認・ペア同期・注記マスタ・版の一覧が 3 つ区切りを扱えるようにするだけ。`templates/` のパス解決はこの段では両方の形を受ける(3 つ区切りだけに絞るのは Task 3)。

**Files:**
- Modify: `editor/server/src/files/pendingFiles.ts:14,21-22,26,62`、`editor/server/src/files/draftFiles.ts:11,18-19,28`、`editor/server/src/files/notesFile.ts:12,38-49`
- Modify: `editor/server/src/files/templateFiles.ts:17,24-25`(`templatePath`)
- Modify: `editor/server/src/repositories/templateMeta.ts:7,18`
- Modify: `editor/server/src/repositories/confirmedWrite.ts:25-31,203-207`
- Modify: `editor/server/src/repositories/reviewRepo.ts:15,21,86-99,172-173`
- Modify: `editor/server/src/repositories/historyRepo.ts:9,95-106`(`listVersions`)
- Modify: `editor/server/src/sync/pairSyncService.ts:17,51,80-81`、`editor/server/src/sync/noteMasterService.ts:15,55`
- Create: `editor/server/test/pairSyncService.test.ts`
- Modify(テスト): `editor/server/test/notesFile.test.ts`、`pathGuards.test.ts`、`templateRepo.filled.test.ts`、`reviews.test.ts`、`templates.routes.test.ts`、`noteMasterService.test.ts`、`confirmedWrite.guard.test.ts`、`history.routes.test.ts`
- Modify(測定の結果しだい): `vitest.config.ts`(include に `editor/server/src/sync/pairSyncService.ts`)

**Interfaces:**
- Consumes: Task 1 の `parseAnyTemplateFileName`・`anyTemplateFileName`・`parseSkeletonFileName`・`assertSkeletonFileName`・`isValidAnyTemplateId`・`assertAnyTemplateId`・`isValidSkeletonId`・`templatePairKey`・`pairedTemplateId`
- Produces: `confirmedWrite.ts` の module-private `assertFileNameFor(target: ConfirmedTarget, fileName: string): string`(Task 3 が本体を差し替える)。`fileToMeta` は両方の形を解析する。`listVersions(templateId)` は 3 つ区切りに `[]` を返す。

- [ ] **Step 1: 既存テストの書き換えと、失敗するテストを書く**

既存の書き換え(この Task で壊れるもの):
- `editor/server/test/notesFile.test.ts` の `'rejects ids that are not 4-token template names'`: `readNotes('AM01_510037_20240710')` は「版種が 20240710 のテンプレート」として正しい形になるので、ケースを次に替える:

```ts
  it('rejects ids that are neither a template (3 tokens) nor a filled id (4 tokens)', async () => {
    await expect(readNotes('notatemplate')).rejects.toMatchObject({ kind: 'validation' });
    await expect(readNotes('AM01_510037')).rejects.toMatchObject({ kind: 'validation' });
    await expect(readNotes('A_B_C_D_E')).rejects.toMatchObject({ kind: 'validation' });
  });

  it('accepts a template id without a base date (3 tokens)', async () => {
    await expect(readNotes('AM01_510037_全体版')).resolves.toEqual({});
  });
```

- `editor/server/test/templateRepo.filled.test.ts` の `'一覧は filled/ にあるテンプレだけを published として返す'`: 下で pending の行を足すので、`listTemplates({})` の結果を `status === 'published'` で絞ってから比べる:

```ts
    const ids = (await repo.listTemplates({}))
      .filter((m) => m.status === 'published')
      .map((m) => `${m.id}:${m.status}`);
```

追加するテスト:

`editor/server/test/pathGuards.test.ts`(`describe` の中、`'readDraft は無いファイルを空文字で返す'` の後):

```ts
  it('pending・下書きはテンプレート(3 つ区切り)の id も受け、置き場の中に書く', async () => {
    const id = 'AM01_510037_交付版';
    await pendingFiles.writePending(id, '<p>骨組み</p>', '');
    expect(await pendingFiles.readPending(id)).toEqual({ html: '<p>骨組み</p>', css: '' });
    expect(await pendingFiles.listPendingIds()).toContain(id);
    await draftFiles.writeDraft(id, '<p>下書き</p>', '');
    expect(await draftFiles.draftExists(id)).toBe(true);
    await draftFiles.deleteDraft(id);
    await pendingFiles.deletePending(id);
    expect(strayFiles()).toEqual([]);
  });
```

`editor/server/test/confirmedWrite.guard.test.ts` の `describe('applyConfirmedWrite — 迂回入力の拒否')`(`filledDir` の定数が無ければ `const filledDir = path.join(root, 'data', 'filled');` を足す):

```ts
  it('値入り HTML(target=filled)にテンプレートの id(3 つ区切り)は書けない', async () => {
    await expect(
      confirmedWrite.applyConfirmedWrite({
        kind: 'review-approve',
        target: 'filled',
        templateId: 'AM01_510037_交付版',
        fundCode: '510037',
        html: '<p>x</p>',
        css: '',
        author: 'approver1',
        commitMessage: 'm',
      }),
    ).rejects.toSatisfy(isAppError);
    expect(fs.existsSync(path.join(filledDir, 'AM01_510037_交付版.html'))).toBe(false);
    expect(fs.existsSync(path.join(cssDir, '510037.css'))).toBe(false);
  });
```

(このケースは Task 1 の時点の実装でも `assertTemplateFileName` で落ちるので RED にはならない。書込先ごとの形の強制を固定する回帰網として置く。対になる「target=template に 4 つ区切り」は Task 3 で足す。)

`editor/server/test/history.routes.test.ts` の `d('history routes still serve valid ids', ...)` に追加:

```ts
  it('テンプレート(3 つ区切り)の版の一覧は 200 で空(編集タブの一覧が pending の行の版数を問うため)', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/templates/${encodeURIComponent('AM01_999999_交付版')}/versions`,
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual([]);
  });
```

`editor/server/test/templateRepo.filled.test.ts`: 定数に `const SKELETON_ID = 'AM01_510124_交付版';` と `const SKELETON_PENDING_ID = 'AM01_510155_交付版';` を足し、`beforeAll` の最後(`repo = …` の前)に:

```ts
    fs.writeFileSync(path.join(tmp, 'templates', `${SKELETON_ID}.html`), '<p>{{ s }}</p>', 'utf8');
    const { writePending } = await import('../src/files/pendingFiles.js');
    await writePending(SKELETON_PENDING_ID, '<p>{{ 生成直後 }}</p>', '');
```

追加するケース:

```ts
  it('テンプレート(3 つ区切り)は templates/ を読み、基準日を持たない', async () => {
    const t = await repo.getTemplate(SKELETON_ID);
    expect(t.html).toBe('<p>{{ s }}</p>');
    expect(t.filled).toBe('');
    expect(t.meta.status).toBe('published');
    expect(t.meta.attributes).toEqual({ companyCode: 'AM01', fundCode: '510124', editionType: '交付版' });
  });

  it('pending/ にしか無いテンプレートは draft で返り、一覧にも基準日なしの draft で出る', async () => {
    const t = await repo.getTemplate(SKELETON_PENDING_ID);
    expect(t.meta.status).toBe('draft');
    const row = (await repo.listTemplates({})).find((m) => m.id === SKELETON_PENDING_ID);
    expect(row?.status).toBe('draft');
    expect(row?.attributes.baseDate).toBeUndefined();
  });

  it('基準日で絞った一覧と候補に、基準日を持たない行は混ざらない', async () => {
    const ids = (await repo.listTemplates({ baseDate: '20240710' })).map((m) => m.id);
    expect(ids).not.toContain(SKELETON_PENDING_ID);
    const opts = await repo.getDropdownOptions({}, 'edit');
    expect(opts.baseDates.every((d) => d !== '')).toBe(true);
  });
```

`editor/server/test/reviews.test.ts`(`"origin='create' の承認は pending を捨てる"` の後):

```ts
  it("origin='create' のテンプレート(3 つ区切り)の承認は templates/<id>.html に書き、pending を捨てる", {
    timeout: 60_000,
  }, async () => {
    const tplId = 'AM01_222333_交付版';
    const pendingFiles = await import('../src/files/pendingFiles.js');
    await pendingFiles.writePending(tplId, '<p>{{ fund.name }} 骨組み</p>', '.p{}');
    const meta = await submit(tplId, '222333', '<p>{{ fund.name }} 確定</p>', 'create');
    expect(meta.attributes).toEqual({ companyCode: 'AM01', fundCode: '222333', editionType: '交付版' });
    await reviews.approveReview(meta.id, {}, approver);
    expect(fs.readFileSync(path.join(tmp, 'templates', `${tplId}.html`), 'utf8')).toBe(
      '<p>{{ fund.name }} 確定</p>',
    );
    expect(fs.existsSync(path.join(tmp, 'pending', `${tplId}.html`))).toBe(false);
  });
```

`editor/server/test/templates.routes.test.ts`(最後の `sync-status` のケースの後):

```ts
  it('GET /templates/:id/sync-status: テンプレート(3 つ区切り)は 3 つ区切りのペアを返し、バナーの対象外', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/templates/${encodeURIComponent('AM01_510037_交付版')}/sync-status`,
      headers: as('editor'),
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ pairTemplateId: 'AM01_510037_全体版', pairExists: false, conflicts: [] });
  });
```

`editor/server/test/noteMasterService.test.ts`(`describe('reflectNoteMasterAfterConfirm', ...)` の中):

```ts
  it('テンプレート(3 つ区切り)の承認でも、id のファンド・版種で書き戻す', async () => {
    readTemplateHtmlMock.mockResolvedValue(doc(part('note-a', 'A')));
    listPartsMock.mockResolvedValue([catalogItem('note-a', '反映')]);
    const res = await reflectNoteMasterAfterConfirm('AM01_510037_全体版', 'approver1', 'template');
    expect(res).toEqual({ updated: ['note-a'], error: null });
    expect(paramMap(callSprocMock.mock.calls[0][2] ?? [])).toMatchObject({
      ファンドコード: '510037',
      版種: '全体版',
    });
  });
```

`editor/server/test/pairSyncService.test.ts`(新規):

```ts
// =============================================================================
// pairSyncService.test.ts — 承認後のペア同期はテンプレート側にも掛かり、状態ファイルは形ごとに別
// =============================================================================
// テンプレート(templates/。3 つ区切り)のペアのキーは `会社_ファンド`、値入り HTML(filled/。
// 4 つ区切り)は `会社_ファンド_基準日` で、状態ファイル `sync/<pairKey>.json` は自然に別になる。
// 1 つにまとめると、基準日の違う値入り HTML の同期状態とテンプレートの同期状態が混ざる。
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'editor-pair-sync-'));
process.env.DATA_ROOT = tmp;
process.env.GIT_REPO_DIR = tmp;
process.env.TEMPLATES_DIR = path.join(tmp, 'templates');
process.env.FILLED_DIR = path.join(tmp, 'filled');
process.env.SYNC_DIR = path.join(tmp, 'sync');
process.env.PENDING_DIR = path.join(tmp, 'pending');
process.env.CSS_DIR = path.join(tmp, 'css');
// 監査ログの DB 複写へ出ないようにする(`reviews.test.ts` と同じ)。
process.env.AUDIT_DB = 'false';

let gitAvailable = true;
try {
  execFileSync('git', ['--version'], { stdio: 'ignore' });
} catch {
  gitAvailable = false;
}
const d = gitAvailable ? describe : describe.skip;

const part = (id: string, text: string): string =>
  `<section data-part-id="${id}"><p>${text}</p></section>`;
const doc = (...parts: string[]): string =>
  `<html><body><div class="page">\n${parts.join('\n')}\n</div></body></html>`;
const put = (dir: string, id: string, html: string) => {
  fs.mkdirSync(path.join(tmp, dir), { recursive: true });
  fs.writeFileSync(path.join(tmp, dir, `${id}.html`), html, 'utf8');
};
const read = (dir: string, id: string) =>
  fs.readFileSync(path.join(tmp, dir, `${id}.html`), 'utf8');
const syncFile = (pairKey: string) => path.join(tmp, 'sync', `${pairKey}.json`);

d('pairSyncService', () => {
  let svc: import('../src/sync/pairSyncService.js').PairSyncService;
  const listParts = async () => [{ id: 'a', syncDefault: '同期' }];

  beforeAll(async () => {
    const { createPairSyncService } = await import('../src/sync/pairSyncService.js');
    // カタログは 1 パーツだけ。同期既定=同期 のパーツが転写の対象になる。
    const parts = { listParts: () => listParts(), getPartClassificationOptions: async () => ({}) };
    svc = createPairSyncService(parts as never);
  });
  afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }));

  it('テンプレートの承認後は templates/ のペアへ転写し、状態は sync/会社_ファンド.json', {
    timeout: 60_000,
  }, async () => {
    put('templates', 'AM01_510037_交付版', doc(part('a', '旧')));
    put('templates', 'AM01_510037_全体版', doc(part('a', '旧')));
    // 1 回目: 両版が一致しているので転写せず、前回同期の基準だけを作る。
    const first = await svc.syncPairAfterConfirm('AM01_510037_交付版', 'approver1', 'template');
    expect(first).toMatchObject({ pairTemplateId: 'AM01_510037_全体版', error: null });
    expect(fs.existsSync(syncFile('AM01_510037'))).toBe(true);
    // 2 回目: 交付版だけが変わったので全体版へ転写する。
    put('templates', 'AM01_510037_交付版', doc(part('a', '新')));
    const second = await svc.syncPairAfterConfirm('AM01_510037_交付版', 'approver1', 'template');
    expect(second?.error).toBeNull();
    expect(second?.applied).toHaveLength(1);
    expect(read('templates', 'AM01_510037_全体版')).toContain('新');
  });

  it('値入り HTML の状態は sync/会社_ファンド_基準日.json で、テンプレート側の状態を上書きしない', {
    timeout: 60_000,
  }, async () => {
    const before = fs.readFileSync(syncFile('AM01_510037'), 'utf8');
    put('filled', 'AM01_510037_20240710_交付版', doc(part('a', 'x')));
    put('filled', 'AM01_510037_20240710_全体版', doc(part('a', 'x')));
    await svc.syncPairAfterConfirm('AM01_510037_20240710_交付版', 'approver1', 'filled');
    expect(fs.existsSync(syncFile('AM01_510037_20240710'))).toBe(true);
    expect(fs.readFileSync(syncFile('AM01_510037'), 'utf8')).toBe(before);
  });

  it('ペアのテンプレートが無ければ null、版種がペアの対象外でも null', async () => {
    put('templates', 'AM01_510155_交付版', doc(part('a', 'x')));
    expect(await svc.syncPairAfterConfirm('AM01_510155_交付版', 'approver1', 'template')).toBeNull();
    expect(await svc.syncPairAfterConfirm('AM01_510155_kr', 'approver1', 'template')).toBeNull();
  });

  it('同期の途中で失敗しても throw せず、error 付きで返す(承認は成立させる)', async () => {
    put('templates', 'AM01_510003_交付版', doc(part('a', 'x')));
    put('templates', 'AM01_510003_全体版', doc(part('a', 'x')));
    const r = await (async () => {
      const { createPairSyncService } = await import('../src/sync/pairSyncService.js');
      const broken = {
        listParts: async () => {
          throw new Error('カタログを読めない');
        },
        getPartClassificationOptions: async () => ({}),
      };
      return createPairSyncService(broken as never).syncPairAfterConfirm(
        'AM01_510003_交付版',
        'approver1',
        'template',
      );
    })();
    expect(r).toMatchObject({ pairTemplateId: 'AM01_510003_全体版', applied: [], error: 'カタログを読めない' });
  });

  it('同期の現況はテンプレートでは値入り HTML のペアを見ない(バナーの対象外)', async () => {
    expect(await svc.getPairSyncStatus('AM01_510037_交付版')).toEqual({
      pairTemplateId: 'AM01_510037_全体版',
      pairExists: false,
      conflicts: [],
    });
    expect(await svc.getPairSyncStatus('規約外')).toEqual({
      pairTemplateId: null,
      pairExists: false,
      conflicts: [],
    });
  });
});
```

- [ ] **Step 2: 失敗を確かめる**

Run: `pnpm exec vitest run --project server editor/server/test/notesFile.test.ts editor/server/test/pathGuards.test.ts editor/server/test/templateRepo.filled.test.ts editor/server/test/reviews.test.ts editor/server/test/templates.routes.test.ts editor/server/test/noteMasterService.test.ts editor/server/test/pairSyncService.test.ts editor/server/test/history.routes.test.ts editor/server/test/confirmedWrite.guard.test.ts`
Expected: 追加したケースが FAIL(`不正なテンプレート id です: AM01_510037_交付版`、版の一覧の 400 など)。confirmedWrite.guard の新ケースは回帰網なので PASS のままでよい。

- [ ] **Step 3: 実装する**

`pendingFiles.ts`: import を `import { assertAnyTemplateId, isValidAnyTemplateId } from '@editor/shared';` にし、`assertTemplateId` → `assertAnyTemplateId`(2 か所)、`isValidTemplateId` → `isValidAnyTemplateId`(2 か所)。`htmlName` の上のコメントに「`pending/` はテンプレート(3 つ区切り)と値入り HTML(4 つ区切り)のどちらの id も受ける」を 1 行足す。

`draftFiles.ts`: 同じ置き換え(`assertTemplateId` 2 か所、`isValidTemplateId` 1 か所)とコメント 1 行。

`notesFile.ts`: import の `assertTemplateId` を `assertAnyTemplateId` にし、`fileFor` の doc と本体を:

```ts
/**
 * templateId を安全なファイル名に限定する(パストラバーサル防止)。メモはテンプレート(3 つ区切り)と
 * 値入り HTML(4 つ区切り)のどちらにも付く。
 *
 * 判定は shared の `assertAnyTemplateId` **1 本**に寄せる。ここで独自に
 * 「basename 一致 + `..` を含まない + トークン構造」と書き下すと、正典が持つ
 * 長さ上限(200 文字)のような制約を落とし、同じ id 規約に**2 つの実装**が並ぶ。
 * 正典が厳しくなってもこちらは追随しない、という形の乖離を構造的に作らない。
 */
function fileFor(templateId: string): string {
  return path.join(notesDir(), `${assertAnyTemplateId(templateId)}.json`);
}
```

`templateFiles.ts`: import に `assertSkeletonFileName`・`parseSkeletonFileName` を足し、`templatePath` を:

```ts
// templates/ はテンプレート(3 つ区切り)の置き場。生成が 4 つ区切りを作る間は 4 つ区切りも受ける。
const templateFileNameOf = (fileName: string): string =>
  parseSkeletonFileName(fileName) ? assertSkeletonFileName(fileName) : assertTemplateFileName(fileName);
export const templatePath = (fileName: string): string =>
  path.join(config.templatesDir, templateFileNameOf(fileName));
```

`templateMeta.ts`: `parseTemplateFileName` を `parseAnyTemplateFileName` に(import と 18 行)。doc に「テンプレート(3 つ区切り)のメタは基準日を持たない」を 1 文足す。

`confirmedWrite.ts`: import に `assertSkeletonFileName`・`parseAnyTemplateFileName`・`parseSkeletonFileName` を足し、`parseTemplateFileName` を消す。`// ── 1.` の節の先頭(`htmlPathOf` の前)に:

```ts
/**
 * 書込先ごとに受けるファイル名の形を強制する。値入り HTML(`filled`)は 4 つ区切りだけ。
 * テンプレート(`template`)は 3 つ区切りを受ける(生成が 4 つ区切りを作る間は 4 つ区切りも受ける)。
 */
function assertFileNameFor(target: ConfirmedTarget, fileName: string): string {
  if (target === 'filled') return assertTemplateFileName(fileName);
  return parseSkeletonFileName(fileName)
    ? assertSkeletonFileName(fileName)
    : assertTemplateFileName(fileName);
}
```

`applyConfirmedWrite` の先頭 2 行を:

```ts
  const fileName = assertFileNameFor(op.target, `${templateId}.html`);
  const attrs = parseAnyTemplateFileName(fileName);
```

ファイル先頭コメントの「1. 名前検査(`assertTemplateFileName`。`templatePath` に内蔵)」を「1. 名前検査(書込先ごとの形。`assertFileNameFor`、`templatePath` / `filledPath` にも内蔵)」にする。

`reviewRepo.ts`: import の `parseTemplateFileName`・`templateFileName` を `parseAnyTemplateFileName`・`anyTemplateFileName` にし、`currentBaseHash` を:

```ts
  const attrs = parseAnyTemplateFileName(`${templateId}.html`);
  const fileName = attrs ? anyTemplateFileName(attrs) : `${templateId}.html`;
```

`submitReview` の `parseTemplateFileName(`${req.templateId}.html`)` を `parseAnyTemplateFileName(...)` にする。

`historyRepo.ts`: import に `isValidSkeletonId` を足し、`listVersions` を:

```ts
/** テンプレ単位の版一覧(新しい順)。historyId はコミット hash。 */
export async function listVersions(templateId: string): Promise<TemplateVersionMeta[]> {
  // 版は値入り HTML(filled/)の git 履歴にしか無い。テンプレート(3 つ区切り)は版を持たないので
  // 空を返す(編集タブの一覧が pending の行の版数を問うたびに 400 にしない)。
  if (isValidSkeletonId(templateId)) return [];
  // `templateId` は URL 由来で pathspec の一部になる。ファイル名規約 + 単一セグメント安全性を
  // 通ってからでないと git へ渡さない(`..` や pathspec magic の混入を入口で断つ)。
  const commits = await logForFile(filledRel(assertTemplateId(templateId)));
  // (以降そのまま)
```

`pairSyncService.ts`: import の `parseTemplateFileName` を `parseAnyTemplateFileName` にし、3 か所(51・80・81 行)を置き換える。ファイル先頭コメントに「ペアのキーはテンプレート(3 つ区切り)が `会社_ファンド`、値入り HTML(4 つ区切り)が `会社_ファンド_基準日` で、状態ファイルは別になる」を 1 文足す。

`noteMasterService.ts`: import と 55 行の `parseTemplateFileName` を `parseAnyTemplateFileName` にする。

- [ ] **Step 4: 通ることを確かめる**

Run: Step 2 のコマンド → PASS。続けて `pnpm typecheck` → exit 0、`pnpm exec vitest run --project server` → 全件 PASS。

- [ ] **Step 5: pairSyncService のカバレッジを測って include を決める**

```bash
pnpm exec vitest run --project server --coverage --coverage.include=editor/server/src/sync/pairSyncService.ts --coverage.thresholds.lines=0 --coverage.thresholds.functions=0 --coverage.thresholds.branches=0 --coverage.thresholds.statements=0 editor/server/test/pairSyncService.test.ts
```

4 指標(lines / functions / branches / statements)がすべて 85% 以上なら、`vitest.config.ts` の include の `'editor/server/src/sync/noteMasterService.ts',` の次に `'editor/server/src/sync/pairSyncService.ts',` を足し、`git add` に含める。1 つでも 85% 未満なら include には足さず、コミットメッセージの本文に「pairSyncService.ts は <指標> が <値>% のためカバレッジの include に足していない」と書く(足りない分岐のためにテストを無理に増やさない)。

続けて `pnpm run test:coverage` → exit 0(Task 2 で変えたファイルのうち include にあるもの — `pendingFiles.ts`・`draftFiles.ts`・`notesFile.ts`・`templateFiles.ts`・`templateMeta.ts`・`confirmedWrite.ts`・`noteMasterService.ts` — がファイル単位で 85% を保つこと)。下回ったファイルがあれば、そのファイルの未到達の分岐を通すケースをこの Task のテストに足す。

- [ ] **Step 6: コミット**

```bash
pnpm exec biome check --write editor/server/src editor/server/test
git add editor/server/src/files/pendingFiles.ts editor/server/src/files/draftFiles.ts editor/server/src/files/notesFile.ts editor/server/src/files/templateFiles.ts editor/server/src/repositories/templateMeta.ts editor/server/src/repositories/confirmedWrite.ts editor/server/src/repositories/reviewRepo.ts editor/server/src/repositories/historyRepo.ts editor/server/src/sync/pairSyncService.ts editor/server/src/sync/noteMasterService.ts editor/server/test/pairSyncService.test.ts editor/server/test/notesFile.test.ts editor/server/test/pathGuards.test.ts editor/server/test/templateRepo.filled.test.ts editor/server/test/reviews.test.ts editor/server/test/templates.routes.test.ts editor/server/test/noteMasterService.test.ts editor/server/test/confirmedWrite.guard.test.ts editor/server/test/history.routes.test.ts
# Step 5 で include に足したときだけ: git add vitest.config.ts
git commit -m "feat(server): pending・下書き・メモ・申請・版の一覧・ペア同期がテンプレート(3 つ区切り)の id も受けるようにする"
```

---

### Task 3: 生成とテンプレートフォルダを 3 つ区切りへ切り替える

生成が `会社_ファンド_版種` を作り、`templates/` は 3 つ区切りだけを受ける。作成済み・申請中・作成中の 409、生成器の成功後の破棄、偽の生成器、ファンド画像の解決、e2e を同じコミットで切り替える。web の作成タブはこの段では `replaceExisting` を送らないので、作業中のテンプレートの作り直しは 409 のトーストになる(確認ダイアログは Task 4)。

**Files:**
- Modify: `editor/shared/src/schemas.ts:681-697`(`SeriesFundOption.hasTemplate` の説明、`CreatableInfo`)、`schemas.ts:707-722`(`GenerateRequest.replaceExisting`)
- Modify: `editor/server/src/files/templateFiles.ts`(先頭コメント、`templatePath`、`templateAttrKeys`、`findTemplateId` を追加)
- Modify: `editor/server/src/files/reviewFiles.ts`(`hasPendingCreateReview` を追加)
- Modify: `editor/server/src/routes/generate.routes.ts`(全体)
- Modify: `editor/server/src/generate/pyTemplate.ts:17-28,117-127`
- Modify: `editor/server/scripts/fake_generate_template.py`
- Modify: `editor/server/src/repositories/templateRepo.ts`(`getTemplate`・`getCreatableInfo`)
- Modify: `editor/server/src/repositories/confirmedWrite.ts`(`assertFileNameFor`・`baselineTemplateHtml`)
- Modify: `editor/server/src/repositories/reviewRepo.ts`(`submitReview` の形の検査)
- Modify: `editor/web/src/features/editor/fundImages.ts:17,43-45`
- Modify: `editor/server/scripts/e2e-rest-seed.ts`
- Modify: `editor/e2e/create.spec.ts`
- Modify(テスト): `editor/server/test/generate.routes.test.ts`、`pyTemplate.test.ts`、`fakeGenerator.test.ts`、`templateRepo.creatable.test.ts`、`templateRepo.filled.test.ts`、`templates.routes.test.ts`、`reviews.test.ts`、`confirmedWrite.guard.test.ts`、`confirmedWrite.rollback.test.ts`、`pathGuards.test.ts`、`ioFailurePolicy.test.ts`、`editor/web/test/fundImages.test.ts`
- Regenerate: `editor/server/openapi/openapi.json`

**Interfaces:**
- Consumes: Task 1・2 の関数、`deleteDraft(templateId)` / `draftExists(templateId)`(`draftFiles.ts`)、`deletePending(templateId)` / `pendingExists(templateId)`(`pendingFiles.ts`)、`listReviewMetas()`(`reviewFiles.ts`)
- Produces:
  - `CreatableInfo.templateId?: string`(作成済みのときだけ。ファイルの綴りのまま)、`CreatableInfo.inProgressId?: string`(作成済みでなく、同じ id の下書きか pending があるときだけ)
  - `GenerateRequest.replaceExisting?: boolean`
  - `findTemplateId(fileNames: string[], companyCode: string, fundCode: string, editionType: string): string | null`(`files/templateFiles.ts`)
  - `hasPendingCreateReview(templateId: string): Promise<boolean>`(`files/reviewFiles.ts`)
  - `GenerateAttributes` から `baseDate` を外す
  - 生成の 409 の文言: `作成済みです。既存のテンプレートを開いてください` / `申請中です。承認か却下を待ってください` / `作成中のテンプレートがあります`

- [ ] **Step 1: 壊れる既存テストを書き換え、新しいテストを書く(RED)**

この Task で壊れる既存テストと書き換え方:

| ファイル | 壊れる理由 | 書き換え |
|---|---|---|
| `generate.routes.test.ts` | 生成の ID が `AM01_510037_<当日>_交付版` でなくなる。作業中の作り直しが 409 になる | 下の全面書き換え |
| `pyTemplate.test.ts` | `baseDate` を渡さなくなる | `attrs` から `baseDate: '20261001'` を消し、`'属性 JSON は明示したキーだけで組み…'` と `'sourceFundCode と isRedemption は…'` の期待値から `baseDate: '20261001',` を消す |
| `fakeGenerator.test.ts` | コピー元が 3 つ区切りになる | 下の書き換え |
| `templateRepo.creatable.test.ts` | `templates/` の 4 つ区切りを数えなくなる | 下の書き換え |
| `templateRepo.filled.test.ts` | 4 つ区切りの id で `templates/` を読まなくなる | 下の書き換え |
| `templates.routes.test.ts` | 作成済みの確認で 4 つ区切りを `templates/` に置いている | 下の書き換え |
| `reviews.test.ts` | origin=create の申請が 4 つ区切り | `"filled 不在でも origin='create'…"` の `AM01_212121_20250101_交付版` を `AM01_212121_交付版`、`"origin='create' の承認は templates/ に書き…"` の `AM01_171717_20250101_交付版` を `AM01_171717_交付版`、`"origin='create' の承認は pending を捨てる"` の `AM01_191919_20250101_交付版` を `AM01_191919_交付版` にする |
| `confirmedWrite.guard.test.ts` | target=template に 4 つ区切り | 42〜44 行の定数を `SOURCE = 'AM01_510037_交付版'`・`PAIR = 'AM01_510037_全体版'`・`OTHER = 'AM01_999999_全体版'` にする(本文はそのまま) |
| `confirmedWrite.rollback.test.ts` | 同じ id を両方の書込先で使っている | 下の書き換え |
| `pathGuards.test.ts`(server) | `'applyConfirmedWrite accepts a valid pair…'` と `'…rejects a traversal fund code'` が target=template に 4 つ区切り | 33 行の後に `const VALID_SKELETON_ID = 'AM01_510037_交付版';` を足し、その 2 ケースの `templateId: VALID_ID` と `${VALID_ID}.html` を `VALID_SKELETON_ID` にする |
| `ioFailurePolicy.test.ts` | `readTemplateHtml` の 4 つ区切りは解決しなくなる(EISDIR のケースが `''` になる) | `describe('templateFiles.readTemplateHtml')` の `'AM01_777777_20250101_交付版.html'` を `'AM01_777777_交付版.html'`、`'AM01_888888_20250101_交付版'` を `'AM01_888888_交付版'` にする |

`generate.routes.test.ts` の書き換え(ファイル冒頭のコメントと setup はそのまま。`process.env.LOG_DIR` の後に次の 3 行を足す):

```ts
process.env.DRAFTS_DIR = path.join(root, 'data', 'drafts');
process.env.REVIEWS_DIR = path.join(root, 'data', 'reviews');
```

定数に `draftsDir`・`reviewsDir` と `const notesDir = path.join(root, 'data', 'notes');`(メモの置き場は env を持たず `<DATA_ROOT>/notes` 固定。`files/notesFile.ts` の `notesDir`)を足し、`beforeEach` の空にするディレクトリ一覧に 3 つを足す。`ymd` と `ID` を消して次に替える:

```ts
  // テンプレートは基準日を持たない。生成の ID は会社_ファンド_版種で、日付に依らず決まる。
  const ID = 'AM01_510037_交付版';
  const FILLED_ID = 'AM01_510037_20240710_交付版';
  const ATTRS = { companyCode: 'AM01', fundCode: '510037', editionType: '交付版' };

  /** 承認待ち(または決着済み)の申請を 1 件置く。id は reviewFiles の REQ_ID_PATTERN に合う形。 */
  async function putReview(
    id: string,
    origin: 'create' | 'edit',
    status: 'pending' | 'approved' | 'rejected',
  ) {
    const { writeReview } = await import('../src/files/reviewFiles.js');
    await writeReview({
      id,
      templateId: ID,
      attributes: ATTRS,
      fundCode: '510037',
      origin,
      status,
      submittedBy: 'editor1',
      submittedAt: new Date().toISOString(),
      reviewedBy: null,
      reviewedAt: null,
      comment: null,
      baseHash: null,
      html: '<p>申請</p>',
      css: '',
    });
  }
```

既存ケースの扱い:
- そのまま通るもの: `'生成しても templatesDir には 1 ファイルも作られない'`・`'生成物は pending へ置かれ、GET /templates/:id が status=draft で返す'`・`'pending は確定を覆い隠さない(確定優先が契約)'`・`'生成で sproc の テンプレート を呼ばない'`・トラバーサル・空白・アンダースコア・`'規約外の sourceFundCode は 400'`・`'isRedemption が false なら…'`。
- `'同一属性の確定テンプレがあれば 409 で、そのバイト列は変わらない'`: 名前を `'作成済み(templates/ にある)なら 409「作成済み」で、そのバイト列は変わらない'` にし、`expect(res.json().message).toBe('作成済みです。既存のテンプレートを開いてください');` を足す。
- `'確定済みは一覧に published で出て、pending が二重行を作らない'`: 値入り HTML とテンプレートで ID の形が違うので、値入り HTML の id で確かめる形に替える:

```ts
  it('値入り HTML と同じ id の pending が残っていても、一覧は published の 1 行だけ', async () => {
    fs.writeFileSync(path.join(filledDir, `${FILLED_ID}.html`), '<p>確定版(値入り)</p>', 'utf8');
    fs.writeFileSync(path.join(pendingDir, `${FILLED_ID}.html`), '<p>消し残り</p>', 'utf8');
    const list = await app.inject({ method: 'GET', url: '/templates?fundCode=510037' });
    const rows = list.json() as { id: string; status: string }[];
    expect(rows.filter((r) => r.id === FILLED_ID)).toHaveLength(1);
    expect(rows.find((r) => r.id === FILLED_ID)?.status).toBe('published');
  });
```

- `'pending がある属性の再生成は通り、pending を上書きする(復旧手段を塞がない)'`: 作業中の作り直しは同意が要るので、2 回目に `replaceExisting: true` を付ける。名前を `'作り直しの同意(replaceExisting)があれば、pending のある属性も作り直せる(復旧手段を塞がない)'` にし、`const res = await generate(validBody);` を `const res = await generate({ ...validBody, replaceExisting: true });` にする。
- `'生成器へは検証済みの属性とサーバの基準日だけを渡す…'`: 名前を `'生成器へは検証済みの属性だけを渡し、基準日は渡さない(本文の他のキーや廃止した basedOnTemplateId も渡らない)'` にし、期待値を `{ companyCode: 'AM01', fundCode: '510037', editionType: '交付版' }` にする(`replaceExisting: true` を本文に足して、それも生成器へ渡らないことを確かめる)。
- `'コピー元があれば sourceFundCode と isRedemption を…'`: コピー元のファイル名を `'AM01_510037_交付版.html'` にし、最後に `expect(JSON.parse(lines[lines.length - 1]).attributes).toEqual({ companyCode: 'AM01', fundCode: '510155', editionType: '交付版' });` を足す。

追加するケース:

```ts
  it('生成の ID は会社_ファンド_版種で、応答の属性は基準日を持たない', async () => {
    const res = await generate(validBody);
    expect(res.json().template.meta.id).toBe(ID);
    expect(res.json().template.meta.attributes).toEqual(ATTRS);
  });

  it('会社コードの大文字小文字だけが違うテンプレートがあっても 409「作成済み」', async () => {
    fs.writeFileSync(path.join(templatesDir, 'am01_510037_交付版.html'), '<p>既存</p>', 'utf8');
    generateMock.mockClear();
    const res = await generate(validBody);
    expect(res.statusCode).toBe(409);
    expect(generateMock).not.toHaveBeenCalled();
  });

  it('templates/ に旧形式(4 つ区切り)のファイルしか無ければ作成済みにしない', async () => {
    fs.writeFileSync(path.join(templatesDir, `${FILLED_ID}.html`), '<p>旧形式</p>', 'utf8');
    const res = await generate(validBody);
    expect(res.statusCode).toBe(200);
  });

  it('同じ id の承認待ちの作成申請があれば、同意があっても生成器を呼ばずに 409「申請中」', async () => {
    await putReview('11111111-1111-4111-8111-111111111111', 'create', 'pending');
    fs.writeFileSync(path.join(pendingDir, `${ID}.html`), '<p>申請した生成物</p>', 'utf8');
    generateMock.mockClear();
    const res = await generate({ ...validBody, replaceExisting: true });
    expect(res.statusCode).toBe(409);
    expect(res.json().message).toBe('申請中です。承認か却下を待ってください');
    expect(generateMock).not.toHaveBeenCalled();
    expect(fs.existsSync(path.join(pendingDir, `${ID}.html`))).toBe(true);
  });

  it('決着済み(承認・却下)や編集タブの申請は作り直しを止めない', async () => {
    await putReview('22222222-2222-4222-8222-222222222222', 'create', 'rejected');
    await putReview('33333333-3333-4333-8333-333333333333', 'edit', 'pending');
    const res = await generate(validBody);
    expect(res.statusCode).toBe(200);
  });

  it.each([
    ['下書き', () => fs.writeFileSync(path.join(draftsDir, `${ID}.html`), '<p>下書き</p>', 'utf8')],
    ['pending', () => fs.writeFileSync(path.join(pendingDir, `${ID}.html`), '<p>生成物</p>', 'utf8')],
  ])('作業中(%s)があり同意が無ければ、生成器を呼ばずに 409「作成中」', async (_label, seed) => {
    seed();
    generateMock.mockClear();
    const res = await generate(validBody);
    expect(res.statusCode).toBe(409);
    expect(res.json().message).toBe('作成中のテンプレートがあります');
    expect(generateMock).not.toHaveBeenCalled();
  });

  it('同意して作り直すと、下書きを捨てて pending を新しい生成物にし、コメントとパーツ変更履歴は残す', async () => {
    fs.writeFileSync(path.join(draftsDir, `${ID}.html`), '<p>古い下書き</p>', 'utf8');
    fs.writeFileSync(path.join(draftsDir, `${ID}.css`), '.old{}', 'utf8');
    fs.writeFileSync(path.join(pendingDir, `${ID}.html`), '<p>古い生成物</p>', 'utf8');
    fs.mkdirSync(notesDir, { recursive: true });
    fs.writeFileSync(path.join(notesDir, `${ID}.json`), '{}', 'utf8');
    const history = await import('../src/repositories/historyRepo.js');
    await history.recordPartChange(ID, 'p1/a', '本文を変更', 'editor1');
    const res = await generate({ ...validBody, replaceExisting: true });
    expect(res.statusCode).toBe(200);
    expect(fs.existsSync(path.join(draftsDir, `${ID}.html`))).toBe(false);
    expect(fs.existsSync(path.join(draftsDir, `${ID}.css`))).toBe(false);
    expect(fs.readFileSync(path.join(pendingDir, `${ID}.html`), 'utf8')).toContain('生成物');
    expect(fs.existsSync(path.join(notesDir, `${ID}.json`))).toBe(true);
    expect(await history.listPartHistory(ID)).toHaveLength(1);
  });

  it('生成器が失敗したら、同意していても下書きも pending も消さない', async () => {
    fs.writeFileSync(path.join(draftsDir, `${ID}.html`), '<p>守る下書き</p>', 'utf8');
    fs.writeFileSync(path.join(pendingDir, `${ID}.html`), '<p>守る生成物</p>', 'utf8');
    generateMock.mockRejectedValueOnce(new Error('生成器が落ちた'));
    const res = await generate({ ...validBody, replaceExisting: true });
    expect(res.statusCode).toBeGreaterThanOrEqual(500);
    expect(fs.readFileSync(path.join(draftsDir, `${ID}.html`), 'utf8')).toBe('<p>守る下書き</p>');
    expect(fs.readFileSync(path.join(pendingDir, `${ID}.html`), 'utf8')).toBe('<p>守る生成物</p>');
  });

  it('コピー元が旧形式(4 つ区切り)しか無ければ 400', async () => {
    fs.writeFileSync(path.join(templatesDir, 'AM01_510037_20240710_交付版.html'), '<p>旧</p>', 'utf8');
    const res = await generate({ ...validBody, fundCode: '510155', sourceFundCode: '510037' });
    expect(res.statusCode).toBe(400);
  });
```

(`recordPartChange` / `listPartHistory` の引数の形は `historyRepo.ts` に合わせる。パーツ変更履歴は `<LOG_DIR>/history/` の追記ファイルで、生成ルートは触らない。)

`fakeGenerator.test.ts`: `ATTRS` から `baseDate` を消す。`'sourceFundCode はコピー元ファンドの基準日が最新のテンプレートを写す…'` を次に替え、旧形式のケースを足す:

```ts
  it('sourceFundCode は templates/ の 会社_コピー元_版種.html を写す(会社コードの大小を問わず、旧形式は見ない)', async () => {
    const templates = path.join(tmp, 'templates-source');
    fs.mkdirSync(templates, { recursive: true });
    fs.writeFileSync(path.join(templates, 'am01_510037_交付版.html'), '<p>src</p>', 'utf8');
    fs.writeFileSync(path.join(templates, 'AM01_510037_20250101_交付版.html'), '<p>旧形式</p>', 'utf8');
    fs.writeFileSync(path.join(templates, 'AM01_510037_全体版.html'), '<p>版種違い</p>', 'utf8');
    const r = await run(
      { ...ATTRS, fundCode: '510155', sourceFundCode: '510037' },
      { TEMPLATES_DIR: templates },
    );
    expect(r.code).toBe(0);
    expect(r.stdout).toBe('<p>src</p>');
  }, 30_000);

  it('コピー元が旧形式(4 つ区切り)しか無ければエラー', async () => {
    const templates = path.join(tmp, 'templates-legacy');
    fs.mkdirSync(templates, { recursive: true });
    fs.writeFileSync(path.join(templates, 'AM01_510037_20250101_交付版.html'), '<p>旧形式</p>', 'utf8');
    const r = await run({ ...ATTRS, sourceFundCode: '510037' }, { TEMPLATES_DIR: templates });
    expect(r.code).toBe(2);
  }, 30_000);
```

`templateRepo.creatable.test.ts` の `beforeAll` の置き方を次にする:

```ts
    put('filled', 'am01_110024_20250101_交付版'); // filled/ にしか無い
    put('templates', 'am01_510037_交付版'); // 小文字の会社コード
    put('templates', 'AM01_510003_全体版');
    put('templates', 'AM01_510155_20240710_交付版'); // 旧形式(4 つ区切り)は数えない
    const { writePending } = await import('../src/files/pendingFiles.js');
    await writePending('AM01_510124_交付版', '<p>未確定</p>', '');
    const { writeDraft } = await import('../src/files/draftFiles.js');
    await writeDraft('AM01_510003_交付版', '<p>下書きだけ</p>', '');
    await writeDraft('am01_510037_交付版', '<p>既存を直している下書き</p>', '');
```

(`DRAFTS_DIR` はこのファイルの冒頭で既に tmp 配下を指している。)

ケースの書き換え:
- `'hasTemplateFor は…'`: 期待値はそのまま、`expect(await hasTemplateFor('AM01', '510155', '交付版')).toBe(false); // 旧形式だけ` を足す。
- `'作成済みは templates/ にあるときだけ立つ…'`: 名前を `'作成済みは templates/ に 3 つ区切りがあるときだけ立つ(filled/・pending/・旧形式は見ない)'` にし、`expect(await created('510155')).toBe(false);` のコメントを `// 旧形式だけ` にする(期待値は今のまま)。
- `'作成済みの照合は会社コードの大文字小文字を区別しない'` を次に替える:

```ts
  it('作成済みは大文字小文字を区別せずに照合し、templateId はファイルの綴りのまま返す', async () => {
    expect(await repo.getCreatableInfo(q('510037'))).toMatchObject({
      created: true,
      templateId: 'am01_510037_交付版',
    });
    expect(await repo.getCreatableInfo(q('510003'))).not.toHaveProperty('templateId');
  });

  it('作業中(同じ id の pending か下書き)なら inProgressId を返す。作成済みなら返さない', async () => {
    expect(await repo.getCreatableInfo(q('510124'))).toMatchObject({
      created: false,
      inProgressId: 'AM01_510124_交付版', // pending
    });
    expect(await repo.getCreatableInfo(q('510003'))).toMatchObject({
      inProgressId: 'AM01_510003_交付版', // 下書きだけ
    });
    expect(await repo.getCreatableInfo(q('510037'))).not.toHaveProperty('inProgressId');
    expect(await repo.getCreatableInfo(q('110024'))).not.toHaveProperty('inProgressId');
  });
```

- 他のケースはそのまま(`'シリーズ一覧に行が無い…'` の `toEqual({ created: false, seriesFunds: [] })` は、`templateId`・`inProgressId` を付けない実装で通る)。

`templateRepo.filled.test.ts`: `JINJA_ONLY_ID` を `'AM01_510037_全体版'` にする。`'templates/ にしか無い id は一覧に出ないが取得はできる(filled は空)'` はそのまま通る。追加:

```ts
  it('4 つ区切りの id は templates/ を読まない(旧形式のファイルがあっても filled/ → pending/ だけ)', async () => {
    fs.writeFileSync(path.join(tmp, 'templates', 'AM01_510003_20240710_交付版.html'), '<p>旧形式</p>', 'utf8');
    await expect(repo.getTemplate('AM01_510003_20240710_交付版')).rejects.toMatchObject({
      kind: 'not_found',
    });
  });
```

`templates.routes.test.ts` の `'GET /templates/creatable: 4 つのどれかが欠けたら 400、そろえば作成済みを返す'` の後半(`before` の確認の後)を次にする:

```ts
    // 作成済みは templates/ に 3 つ区切りがあるときだけ。旧形式(4 つ区切り)は数えない。
    fs.writeFileSync(
      path.join(root, 'data', 'templates', 'AM01_510037_20200101_交付版.html'),
      '<p>{{ a }}</p>',
      'utf8',
    );
    const legacy = await app.inject({ method: 'GET', url: `/templates/creatable?${base}`, headers: as('editor') });
    expect(legacy.json()).toMatchObject({ created: false });
    fs.writeFileSync(path.join(root, 'data', 'templates', 'AM01_510037_交付版.html'), '<p>{{ a }}</p>', 'utf8');
    const res = await app.inject({ method: 'GET', url: `/templates/creatable?${base}`, headers: as('editor') });
    expect(res.json()).toMatchObject({ created: true, templateId: 'AM01_510037_交付版' });
```

`reviews.test.ts` に追加(`"filled 不在でも origin='create' の申請は通る"` の後):

```ts
  it('作成タブの申請(origin=create)は値入り HTML の id(4 つ区切り)を 400 で拒む', async () => {
    await expect(
      submit('AM01_232323_20250101_交付版', '232323', '<p>{{ x }}</p>', 'create'),
    ).rejects.toMatchObject({ kind: 'validation' });
  });

  it('編集タブの申請(origin=edit)はテンプレートの id(3 つ区切り)を 400 で拒む', async () => {
    await expect(
      reviews.submitReview(
        { templateId: 'AM01_242424_交付版', html: '<p>x</p>', css: '', fundCode: '242424', origin: 'edit' },
        submitter,
      ),
    ).rejects.toMatchObject({ kind: 'validation' });
  });
```

`confirmedWrite.rollback.test.ts`: 39 行を次にし、`approve` が書込先で id を選ぶようにする:

```ts
const SKELETON_ID = 'AM01_510037_交付版';
const FILLED_ID = 'AM01_510037_20240710_交付版';
```

```ts
const approve = (target: 'filled' | 'template' = 'template') =>
  confirmedWrite.applyConfirmedWrite({
    kind: 'review-approve',
    target,
    templateId: target === 'filled' ? FILLED_ID : SKELETON_ID,
    fundCode: FUND,
    html: '<p>新しい本文</p>',
    css: 'body{color:#000}',
    author: 'approver1',
    commitMessage: 'm',
  });
```

本文の `TEMPLATE_ID` は、templatesDir を見る箇所(1・2 つ目のケース)を `SKELETON_ID`、filledDir を見る箇所(3 つ目のケース)を `FILLED_ID` にし、3 つ目の最後の templatesDir の確認は `SKELETON_ID` にする。4 つ目のケースの `PAIR` を `'AM01_510037_全体版'`、`sourceTemplateId: TEMPLATE_ID` を `SKELETON_ID` にする。

`confirmedWrite.guard.test.ts` の `describe('applyConfirmedWrite — 迂回入力の拒否')` に、Task 2 で足した target=filled のケースと対になるケースを追加:

```ts
  it('テンプレート(target=template)に値入り HTML の id(4 つ区切り)は書けない', async () => {
    await expect(
      confirmedWrite.applyConfirmedWrite({
        kind: 'review-approve',
        target: 'template',
        templateId: 'AM01_510037_20240710_交付版',
        fundCode: '510037',
        html: '<p>x</p>',
        css: '',
        author: 'approver1',
        commitMessage: 'm',
      }),
    ).rejects.toSatisfy(isAppError);
    expect(fs.readdirSync(templatesDir)).toEqual([]);
  });
```

`editor/web/test/fundImages.test.ts` に追加(`fundCodeOfTemplateId` を import する):

```ts
  it('fundCodeOfTemplateId はテンプレート(3 つ区切り)の id からもファンドコードを取る', () => {
    expect(fundCodeOfTemplateId('AM01_510037_交付版')).toBe('510037');
    expect(fundCodeOfTemplateId('AM01_510037_20240710_交付版')).toBe('510037');
    expect(fundCodeOfTemplateId('規約外')).toBeNull();
  });
```

`create.spec.ts`(e2e)の書き換え: 先頭コメントの「生成される id は実行日の基準日を含み事前に分からないため、`openEditor` へは委ねずボタン押下後の遷移先で直接 canvas を待つ。」を「生成器のスケルトンは `.page` を持たないので、`openEditor` へは委ねず遷移先で直接 canvas を待つ。」にする。33〜34 行(作成済みの注意を期待する 2 行)を次にする:

```ts
  // 作成済みの判定は templates/ の 3 つ区切りのファイルだけ。e2e の seed は templates/ を空で始めるので注意は出ない。
  await expect(page.getByText('テンプレートは作成済みです')).toHaveCount(0);
```

38〜39 行を:

```ts
  const url = new URL(page.url());
  expect(decodeURIComponent(url.pathname)).toBe('/edit/AM01_510037_交付版');
```

Run: `pnpm exec vitest run --project server editor/server/test/generate.routes.test.ts editor/server/test/pyTemplate.test.ts editor/server/test/fakeGenerator.test.ts editor/server/test/templateRepo.creatable.test.ts editor/server/test/templateRepo.filled.test.ts editor/server/test/templates.routes.test.ts editor/server/test/reviews.test.ts editor/server/test/confirmedWrite.guard.test.ts editor/server/test/confirmedWrite.rollback.test.ts editor/server/test/pathGuards.test.ts editor/server/test/ioFailurePolicy.test.ts` と `pnpm exec vitest run --project "web-*" editor/web/test/fundImages.test.ts`
Expected: 生成・作成済み・作成中・形の検査・偽の生成器・ファンド画像のケースが FAIL。

- [ ] **Step 2: shared の契約を直す**

`schemas.ts`:

```ts
export const SeriesFundOption = FundOption.extend({
  hasTemplate: z.boolean().meta({
    description:
      'コピー元のテンプレート(templates/<会社>_<ファンド>_<版種>.html。基準日なし)があるか',
  }),
}).meta({ id: 'SeriesFundOption' });

export const CreatableInfo = z
  .object({
    created: z.boolean().meta({
      description:
        '選んだ会社・ファンド・版種のテンプレートが templates/ にあるか(会社_ファンド_版種.html。大文字小文字は区別しない)',
    }),
    templateId: z.string().optional().meta({
      description:
        '作成済みのときのテンプレートの id(templates/ のファイルの綴りのまま)。作成タブの「既存のテンプレートを開く」で開く',
    }),
    inProgressId: z.string().optional().meta({
      description:
        '作成済みでなく、同じ id の下書きか pending/ があるときの id。作成タブの「作成中のテンプレートを開く」で開く。' +
        '作り直すときは確認のうえ GenerateRequest.replaceExisting を付ける',
    }),
    seriesFunds: z
      .array(SeriesFundOption)
      .meta({ description: '同じシリーズの他のファンド(シリーズから作成のコピー元候補)' }),
  })
  .meta({ id: 'CreatableInfo' });
```

`GenerateRequest` に足す:

```ts
    replaceExisting: z.boolean().optional().meta({
      description:
        '同じ id の下書き・pending/ を捨てて作り直すことへの同意。無いまま作業中のものがあれば 409',
    }),
```

- [ ] **Step 3: ファイル層を 3 つ区切りへ絞る**

`templateFiles.ts`: 先頭コメントの「キーはファイル名規約 / `fundCode`(ファイルレイアウトの不変規約)。」を「`templates/` はテンプレート(3 つ区切り `会社_ファンド_版種.html`)、`filled/` は値入り HTML(4 つ区切り `会社_ファンド_基準日_版種.html`)だけを受け、形はパス解決の関数が強制する。CSS のキーは `fundCode`。」にする。import は `assertFundCode, assertSkeletonFileName, assertTemplateFileName, isValidSkeletonId, parseSkeletonFileName, templateIdFromFileName`。Task 2 の `templateFileNameOf` と上のコメントを消して:

```ts
export const templatePath = (fileName: string): string =>
  path.join(config.templatesDir, assertSkeletonFileName(fileName));
```

`templateAttrKeys` と `findTemplateId`:

```ts
/**
 * templates/ のファイル名一覧から、会社・ファンド・版種のキー集合を作る。テンプレートは 3 つ区切りで、
 * 4 つ区切りの名前と規約外の名前は数えない。
 */
export function templateAttrKeys(fileNames: string[]): Set<string> {
  const keys = new Set<string>();
  for (const f of fileNames) {
    const a = parseSkeletonFileName(f);
    if (a) keys.add(attrKey(a.companyCode, a.fundCode, a.editionType));
  }
  return keys;
}

/**
 * templates/ のファイル名一覧から、会社・ファンド・版種が一致するテンプレートの id を返す(無ければ null)。
 * 照合は大文字小文字を区別しない。返す id はファイルの綴りのままで、そのまま開ける。
 */
export function findTemplateId(
  fileNames: string[],
  companyCode: string,
  fundCode: string,
  editionType: string,
): string | null {
  const want = attrKey(companyCode, fundCode, editionType);
  for (const f of fileNames) {
    const a = parseSkeletonFileName(f);
    const id = templateIdFromFileName(f);
    if (a && isValidSkeletonId(id) && attrKey(a.companyCode, a.fundCode, a.editionType) === want) {
      return id;
    }
  }
  return null;
}
```

`hasTemplateFor` のコメントを「templates/ に同じ会社・ファンド・版種のテンプレート(3 つ区切り)があるか(シリーズから作成のコピー元判定)。」にする。

`reviewFiles.ts`(`countPendingReviews` の後):

```ts
/**
 * 同じ id の承認待ちの作成申請(origin=create)があるか。あるうちに作り直すと、承認でその申請の
 * 内容が templates/ に入り、作り直した生成物と食い違う。照合は大文字小文字を区別しない。
 */
export async function hasPendingCreateReview(templateId: string): Promise<boolean> {
  const want = templateId.toLowerCase();
  return (await listReviewMetas()).some(
    (m) => m.status === 'pending' && m.origin === 'create' && m.templateId.toLowerCase() === want,
  );
}
```

- [ ] **Step 4: 生成器の約束と偽の生成器を直す**

`pyTemplate.ts`: `GenerateAttributes` から `baseDate` とそのコメントを消し、interface の doc を「生成器へ渡す属性。ルート(`generate.routes.ts`)で検証した値だけ。テンプレートは基準日を持たないので基準日は渡さない。」にする。`toGeneratorPayload` から `baseDate: attrs.baseDate,` を消す。

`fake_generate_template.py` の docstring:

```python
"""テスト・local 検証用の偽の生成器。本番は PY_GENERATE_SCRIPT で既存の生成器を指す。

入出力の約束(呼び出し元は editor/server/src/generate/pyTemplate.ts):
- argv[1] は JSON: {companyCode, fundCode, editionType, sourceFundCode?, isRedemption?}
  (テンプレートは基準日を持たないので baseDate は来ない)
- 生成した Jinja2 テンプレート HTML を stdout へ出す。

sourceFundCode があれば、環境変数 TEMPLATES_DIR(サーバが config.templatesDir を渡す)にある
コピー元のテンプレート <会社コード>_<sourceFundCode>_<版種>.html を返す(会社コードの大文字小文字は
区別しない。基準日の入った 4 つ区切りの名前は見ない)。TEMPLATES_DIR が無ければエラーにする。
isRedemption は受け取るだけ。
"""
```

`if source_fund:` の中の検索(「会社・版種は作成先と同じ。基準日…」のコメントから `best[1]` を開くところまで)を:

```python
        # 会社・版種は作成先と同じ。テンプレートは 会社_ファンド_版種.html の 3 つ区切りだけを見る。
        for name in sorted(os.listdir(templates_dir)):
            if not name.lower().endswith(".html"):
                continue
            parts = name[: -len(".html")].split("_")
            if len(parts) != 3:
                continue
            c, f, e = parts
            if c.lower() == company.lower() and f == source_fund and e == edition:
                with open(os.path.join(templates_dir, name), encoding="utf-8") as fh:
                    sys.stdout.write(fh.read())
                return 0
        print(f"source template not found: {source_fund}", file=sys.stderr)
        return 2
```

- [ ] **Step 5: 生成ルートを切り替える**

`generate.routes.ts` の import を:

```ts
import {
  apiPaths,
  assertTemplateAttributeToken,
  conflict,
  type SkeletonAttributes,
  skeletonFileName,
  type TemplateMeta,
  templateIdFromFileName,
  validation,
} from '@editor/shared';
import type { FastifyPluginAsync } from 'fastify';
import type { z } from 'zod';
import { config } from '../config.js';
import type { Deps } from '../deps.js';
import { deleteDraft, draftExists } from '../files/draftFiles.js';
import { deletePending, pendingExists, writePending } from '../files/pendingFiles.js';
import { hasPendingCreateReview } from '../files/reviewFiles.js';
import {
  findTemplateId,
  hasTemplateFor,
  listTemplateFiles,
  readFundCss,
} from '../files/templateFiles.js';
```

(残りの import はそのまま。)`auditedRethrow` の中身を、属性の組み立てから `const meta: TemplateMeta = {` の手前まで次にする:

```ts
          // テンプレートは会社・ファンド・版種に 1 つで、基準日を持たない(基準日で使い回さない)。
          const attributes: SkeletonAttributes = {
            companyCode: assertTemplateAttributeToken('会社コード', body.companyCode),
            fundCode: assertTemplateAttributeToken('ファンドコード', body.fundCode),
            editionType: assertTemplateAttributeToken('版種', body.editionType),
          };
          // コピー元も属性と同じくここで検査する。検査済みの値だけを生成器と作成履歴へ渡す。
          const sourceFundCode = body.sourceFundCode
            ? assertTemplateAttributeToken('コピー元ファンドコード', body.sourceFundCode)
            : undefined;
          // 画面はコピー元テンプレートが無い候補で作成を止めるが、API を直接呼ばれても同じ結果にする。
          if (
            sourceFundCode &&
            !(await hasTemplateFor(attributes.companyCode, sourceFundCode, attributes.editionType))
          ) {
            throw validation(`コピー元のテンプレートがありません: ${sourceFundCode}`);
          }
          const fileName = skeletonFileName(attributes);
          const id = templateIdFromFileName(fileName);

          // ① 作成済みなら生成では触らない。直すときは作成タブで既存のテンプレートを開き、申請 → 承認で
          // templates/ を上書きする。照合は作成タブの「作成済み」と同じく大文字小文字を区別しない。
          const existing = findTemplateId(
            await listTemplateFiles(),
            attributes.companyCode,
            attributes.fundCode,
            attributes.editionType,
          );
          if (existing !== null) {
            throw conflict('作成済みです。既存のテンプレートを開いてください');
          }
          // ② 承認待ちの作成申請があるうちに作り直すと、承認でその申請の内容が templates/ に入り、
          // 作り直した生成物と食い違う。
          if (await hasPendingCreateReview(id)) {
            throw conflict('申請中です。承認か却下を待ってください');
          }
          // ③ 作業中(下書きか pending)を黙って捨てない。画面は確認ダイアログで同意を得て送り直す。
          if (body.replaceExisting !== true && ((await draftExists(id)) || (await pendingExists(id)))) {
            throw conflict('作成中のテンプレートがあります');
          }

          // ④ 生成器の出力へ、承認済み注記マスタ(そのファンド・版種)を適用してから保存する。
          // 生成器(差し替え前提)にマスタ参照を要求しないための編集側適用点。DB 不達時は
          // 関数内で warn + 素通し(生成をブロックしない)。
          const html = await noteMaster.applyNoteMasterToHtml(
            // 生成器へはリクエスト本文を渡さず、検証済みの属性だけを明示して組む
            // (本文の他のキーが共有上のコードへ流れないようにする)。
            await generateTemplate({
              companyCode: attributes.companyCode,
              fundCode: attributes.fundCode,
              editionType: attributes.editionType,
              ...(sourceFundCode === undefined ? {} : { sourceFundCode }),
              ...(body.isRedemption === true ? { isRedemption: true } : {}),
            }),
            attributes.fundCode,
            attributes.editionType,
          );
          const css = await readFundCss(attributes.fundCode);
```

`config.requireAuth` の分岐を:

```ts
          // REST モード: pending 実体 → 作成記録の順。CSS はファンド共有ファイルなので pending に
          // しか書かない — 共有 CSS の書き換えは承認経路(`applyConfirmedWrite`)の専権である。
          // 前回の下書きと生成物は、生成器が成功したここで初めて捨てる(失敗したら作業を残す)。
          // 下書きが残ると、編集画面を開いたときに古い下書きが新しい生成物を覆う。コメント(notes/)と
          // パーツ変更履歴は同じテンプレートの記録なので残す。確定側(templates/)は ① が守る。
          if (config.requireAuth) {
            await deleteDraft(id);
            await deletePending(id);
            await writePending(id, html, css);
            await recordCreate(attributes, sourceFundCode, loginId);
          }
```

ファイル末尾の `todayYmd` を消す。

- [ ] **Step 6: 取得・作成可否・承認・ファンド画像を切り替える**

`templateRepo.ts`: import に `parseTemplateFileName`・`skeletonFileName`(`@editor/shared`)、`findTemplateId`(`../files/templateFiles.js`)、`pendingExists`(`../files/pendingFiles.js`)を足す(`draftExists` は既に import 済み)。`getTemplate` の doc と本体を:

```ts
    /**
     * 1 件取得。メタはファイル名規約、本体はファイル(DB は引かない)。
     *
     * 探し先は id の形で決まる。値入り HTML(4 つ区切り)は ① `filled/`、テンプレート(3 つ区切り)は
     * ① `templates/`(作成経路の承認直後に精査画面が確定版を読む)。① に無ければ ② `pending/`
     * (生成直後の未確定実体)。① は `status:'published'`、② は `status:'draft'`、どこにも無ければ 404。
     * **確定を先に見る順序が契約**である。逆順にすると pending を書ける者が承認済みテンプレの
     * 表示内容を差し替えられ、編集画面・結合 PDF・比較タブが揃って汚染される。
     * 値入り HTML のときだけ `filled` に本文を入れる(値入り HTML は Jinja を持たないので
     * `html` と同じ内容。web は `filled` が非空の文書を完成描画として扱う)。
     */
    async getTemplate(id) {
      const fileName = `${id}.html`;
      const isFilled = parseTemplateFileName(fileName) !== null;
      const meta = await fileToMeta(fileName, isFilled ? 'filled' : 'template');
      if (!meta) throw notFound(`テンプレートが見つかりません: ${id}`);
      if (isFilled && (await filledExists(fileName))) {
        const html = await readFilledHtml(fileName);
        const css = await readFundCss(meta.attributes.fundCode);
        return { meta, html, css, filled: html };
      }
      if (!isFilled && (await templateExists(fileName))) {
        const html = await readTemplateHtml(fileName);
        const css = await readFundCss(meta.attributes.fundCode);
        return { meta, html, css, filled: '' };
      }
      const pending = await readPending(id);
      if (!pending) throw notFound(`テンプレートが見つかりません: ${id}`);
      return {
        meta: { ...meta, status: 'draft', updatedAt: await pendingMtime(id) },
        html: pending.html,
        css: pending.css,
        filled: '',
      };
    },
```

`getCreatableInfo` の doc を「作成タブ Step 2 の素。作成済み・作業中・コピー元の有無はファイルで、シリーズは Rep1 の会社コードで引き、名称はファンド一覧から付ける。」にし、先頭 2 行(`const templateKeys = …` と `const created = …`)とその上のコメントを:

```ts
      // テンプレートは基準日で使い回さないので、テンプレートフォルダ(templates/)に 3 つ区切りの
      // ファイルがあるかだけを見る。値入り HTML(filled/)や生成直後(pending/)は作成済みに数えない。
      const files = await listTemplateFiles();
      const templateKeys = templateAttrKeys(files);
      const templateId = findTemplateId(files, companyCode, fundCode, editionType);
      const created = templateId !== null;
      // 作業中は、作成済みでないときだけ問う。作成済みのテンプレートを作成経路で直している下書きは
      // 作り直しの対象ではない(画面は「既存のテンプレートを開く」だけを出す)。
      const id = templateIdFromFileName(skeletonFileName({ companyCode, fundCode, editionType }));
      const inProgress = !created && ((await draftExists(id)) || (await pendingExists(id)));
      const extra = {
        ...(templateId === null ? {} : { templateId }),
        ...(inProgress ? { inProgressId: id } : {}),
      };
```

(`templateIdFromFileName` も `@editor/shared` から import する。)`return { created, seriesFunds: [] };` を `return { created, ...extra, seriesFunds: [] };`、最後の `return { created, seriesFunds };` を `return { created, ...extra, seriesFunds };` にする。

`confirmedWrite.ts`: `assertFileNameFor` の doc と本体を:

```ts
/** 書込先ごとに受けるファイル名の形を強制する。値入り HTML は 4 つ区切り、テンプレートは 3 つ区切りだけ。 */
function assertFileNameFor(target: ConfirmedTarget, fileName: string): string {
  return target === 'filled' ? assertTemplateFileName(fileName) : assertSkeletonFileName(fileName);
}
```

(`parseSkeletonFileName` の import は使わなくなるので消す。)`baselineTemplateHtml` の doc と本体を:

```ts
/**
 * 実行コード不変性の基準となる HTML を返す。確定版(`target='filled'` は値入り HTML、
 * `target='template'` はテンプレート)→ pending の順に探し、どれも無ければ空文字。
 * 値入り HTML とテンプレートは id の形が違うので、互いの置き場は読まない。
 * 空文字を基準にすると「実行コードを 1 つも持てない」に倒れる(fail-closed)。
 * **確定を先に見る順序が契約**で、逆にすると pending を書ける者が基準そのものを差し替えられる。
 */
export async function baselineTemplateHtml(
  templateId: string,
  target: ConfirmedTarget,
): Promise<string> {
  const fileName = `${templateId}.html`;
  const confirmed =
    target === 'filled' ? await readFilledHtml(fileName) : await readTemplateHtml(fileName);
  if (confirmed !== '') return confirmed;
  const pending = await readPending(templateId);
  return pending?.html ?? '';
}
```

`reviewRepo.ts`: import に `parseSkeletonFileName`・`parseTemplateFileName` を足す。`submitReview` の `parseAnyTemplateFileName` の 2 行の直後に:

```ts
      // 経路ごとに id の形が決まっている。作成タブはテンプレート(会社_ファンド_版種)、編集タブは
      // 値入り HTML(会社_ファンド_基準日_版種)。形が合わない申請は承認で書けないので入口で止める。
      if (req.origin === 'create' && !parseSkeletonFileName(`${req.templateId}.html`)) {
        throw validation(
          `作成タブの申請はテンプレート(会社_ファンド_版種)の id だけを受けます: ${req.templateId}`,
        );
      }
      if (req.origin === 'edit' && !parseTemplateFileName(`${req.templateId}.html`)) {
        throw validation(
          `編集タブの申請は値入り HTML(会社_ファンド_基準日_版種)の id だけを受けます: ${req.templateId}`,
        );
      }
```

`fundImages.ts`(web): import の `parseTemplateFileName` を `parseAnyTemplateFileName` にし、`fundCodeOfTemplateId` の doc を「テンプレ ID(値入り HTML `<会社>_<ファンド>_<基準日>_<版>`、テンプレート `<会社>_<ファンド>_<版>`)からファンドコードを取り出す。」、本体を `parseAnyTemplateFileName(...)` にする(生成が 3 つ区切りになるこのコミットから、作成経路でファンド画像を解決できるようにする)。

- [ ] **Step 7: e2e の seed を直す**

`e2e-rest-seed.ts`: `fixturesTemplatesDir` とそれを写すループを消し、`templatesDir` の作成の後に次のコメントを置く(関数の doc の「確定 template と per-fund CSS を置くだけで」は「値入り HTML と per-fund CSS を置くだけで」に):

```ts
  // templates/ は空で始める。作成済みとコピー元は 3 つ区切り(会社_ファンド_版種)のファイルだけを
  // 数え、fixtures の templates/(4 つ区切り。local では値入り HTML として使う)はここでは意味を持たない。
```

- [ ] **Step 8: openapi と検証**

```bash
pnpm exec tsc -b editor/shared
pnpm --filter server run openapi:gen
pnpm typecheck
pnpm exec vitest run --project server
pnpm run test:editor
pnpm run build
pnpm exec playwright test -c editor/playwright.config.ts --project=chromium create.spec
```

Expected: typecheck exit 0、vitest 全件 PASS(`openapiArtifact.guard` を含む)、build exit 0、e2e PASS(`/edit/AM01_510037_交付版?created=1` が開き、ハイライトが出る)。

(pre-push の `e2e:editor` は docs project で `docs/editor/images/` を撮り直す。seed の `templates/` が空になったので `create-tab.png` の作成済みの注意が消え、byte 差分が出るのは想定どおり。このコミットには含めず、Task 4 で撮影の状態を変えたうえで Task 5 の Step 0 にまとめる。)

- [ ] **Step 9: コミット**

```bash
pnpm exec biome check --write editor/shared/src editor/server/src editor/server/test editor/server/scripts editor/web/src editor/web/test editor/e2e
git status --short   # docs/editor/images の差分(create-tab.png など)は含めない
git add editor/shared/src/schemas.ts editor/server/src/files/templateFiles.ts editor/server/src/files/reviewFiles.ts editor/server/src/routes/generate.routes.ts editor/server/src/generate/pyTemplate.ts editor/server/scripts/fake_generate_template.py editor/server/src/repositories/templateRepo.ts editor/server/src/repositories/confirmedWrite.ts editor/server/src/repositories/reviewRepo.ts editor/web/src/features/editor/fundImages.ts editor/server/scripts/e2e-rest-seed.ts editor/e2e/create.spec.ts editor/server/test/generate.routes.test.ts editor/server/test/pyTemplate.test.ts editor/server/test/fakeGenerator.test.ts editor/server/test/templateRepo.creatable.test.ts editor/server/test/templateRepo.filled.test.ts editor/server/test/templates.routes.test.ts editor/server/test/reviews.test.ts editor/server/test/confirmedWrite.guard.test.ts editor/server/test/confirmedWrite.rollback.test.ts editor/server/test/pathGuards.test.ts editor/server/test/ioFailurePolicy.test.ts editor/web/test/fundImages.test.ts editor/server/openapi/openapi.json
git commit -m "feat(editor): テンプレートを基準日の無い名前(会社_ファンド_版種)で作り、作成済み・申請中・作成中は生成を止める"
```

---

### Task 4: web — 作成タブで既存・作成中のテンプレートを開き、作り直しは確認する。基準日を隠す。local も同じ規則にする

**Files:**
- Create: `editor/web/src/lib/templateAttributeItems.ts`、`editor/web/test/templateAttributeItems.test.ts`
- Modify: `editor/web/src/features/editor/EditorTopBar.vue:5-30,76-81`、`editor/web/src/components/AttributeBar.vue`
- Modify: `editor/web/src/features/templates/CreateTabView.vue`
- Modify: `editor/web/src/features/templates/services/templateCreationService.ts`
- Create: `editor/web/test/CreateTabView.dom.test.ts`、`editor/web/test/forgetLocalEditState.dom.test.ts`
- Modify: `editor/web/test/templateCreationService.test.ts`、`editor/web/test/templateTable.dom.test.ts`
- Modify: `editor/web/src/api/local/templateRepo.ts`(`getCreatableInfo`・`generate`・補助関数 3 つ)、`editor/web/src/api/local/store.ts:13,252`、`editor/web/src/api/local/reviewRepo.ts:14,84`
- Modify(テスト): `editor/web/test/localReposExtra.dom.test.ts`
- Modify: `editor/e2e/create.spec.ts`(2 つ目のテスト)、`editor/e2e/capture_docs.spec.ts`(作成タブの撮影の状態)
- Modify: `vitest.config.ts`(include に `editor/web/src/lib/templateAttributeItems.ts`)

**Interfaces:**
- Consumes: Task 3 の `CreatableInfo.templateId` / `inProgressId`、`GenerateRequest.replaceExisting`、Task 1 の `parseAnyTemplateFileName`・`parseSkeletonFileName`・`skeletonFileName`・`type SkeletonAttributes`、`editorRoute(id, { created: true })`、`confirm(opts): Promise<boolean>`(`@/components/ui/confirm`)、`useEditorSessionStore().clear(templateId)`(`@/stores/editorSession`)、`draftOwner.release(templateId)`(`@/lib/draftOwner`)
- Produces:
  - `templateAttributeItems(a: TemplateAttributes): TemplateAttributeItem[]`、`interface TemplateAttributeItem { key: keyof TemplateAttributes; label: string; value: string }`
  - `createTemplateCreationService(repo: TemplateRepository, forgetEditState?: (templateId: string) => void)`(生成に成功した id について呼ぶ。既定は何もしない)
  - `forgetLocalEditState(templateId: string): void`(`templateCreationService.ts`。編集セッションの Undo とその永続ミラー・UI 状態を `clear`、下書きの持ち主を `release`)

- [ ] **Step 1: 失敗するテストを書く**

`editor/web/test/templateAttributeItems.test.ts`(新規):

```ts
import { describe, expect, it } from 'vitest';
import { templateAttributeItems } from '@/lib/templateAttributeItems';

describe('templateAttributeItems', () => {
  it('値入り HTML(基準日あり)は 4 項目を決まった順に出す', () => {
    const items = templateAttributeItems({
      companyCode: 'AM01',
      fundCode: '510037',
      baseDate: '20240710',
      editionType: '交付版',
    });
    expect(items.map((i) => [i.label, i.value])).toEqual([
      ['委託会社コード', 'AM01'],
      ['ファンドコード', '510037'],
      ['基準日', '20240710'],
      ['版種', '交付版'],
    ]);
  });

  it('テンプレート(基準日なし)は基準日の項目ごと出さない', () => {
    const items = templateAttributeItems({ companyCode: 'AM01', fundCode: '510037', editionType: '交付版' });
    expect(items.map((i) => i.key)).toEqual(['companyCode', 'fundCode', 'editionType']);
  });
});
```

`editor/web/test/templateCreationService.test.ts` の `describe('TemplateCreationService.create', ...)` に追加(import に `conflict`・`err` を足す):

```ts
  it('生成に成功したら、その id の同じタブの編集状態を捨てる(失敗したら捨てない)', async () => {
    const repo = repoWithGenerate();
    const forget = vi.fn();
    const svc = createTemplateCreationService(repo, forget);
    await svc.create({ companyCode: 'AM01', fundCode: '510037', editionType: 'kr' });
    expect(forget).toHaveBeenCalledWith(meta.id);
    forget.mockClear();
    repo.generate.mockResolvedValueOnce(err(conflict('作成中のテンプレートがあります')) as never);
    await svc.create({ companyCode: 'AM01', fundCode: '510037', editionType: 'kr' });
    expect(forget).not.toHaveBeenCalled();
  });
```

`editor/web/test/forgetLocalEditState.dom.test.ts`(新規。localStorage と Pinia を使うので dom):

```ts
// =============================================================================
// forgetLocalEditState.dom.test.ts — 作り直した id の、同じタブに残る編集状態を捨てる
// =============================================================================
// 作り直したテンプレートを開いたとき、前の生成物の Undo が残っていると 1 回の Undo で捨てたはずの
// 本文が戻り、autosave がそれを下書きとして書き戻す。下書きの持ち主の記録も前の作業のもの。
import { createPinia, setActivePinia } from 'pinia';
import { beforeEach, describe, expect, it } from 'vitest';
import { forgetLocalEditState } from '@/features/templates/services/templateCreationService';
import { draftOwner } from '@/lib/draftOwner';
import { draftOwnerKey, undoStacksKey } from '@/lib/storageKeys';
import { useEditorSessionStore } from '@/stores/editorSession';

const ID = 'AM01_510037_交付版';

beforeEach(() => {
  localStorage.clear();
  sessionStorage.clear();
  setActivePinia(createPinia());
});

describe('forgetLocalEditState', () => {
  it('編集セッション(Undo とその永続ミラー)と下書きの持ち主を捨て、他の id には触れない', () => {
    const store = useEditorSessionStore();
    store.ensure(ID).undoPast.push({ html: '<p>前の生成物</p>', css: '' });
    store.persist(ID);
    store.ensure('AM01_510003_交付版').undoPast.push({ html: '<p>別</p>', css: '' });
    store.persist('AM01_510003_交付版');
    draftOwner.claim(ID);

    forgetLocalEditState(ID);

    expect(store.sessions[ID]).toBeUndefined();
    const undo = JSON.parse(localStorage.getItem(undoStacksKey()) ?? '{}');
    expect(undo).not.toHaveProperty(ID);
    expect(undo).toHaveProperty('AM01_510003_交付版');
    expect(JSON.parse(localStorage.getItem(draftOwnerKey()) ?? '{}')).not.toHaveProperty(ID);
  });
});
```

`editor/web/test/CreateTabView.dom.test.ts`(新規。router・toast・repo の差し込みは `CreateFundSelect.dom.test.ts` と同じ形。`confirm` はモックする):

```ts
// =============================================================================
// CreateTabView.dom.test.ts — 作成済み・作成中のテンプレートの開き方と、作り直しの確認
// =============================================================================
// テンプレートは会社・ファンド・版種に 1 つ。作成済みなら「既存のテンプレートを開く」だけを出し、
// 新規作成とシリーズから作成は押せない(押しても 409)。作成中(下書きか pending がある)なら
// 「作成中のテンプレートを開く」を出し、作り直すときは確認して同意を得てから replaceExisting で送る。
import { type CompanyOption, type CreatableInfo, type FundOption, ok } from '@editor/shared';
import { flushPromises, mount } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { REPOS_KEY } from '@/api/repositories';
import CreateTabView from '@/features/templates/CreateTabView.vue';

const { routeQuery, router, confirmMock } = vi.hoisted(() => {
  const routeQuery: Record<string, unknown> = {};
  const router = {
    currentRoute: { value: { query: {} as Record<string, unknown> } },
    replace: vi.fn(() => Promise.resolve()),
    push: vi.fn(() => Promise.resolve()),
  };
  return { routeQuery, router, confirmMock: vi.fn(async () => true) };
});
vi.mock('vue-router', () => ({
  useRoute: () => ({ query: routeQuery }),
  useRouter: () => router,
}));
vi.mock('@/components/ui/toast', () => ({ toastError: vi.fn(), toastSuccess: vi.fn() }));
vi.mock('@/components/ui/confirm', () => ({ confirm: confirmMock }));

const COMPANIES: CompanyOption[] = [
  { companyCode: 'AM01', companyName: '会社 1', rep1CompanyCode: 'R-AM01' },
];
const FUNDS: FundOption[] = [{ fundCode: '510037', fundName: 'ファンド' }];
const SERIES = [{ fundCode: '510003', fundName: '安定型', hasTemplate: true }];
const ID = 'AM01_510037_交付版';

function mountWith(info: CreatableInfo) {
  Object.assign(routeQuery, { companyCode: 'AM01', fundCode: '510037', editionType: '交付版' });
  const templates = {
    listCompanies: vi.fn(async () => ok(COMPANIES)),
    listFunds: vi.fn(async () => ok(FUNDS)),
    getCreatableInfo: vi.fn(async () => ok(info)),
    generate: vi.fn(async () =>
      ok({
        template: {
          meta: {
            id: ID,
            attributes: { companyCode: 'AM01', fundCode: '510037', editionType: '交付版' },
            fileName: `${ID}.html`,
            status: 'draft',
            updatedAt: null,
            updatedBy: null,
          },
          html: '',
          css: '',
          filled: '',
        },
      }),
    ),
  };
  const w = mount(CreateTabView, {
    global: { provide: { [REPOS_KEY as symbol]: { templates } } },
  });
  return { w, templates };
}

/** 会社の候補取得 → ファンドの取得 → 作成可否の取得(watch)の 3 段を流し切る。 */
async function settle() {
  await flushPromises();
  await flushPromises();
}

const buttonNamed = (w: ReturnType<typeof mount>, text: string) =>
  w.findAll('button').find((b) => b.text().includes(text));

beforeEach(() => {
  for (const k of Object.keys(routeQuery)) delete routeQuery[k];
  router.push.mockClear();
  confirmMock.mockReset();
  confirmMock.mockResolvedValue(true);
  localStorage.clear();
  setActivePinia(createPinia());
});

describe('CreateTabView', () => {
  it('作成済みなら「既存のテンプレートを開く」で作成経路の編集画面を開き、作成の 2 つは押せない', async () => {
    const { w, templates } = mountWith({ created: true, templateId: ID, seriesFunds: SERIES });
    await settle();
    const open = buttonNamed(w, '既存のテンプレートを開く');
    expect(open).toBeDefined();
    await open?.trigger('click');
    expect(router.push).toHaveBeenCalledWith({ name: 'editor', params: { id: ID }, query: { created: '1' } });
    expect(buttonNamed(w, '属性から新規作成')?.attributes('disabled')).toBeDefined();
    expect(buttonNamed(w, '既存のシリーズを元に作成')?.attributes('disabled')).toBeDefined();
    expect(buttonNamed(w, '作成中のテンプレートを開く')).toBeUndefined();
    expect(templates.generate).not.toHaveBeenCalled();
  });

  it('作成中なら「作成中のテンプレートを開く」で作成経路の編集画面を開く', async () => {
    const { w } = mountWith({ created: false, inProgressId: ID, seriesFunds: SERIES });
    await settle();
    await buttonNamed(w, '作成中のテンプレートを開く')?.trigger('click');
    expect(router.push).toHaveBeenCalledWith({ name: 'editor', params: { id: ID }, query: { created: '1' } });
    expect(buttonNamed(w, '属性から新規作成')?.attributes('disabled')).toBeUndefined();
  });

  it('作成中の作り直しは確認し、断れば生成しない', async () => {
    confirmMock.mockResolvedValue(false);
    const { w, templates } = mountWith({ created: false, inProgressId: ID, seriesFunds: [] });
    await settle();
    await buttonNamed(w, '属性から新規作成')?.trigger('click');
    await settle();
    expect(confirmMock).toHaveBeenCalledWith(
      expect.objectContaining({ title: '作業中の内容を捨てて作り直しますか' }),
    );
    expect(templates.generate).not.toHaveBeenCalled();
  });

  it('作成中の作り直しに同意すると replaceExisting で生成し、作成経路の編集画面へ進む', async () => {
    const { w, templates } = mountWith({ created: false, inProgressId: ID, seriesFunds: [] });
    await settle();
    await buttonNamed(w, '属性から新規作成')?.trigger('click');
    await settle();
    expect(templates.generate).toHaveBeenCalledWith(
      expect.objectContaining({ fundCode: '510037', replaceExisting: true }),
    );
    expect(router.push).toHaveBeenCalledWith({ name: 'editor', params: { id: ID }, query: { created: '1' } });
  });

  it('作成済みでも作成中でもなければ、確認せずに生成し「開く」ボタンは出ない', async () => {
    const { w, templates } = mountWith({ created: false, seriesFunds: [] });
    await settle();
    expect(buttonNamed(w, '既存のテンプレートを開く')).toBeUndefined();
    expect(buttonNamed(w, '作成中のテンプレートを開く')).toBeUndefined();
    await buttonNamed(w, '属性から新規作成')?.trigger('click');
    await settle();
    expect(confirmMock).not.toHaveBeenCalled();
    expect(templates.generate).toHaveBeenCalledWith(
      expect.not.objectContaining({ replaceExisting: true }),
    );
  });
});
```

(`CreateFundSelect.dom.test.ts` と同じく `global.provide` で `REPOS_KEY` に `templates` だけを渡し、子部品は stub にしない。`CreateFundSelect` は会社の候補を取り終えた後に URL の選択へ `rep1CompanyCode` を付けて `update` を出し、それを受けた `CreateTabView` の `watch` が `getCreatableInfo` を呼ぶので、`flushPromises` を 2 回呼んでから確かめる。それでも Step 2 が描かれないときだけ `settle` の回数を 1 回増やす。)

`editor/web/test/templateTable.dom.test.ts` に追加する(この行は今の実装でも `undefined` を空として描くので RED にはならない。基準日の無い行が「undefined」と出る退行を防ぐ回帰網として置く):

```ts
describe('TemplateTable の基準日の列(回帰網)', () => {
  it('基準日を持たないテンプレートの行は基準日の欄が空になる', () => {
    const skeleton: TemplateMeta = {
      id: 'AM01_510037_交付版',
      attributes: { companyCode: 'AM01', fundCode: '510037', editionType: '交付版' },
      fileName: 'AM01_510037_交付版.html',
      status: 'draft',
      updatedAt: null,
      updatedBy: null,
    };
    const w = mount(TemplateTable, {
      props: { rows: [skeleton], action: 'edit' },
      global: { stubs: { FundCodeName: true } },
    });
    expect(w.findAll('thead th').map((th) => th.text())).toContain('基準日');
    expect(w.text()).not.toContain('undefined');
  });
});
```

`editor/web/test/localReposExtra.dom.test.ts`: ファイル先頭の helper の近くに、作成タブの承認を通したテンプレートを置く helper を足す:

```ts
/** 作成タブで生成して承認した(= local の templates/ 相当)テンプレートを置く。 */
async function approveSkeleton(fundCode: string, editionType: string, html: string) {
  await localAuthRepo.login({ username: 'admin', password: 'admin' });
  const gen = await localTemplateRepo.generate({ companyCode: 'AM01', fundCode, editionType });
  if (!isOk(gen)) throw new Error('generate に失敗');
  const id = gen.value.template.meta.id;
  const saved = await confirmSaveLocal({ templateId: id, html, css: '', fundCode, origin: 'create' });
  if (!isOk(saved)) throw new Error('confirmSaveLocal に失敗');
  return id;
}
```

既存ケースの書き換え:
- `'listCompanies / listFunds / getCreatableInfo は fixtures から作る'`: fixtures(4 つ区切り。値入り HTML 扱い)だけでは作成済みにならない。`expect(info.value.created).toBe(true);` を `expect(info.value.created).toBe(false);` にし(`seriesFunds` の期待はそのまま)、続けて:

```ts
    const id = await approveSkeleton('510037', '交付版', '<p>{{ fund.name }}</p>');
    expect(id).toBe('AM01_510037_交付版');
    const after = await localTemplateRepo.getCreatableInfo({
      companyCode: 'am01',
      rep1CompanyCode: 'AM01',
      fundCode: '510037',
      editionType: '交付版',
    });
    expect(isOk(after) && after.value).toMatchObject({ created: true, templateId: id });
    expect(isOk(after) && after.value).not.toHaveProperty('inProgressId');
```

- `'generate(sourceFundCode) はコピー元ファンドの最新テンプレートの HTML を写す'` を次に替える:

```ts
  it('generate(sourceFundCode) は承認済みのコピー元テンプレート(3 つ区切り)の HTML を写す', async () => {
    await approveSkeleton('510037', '全体版', '<p>コピー元 {{ fund.name }}</p>');
    const r = await localTemplateRepo.generate({
      companyCode: 'AM01',
      fundCode: '510155',
      editionType: '全体版',
      sourceFundCode: '510037',
    });
    if (!isOk(r)) throw new Error('generate に失敗');
    expect(r.value.template.html).toBe('<p>コピー元 {{ fund.name }}</p>');
    expect(r.value.template.meta.id).toBe('AM01_510155_全体版');
  });
```

- `'generate(sourceFundCode) はコピー元テンプレートが無ければ失敗する'`: `sourceFundCode: '999999'` のまま 1 回、fixtures にある `sourceFundCode: '510037'` でもう 1 回呼び、どちらも `isOk(r)` が false(fixtures の 4 つ区切りはコピー元にならない)。
- `'getDropdownOptions(published) は未承認(draft)を候補に含めない'` を次に替える(生成物は基準日を持たないので、会社コードで確かめる):

```ts
  it('getDropdownOptions(published) は未承認(draft)を候補に含めない', async () => {
    await localAuthRepo.login({ username: 'admin', password: 'admin' });
    const r = await localTemplateRepo.generate({
      companyCode: 'ZZ99',
      fundCode: '000000',
      editionType: '交付版',
    });
    if (!isOk(r)) throw new Error('generate に失敗');
    const edit = await localTemplateRepo.getDropdownOptions({}, 'edit');
    const pub = await localTemplateRepo.getDropdownOptions({}, 'published');
    expect(isOk(edit) && edit.value.companyCodes).toContain('ZZ99');
    expect(isOk(pub) && pub.value.companyCodes).not.toContain('ZZ99');
    expect(isOk(edit) && edit.value.baseDates.every((d) => d !== '')).toBe(true);
  });
```

追加するケース(import に `isErr` を足す):

```ts
  it('generate は作成済みなら conflict「作成済み」', async () => {
    await approveSkeleton('510124', '交付版', '<p>確定</p>');
    const again = await localTemplateRepo.generate({ companyCode: 'AM01', fundCode: '510124', editionType: '交付版' });
    expect(isErr(again) && again.error).toMatchObject({
      kind: 'conflict',
      message: '作成済みです。既存のテンプレートを開いてください',
    });
  });

  it('generate は承認待ちの作成申請があれば、同意があっても conflict「申請中」', async () => {
    await localAuthRepo.login({ username: 'admin', password: 'admin' });
    const gen = await localTemplateRepo.generate({ companyCode: 'AM01', fundCode: '510003', editionType: '交付版' });
    if (!isOk(gen)) throw new Error('generate に失敗');
    const { localReviewRepo } = await import('@/api/local/reviewRepo');
    const sub = await localReviewRepo.submitReview({
      templateId: gen.value.template.meta.id,
      fundCode: '510003',
      origin: 'create',
      html: '<p>{{ x }}</p>',
      css: '',
    });
    expect(isOk(sub)).toBe(true);
    const again = await localTemplateRepo.generate({
      companyCode: 'AM01',
      fundCode: '510003',
      editionType: '交付版',
      replaceExisting: true,
    });
    expect(isErr(again) && again.error.message).toBe('申請中です。承認か却下を待ってください');
  });

  it('作成中(生成済み・未承認)は inProgressId を返し、同意の無い作り直しは conflict「作成中」', async () => {
    await localAuthRepo.login({ username: 'admin', password: 'admin' });
    const first = await localTemplateRepo.generate({ companyCode: 'AM01', fundCode: '510155', editionType: '交付版' });
    if (!isOk(first)) throw new Error('generate に失敗');
    const id = first.value.template.meta.id;
    const info = await localTemplateRepo.getCreatableInfo({
      companyCode: 'AM01',
      rep1CompanyCode: 'AM01',
      fundCode: '510155',
      editionType: '交付版',
    });
    expect(isOk(info) && info.value).toMatchObject({ created: false, inProgressId: id });
    const again = await localTemplateRepo.generate({ companyCode: 'AM01', fundCode: '510155', editionType: '交付版' });
    expect(isErr(again) && again.error.message).toBe('作成中のテンプレートがあります');
  });

  it('同意した作り直しは前回の下書きを捨てる', async () => {
    await localAuthRepo.login({ username: 'admin', password: 'admin' });
    const first = await localTemplateRepo.generate({ companyCode: 'AM01', fundCode: '510155', editionType: '交付版' });
    if (!isOk(first)) throw new Error('generate に失敗');
    const id = first.value.template.meta.id;
    await localTemplateRepo.saveDraft({ templateId: id, html: '<p>古い下書き</p>', css: '' });
    const again = await localTemplateRepo.generate({
      companyCode: 'AM01',
      fundCode: '510155',
      editionType: '交付版',
      replaceExisting: true,
    });
    expect(isOk(again)).toBe(true);
    const draft = await localTemplateRepo.getDraft(id);
    expect(isOk(draft) && draft.value).toBeNull();
  });
```

`editor/e2e/create.spec.ts` の末尾に 2 つ目のテストを足す(import に `import fs from 'node:fs';`・`import path from 'node:path';`・`import { E2E_REST_DATA_ROOT } from '../server/scripts/e2e-rest-paths';` を足す):

```ts
test('作成タブ: 作成済みなら「既存のテンプレートを開く」で作成経路の編集画面を開き、基準日を出さない', async ({
  page,
}) => {
  // seed の後に、作成済みのテンプレート(3 つ区切り)を templates/ へ置く。
  const templatesDir = path.join(E2E_REST_DATA_ROOT, 'templates');
  fs.mkdirSync(templatesDir, { recursive: true });
  fs.writeFileSync(
    path.join(templatesDir, 'AM01_510037_交付版.html'),
    '<html><body><h1 class="report-title">{{ fund.name }}</h1><p>基準日: {{ report.baseDate }}</p></body></html>',
    'utf8',
  );
  await login(page);
  await page.goto(
    `/create?companyCode=AM01&fundCode=510037&editionType=${encodeURIComponent('交付版')}`,
    { waitUntil: 'commit' },
  );
  await expect(page.getByText('テンプレートは作成済みです')).toBeVisible();
  await expect(page.getByRole('button', { name: '属性から新規作成' })).toBeDisabled();
  await page.getByRole('button', { name: '既存のテンプレートを開く' }).click();

  await expect(page).toHaveURL(/\/edit\/.+\?created=1$/);
  expect(decodeURIComponent(new URL(page.url()).pathname)).toBe('/edit/AM01_510037_交付版');
  const frame = page.frameLocator('iframe.gjs-frame');
  await frame.locator('.report-title').first().waitFor({ state: 'visible', timeout: 30_000 });
  await expect(frame.locator('body')).toHaveClass(/jinja-vars-highlight/, { timeout: 15_000 });
  // 上部バーの属性チップに基準日が無い(canvas の中の「基準日:」は iframe の中なので数えない)。
  await expect(page.locator('header').getByText('基準日', { exact: true })).toHaveCount(0);
});
```

Run: `pnpm exec vitest run --project "web-*" editor/web/test/templateAttributeItems.test.ts editor/web/test/templateCreationService.test.ts editor/web/test/forgetLocalEditState.dom.test.ts editor/web/test/CreateTabView.dom.test.ts editor/web/test/templateTable.dom.test.ts editor/web/test/localReposExtra.dom.test.ts`
Expected: FAIL(`templateAttributeItems` / `forgetLocalEditState` が無い、「既存のテンプレートを開く」「作成中のテンプレートを開く」が無い、local の id が 4 つ区切り など)。`templateTable.dom.test.ts` の新ケースは回帰網なので PASS のまま。

- [ ] **Step 2: 属性の表示項目を作り、上部バーと属性欄で使う**

`editor/web/src/lib/templateAttributeItems.ts`(新規):

```ts
// =============================================================================
// templateAttributeItems.ts — テンプレート属性の表示項目(上部バー・属性欄で共用。純関数)
// =============================================================================
// テンプレート(templates/。会社_ファンド_版種)は基準日を持たない。基準日の無いテンプレートを
// 開いているときは、空のチップを出さず基準日の項目ごと省く。

import type { TemplateAttributes } from '@editor/shared';

export interface TemplateAttributeItem {
  key: keyof TemplateAttributes;
  label: string;
  value: string;
}

const LABELS: ReadonlyArray<[keyof TemplateAttributes, string]> = [
  ['companyCode', '委託会社コード'],
  ['fundCode', 'ファンドコード'],
  ['baseDate', '基準日'],
  ['editionType', '版種'],
];

/** 表示する属性の項目(決まった順)。値の無い項目(テンプレートの基準日)は出さない。 */
export function templateAttributeItems(a: TemplateAttributes): TemplateAttributeItem[] {
  return LABELS.flatMap(([key, label]) => {
    const value = a[key];
    return value === undefined ? [] : [{ key, label, value }];
  });
}
```

`vitest.config.ts` の include の `'editor/web/src/lib/routeQuery.ts',` の次に `'editor/web/src/lib/templateAttributeItems.ts',` を足す。

`EditorTopBar.vue`: `import { templateAttributeItems } from '@/lib/templateAttributeItems';` を足し、`attrItems` を:

```ts
// テンプレート(基準日を持たない)を開いているときは、基準日のチップごと出さない。
const attrItems = (a: TemplateAttributes) =>
  templateAttributeItems(a).map((i) => ({ k: i.label, v: i.value }));
```

`AttributeBar.vue` の `<script setup>` を:

```ts
import type { TemplateAttributes } from '@editor/shared';
import { computed } from 'vue';
import FundCodeName from '@/components/FundCodeName.vue';
import { templateAttributeItems } from '@/lib/templateAttributeItems';

// (inline の説明コメントはそのまま)
const props = withDefaults(defineProps<{ attributes: TemplateAttributes; inline?: boolean }>(), {
  inline: false,
});

// テンプレート(基準日を持たない)を開いているときは、基準日の項目ごと出さない。
const items = computed(() => templateAttributeItems(props.attributes));
```

テンプレート部は `v-for="it in items"` のまま、`<FundCodeName v-if="it.key === 'fundCode'" :code="it.value" />` と `<span v-else class="mono font-medium">{{ it.value }}</span>` にする。

- [ ] **Step 3: 作り直した id の編集状態を捨てる**

`templateCreationService.ts`: import に `useEditorSessionStore`(`@/stores/editorSession`)と `draftOwner`(`@/lib/draftOwner`)を足し、`createTemplateCreationService` と `useTemplateCreationService` を:

```ts
/**
 * 生成に成功した id について、同じタブに残る編集状態を捨てる。作り直したテンプレートを開いたとき、
 * 前の生成物の Undo(とその永続ミラー)が残っていると 1 回の Undo で捨てたはずの本文が戻り、
 * autosave がそれを下書きとして書き戻す。下書きの持ち主の記録も前の作業のものなので消す。
 */
export function forgetLocalEditState(templateId: string): void {
  useEditorSessionStore().clear(templateId);
  draftOwner.release(templateId);
}

export function createTemplateCreationService(
  repo: TemplateRepository,
  forgetEditState: (templateId: string) => void = () => {},
): TemplateCreationService {
  return {
    async create(req) {
      if (!req.companyCode || !req.fundCode || !req.editionType) {
        return err(validation(SELECT_ALL_MSG));
      }
      const res = await repo.generate(req);
      if (isOk(res)) forgetEditState(res.value.template.meta.id);
      return map(res, (r) => r.template.meta);
    },
    listCompanies: () => repo.listCompanies(),
    listFunds: (rep1CompanyCode) => repo.listFunds(rep1CompanyCode),
    getCreatableInfo: (q) => repo.getCreatableInfo(q),
  };
}

// ストアは生成に成功したときに初めて引く(`forgetLocalEditState` の中)。setup の時点で引くと、
// Pinia を持たない部品のテストまで Pinia を要求する。
export const useTemplateCreationService = (): TemplateCreationService =>
  createTemplateCreationService(useTemplateRepo(), forgetLocalEditState);
```

(`isOk` を `@editor/shared` の import に足す。)

- [ ] **Step 4: 作成タブに「既存のテンプレートを開く」「作成中のテンプレートを開く」と作り直しの確認を足す**

`CreateTabView.vue`:
- import の `@lucide/vue` に `FolderOpen` を足し、`import { confirm } from '@/components/ui/confirm';` を足す。
- `isSeriesFund` の後に:

```ts
// 作成済み(templates/ にある)なら作成せず、既存のテンプレートを開かせる(作成しても 409 になる)。
const alreadyCreated = computed(() => info.value?.created === true);
```

- `selectMethod` の先頭の条件を `if (!canCreate.value || alreadyCreated.value || creating.value) return;` にする。
- `create` の後に:

```ts
/**
 * 作業中(同じ id の下書きか pending)があれば、作り直しの同意を取る。同意しなければ null(作らない)。
 * サーバは同意(`replaceExisting`)の無い作り直しを 409 で止めるので、送る前にここで聞く。
 */
async function recreateConsent(): Promise<{ replaceExisting?: true } | null> {
  if (!info.value?.inProgressId) return {};
  const ok = await confirm({
    title: '作業中の内容を捨てて作り直しますか',
    description:
      '作成中のテンプレートの下書きと生成した内容を捨てて、新しく作り直します。コメントと修正履歴は残ります。',
    confirmLabel: '作り直す',
    variant: 'destructive',
  });
  return ok ? { replaceExisting: true } : null;
}

/** 作成経路(差し込み値のハイライトあり)で開く。作成済みは申請 → 承認で templates/ を上書きする。 */
function openInCreateRoute(id: string | undefined) {
  if (id) router.push(editorRoute(id, { created: true }));
}
```

- `createNew` と `createFromSeries` を `async` にし、属性の確認の後・`create(...)` の前に `const consent = await recreateConsent(); if (!consent) return;` を置いて、要求に `...consent` を足す:

```ts
async function createNew() {
  const { companyCode, fundCode, editionType } = liveQuery;
  if (!companyCode || !fundCode || !editionType) {
    toastError(SELECT_ALL_MSG);
    return;
  }
  const consent = await recreateConsent();
  if (!consent) return;
  await create(
    { companyCode, fundCode, editionType, isRedemption: isRedemption.value, ...consent },
    'テンプレートを作成しました',
  );
}

async function createFromSeries(sourceFundCode: string) {
  if (creating.value || alreadyCreated.value) return; // 連打・作成済みで二重に作らせない
  // コピー元は候補のファンド。作成されるのは Step1 で選んだファンド。
  const { companyCode, fundCode, editionType } = liveQuery;
  if (!companyCode || !fundCode || !editionType) {
    toastError(SELECT_ALL_MSG);
    return;
  }
  const consent = await recreateConsent();
  if (!consent) return;
  await create(
    { companyCode, fundCode, editionType, sourceFundCode, isRedemption: isRedemption.value, ...consent },
    'シリーズを基にテンプレートを作成しました',
  );
}
```

(`selectMethod` の `createNew();` は `void createNew();` にする。`create` が `Promise` を返す形でなければ `async function create(...)` のまま `await` で受ける。)

- テンプレート部の作成済みの注意(`<p v-if="canCreate && info?.created" …>`)を次の 2 つに替える:

```vue
        <div
          v-if="canCreate && alreadyCreated"
          class="mb-3 flex flex-wrap items-center gap-3 rounded-[11px] border border-warning/40 bg-warning/10 px-4 py-2.5 text-[12.5px] text-foreground"
        >
          <span>この会社・ファンド・版種のテンプレートは作成済みです。直すときは既存のテンプレートを開いてください。</span>
          <Button v-if="info?.templateId" variant="outline" size="sm" @click="openInCreateRoute(info?.templateId)">
            <FolderOpen /> 既存のテンプレートを開く
          </Button>
        </div>
        <div
          v-else-if="canCreate && info?.inProgressId"
          class="mb-3 flex flex-wrap items-center gap-3 rounded-[11px] border border-warning/40 bg-warning/10 px-4 py-2.5 text-[12.5px] text-foreground"
        >
          <span>この会社・ファンド・版種のテンプレートは作成中です。続きは作成中のテンプレートを開いてください。作り直すと作業中の内容は捨てられます。</span>
          <Button variant="outline" size="sm" @click="openInCreateRoute(info?.inProgressId)">
            <FolderOpen /> 作成中のテンプレートを開く
          </Button>
        </div>
```

- カードを並べる `div` の class を `cn('flex flex-wrap gap-3', (!canCreate || alreadyCreated) && 'pointer-events-none')` にし、カードの `Button` の `:disabled="!canCreate"` を `:disabled="!canCreate || alreadyCreated"` にする。

(見える文言・ボタンの追加は仕様の決定事項どおり。他の要素は消さない。)

- [ ] **Step 5: local を server と同じ規則にする**

`store.ts`: import の `parseTemplateFileName` を `parseAnyTemplateFileName` にし、`allMetas` の `const attrs = parseTemplateFileName(fileName);` を `parseAnyTemplateFileName(fileName)` にする(生成したテンプレート(3 つ区切り)も一覧と取得に出す)。

`reviewRepo.ts`(local): import に `parseAnyTemplateFileName` を足し(`parseTemplateFileName` は使わなくなれば消す)、`submitReview` の `parseTemplateFileName(`${req.templateId}.html`)` を `parseAnyTemplateFileName(...)` にする。

`templateRepo.ts`(local): import に `conflict`・`parseSkeletonFileName`・`type ReviewRequest`・`type SkeletonAttributes`・`skeletonFileName` を足し、Task 1 で足した `FilledTemplateAttributes` と使わなくなる `todayYmd`(`./store` から)を外す。`confirmSaveLocal` の前に:

```ts
/**
 * local の templates/ 相当: 作成タブの承認(`confirmSaveLocal`)を通ったテンプレート(3 つ区切り)。
 * 生成しただけ(server の pending/ 相当)は `updatedAt` を持たないので数えない。会社コードは
 * 大文字小文字を区別しない(server の `findTemplateId` と同じ)。
 */
function confirmedSkeleton(
  companyCode: string,
  fundCode: string,
  editionType: string,
): TemplateMeta | undefined {
  return allMetas().find(
    (m) =>
      parseSkeletonFileName(m.fileName) !== null &&
      m.updatedAt !== null &&
      m.attributes.companyCode.toLowerCase() === companyCode.toLowerCase() &&
      m.attributes.fundCode === fundCode &&
      m.attributes.editionType === editionType,
  );
}

/** 作業中か(同じ id の下書きか、承認前の生成物)。server の「下書きか pending/ がある」と同じ規則。 */
function inProgress(templateId: string): boolean {
  if (read<Record<string, TemplateDraft>>(K.drafts, {})[templateId]) return true;
  return allMetas().some((m) => m.id === templateId && m.updatedAt === null);
}

/** 同じ id の承認待ちの作成申請があるか(server の `hasPendingCreateReview` と同じ規則)。 */
function hasPendingCreateReview(templateId: string): boolean {
  const want = templateId.toLowerCase();
  return Object.values(read<Record<string, ReviewRequest>>(K.reviews, {})).some(
    (r) => r.status === 'pending' && r.origin === 'create' && r.templateId.toLowerCase() === want,
  );
}
```

(`inProgress` の `allMetas()` は fixtures の 4 つ区切りも含むが、生成の id は 3 つ区切りなので当たらない。)

`getCreatableInfo` を:

```ts
  getCreatableInfo: ({ companyCode, fundCode, editionType }) =>
    attempt(() => {
      const created = confirmedSkeleton(companyCode, fundCode, editionType);
      const id = templateIdFromFileName(skeletonFileName({ companyCode, fundCode, editionType }));
      // シリーズはモック(`SERIES_FUND_CODES`)。コピー元は承認済みのテンプレートだけ(server と同じ)。
      const seriesFunds = SERIES_FUND_CODES.has(fundCode)
        ? [...SERIES_FUND_CODES]
            .filter((c) => c !== fundCode)
            .sort()
            .map((c) => ({
              fundCode: c,
              fundName: fundMaster[c]?.name ?? '',
              hasTemplate: confirmedSkeleton(companyCode, c, editionType) !== undefined,
            }))
        : [];
      return delay({
        created: created !== undefined,
        ...(created ? { templateId: created.id } : {}),
        ...(!created && inProgress(id) ? { inProgressId: id } : {}),
        seriesFunds,
      });
    }),
```

`generate` の先頭(`const user = currentUser();` の後)から `const meta: TemplateMeta = {` の手前までを:

```ts
      // テンプレートは会社・ファンド・版種に 1 つで、基準日を持たない(server の生成と同じ規則)。
      const attrs: SkeletonAttributes = {
        companyCode: req.companyCode,
        fundCode: req.fundCode,
        editionType: req.editionType,
      };
      const fileName = skeletonFileName(attrs);
      const id = templateIdFromFileName(fileName);
      if (confirmedSkeleton(req.companyCode, req.fundCode, req.editionType)) {
        throw conflict('作成済みです。既存のテンプレートを開いてください');
      }
      if (hasPendingCreateReview(id)) {
        throw conflict('申請中です。承認か却下を待ってください');
      }
      if (req.replaceExisting !== true && inProgress(id)) {
        throw conflict('作成中のテンプレートがあります');
      }
      let baseHtml: string;
      if (req.sourceFundCode) {
        const source = confirmedSkeleton(req.companyCode, req.sourceFundCode, req.editionType);
        if (!source) throw validation(`コピー元のテンプレートがありません: ${req.sourceFundCode}`);
        const baseRes = await localTemplateRepo.getTemplate(source.id);
        if (isErr(baseRes)) throw baseRes.error;
        baseHtml = baseRes.value.html;
      } else {
        baseHtml =
          fixtureTemplates[
            Object.keys(fixtureTemplates).find((f) =>
              f.startsWith(`${req.companyCode}_${req.fundCode}_`),
            ) ?? ''
          ] ?? defaultSkeleton();
      }
      // 償還ファンド指定時は特定パーツを償還用パーツへ置換(モック)。
      if (req.isRedemption) baseHtml = applyRedemptionMock(baseHtml);
      // 生成できたので、前回の下書きを捨ててから置く(server と同じく失敗時は何も捨てない)。
      clearDraft(id);
```

(`clearDraft` は同じファイルの関数。`meta` 以降はそのまま。`htmlOverride[id] = baseHtml` が前回の生成物を上書きする。)

local と server で残る違い(受け入れる): local では承認済みのテンプレート(3 つ区切り)も `allMetas` に入るので、編集タブの一覧に `draft` の行として出る(server の一覧は `filled/` と `pending/` だけで、`templates/` は出さない)。local は別ツールの配置運用を持たず、承認済みテンプレートへ辿る導線が作成タブしか無いので、この違いは残す。設計書の 4.2 節(local と rest の対比)に 1 文書く(Task 5)。

- [ ] **Step 6: 撮影の状態を作成済みに替える**

`editor/e2e/capture_docs.spec.ts` の作成タブの撮影(「②b テンプレート作成タブ」)を、作成済みで「既存のテンプレートを開く」が見える状態にする。import に `import fs from 'node:fs';` と `import { E2E_REST_DATA_ROOT } from '../server/scripts/e2e-rest-paths';` を足し(`node:path` は既にある `resolve` を使う)、`page.goto('/create?…')` の前に:

```ts
  // 作成済みのテンプレート(3 つ区切り)を置き、「既存のテンプレートを開く」が出る状態を写す。
  fs.mkdirSync(resolve(E2E_REST_DATA_ROOT, 'templates'), { recursive: true });
  fs.writeFileSync(
    resolve(E2E_REST_DATA_ROOT, 'templates', 'AM01_510037_交付版.html'),
    '<html><body><h1 class="report-title">{{ fund.name }}</h1></body></html>',
    'utf8',
  );
```

`await expect(page.getByRole('button', { name: '属性から新規作成' })).toBeEnabled();` を `await expect(page.getByRole('button', { name: '既存のテンプレートを開く' })).toBeVisible();` にする。

- [ ] **Step 7: 通ることを確かめる**

Run: Step 1 の vitest コマンド → PASS。

```bash
pnpm typecheck
pnpm run test:editor
pnpm run build
pnpm exec playwright test -c editor/playwright.config.ts --project=chromium create.spec
pnpm exec playwright test -c editor/playwright.config.ts --project=docs capture_docs.spec
```

Expected: typecheck exit 0、test:editor 全件 PASS、build exit 0、e2e の create.spec の 2 テストと capture_docs が PASS(`docs/editor/images/create-tab.png` が「作成済み・既存のテンプレートを開く」の状態で撮り直される。コミットは Task 5 の Step 0)。

- [ ] **Step 8: カバレッジを確かめる(pre-push には入らない)**

Run: `pnpm run test:coverage`
Expected: exit 0。include にある、この計画で変えたファイル(`template.ts`・`sampleData.ts`・`templateRepo.ts`(server)・`templateFiles.ts`・`confirmedWrite.ts`・`routes/*.ts`・`local/templateRepo.ts`・`local/reviewRepo.ts`・`templateCreationService.ts`・`features/editor/fundImages.ts`・`templateAttributeItems.ts` ほか)がファイル単位で 85% を保つ。下回ったファイルがあれば、そのファイルの未到達の分岐(多くは 409 の文言の分岐や `?? ''` の右辺)を通すケースを、そのファイルを持つ Task のテストファイルに足してからコミットする。

- [ ] **Step 9: コミット**

```bash
pnpm exec biome check --write editor/web/src editor/web/test editor/e2e
git status --short   # docs/editor/images の再撮影差分は含めない
git add editor/web/src/lib/templateAttributeItems.ts editor/web/test/templateAttributeItems.test.ts editor/web/src/features/editor/EditorTopBar.vue editor/web/src/components/AttributeBar.vue editor/web/src/features/templates/CreateTabView.vue editor/web/src/features/templates/services/templateCreationService.ts editor/web/test/CreateTabView.dom.test.ts editor/web/test/forgetLocalEditState.dom.test.ts editor/web/test/templateCreationService.test.ts editor/web/test/templateTable.dom.test.ts editor/web/src/api/local/templateRepo.ts editor/web/src/api/local/store.ts editor/web/src/api/local/reviewRepo.ts editor/web/test/localReposExtra.dom.test.ts editor/e2e/create.spec.ts editor/e2e/capture_docs.spec.ts vitest.config.ts
git commit -m "feat(web): 作成タブで既存・作成中のテンプレートを開けるようにし、作り直しは確認する。基準日を持たないテンプレートでは基準日を隠す"
```

---

### Task 5: 文書

**Files:**
- Modify: `docs/editor/src/設計正典.md`(中核原則・却下済み設計 #46・rev)
- Modify(git 管理外・コミットしない): `.claude/rules/design-canon-summary.md`、`.claude/rules/editor.md`
- Modify: `docs/editor/src/設計書.md`、`docs/editor/src/Editor_仕様一覧.md`、`docs/editor/src/操作手順書.md`、`docs/editor/src/デプロイ運用手順書.md`
- Regenerate: `docs/editor/editor_設計.html`・`docs/editor/editor_手引き.html`、`docs/editor/images/create-tab.png`(ほか再撮影で変わったもの)

版番号の決め方: 各文書は `rev` の最後の番号の次を足し、`version` も同じ番号にそろえる(今 `version` が `rev` より古い文書もここでそろえる)。

| 文書 | 今の rev の最後 / version | 足す rev | version |
|---|---|---|---|
| 設計正典 | 1.3 / "1.2" | 1.4 | "1.4" |
| 設計書 | 3.0 / "2.8" | 3.1 | "3.1" |
| Editor_仕様一覧 | 1.3 / "1.3" | 1.4 | "1.4"(本文冒頭の「版 1.3」も 1.4) |
| 操作手順書 | 3.6 / "3.6" | 3.7 | "3.7" |
| デプロイ運用手順書 | 1.9 / "1.7" | 2.0 | "2.0" |

- [ ] **Step 0: 撮影の差分を片付ける**

`pnpm run e2e:editor` を走らせ(`docs` project が `docs/editor/images/` を撮り直す。`create-tab.png` は Task 4 で「作成済み・既存のテンプレートを開く」の状態になっている)、`git status --short docs/editor/images` に差分があれば先にコミットする。HTML は作業ツリーの画像を埋め込むので、これを先にしないと HTML と PNG が食い違う。

```bash
git add docs/editor/images
git commit -m "docs(editor): 作成タブの作成済みの表示(既存のテンプレートを開く)を手引きの画像に撮り直す"
```

- [ ] **Step 1: 設計正典を改訂する**

`docs/editor/src/設計正典.md`:
- 「中核原則」の「編集 2 系統」の箇条の次に、箇条を 1 つ足す:

```markdown
- **ID の 2 つの形**: 値入り HTML（`filled/`）は基準日ごとに別物なので `会社_ファンド_基準日_版種`、
  テンプレート（`templates/`）は基準日で使い回さないので `会社_ファンド_版種` で、区切りの数で見分ける
  （`shared/src/domain/template.ts`。`parseTemplateFileName` / `parseSkeletonFileName` /
  `parseAnyTemplateFileName`）。`templates/` は 3 つ区切りだけ、`filled/` は 4 つ区切りだけ、
  `pending/`・下書き・メモ・申請・作成履歴はどちらの形も受け、形はパスを組み立てる関数が強制する。
  `templates/` に残った 4 つ区切りは作成済み・コピー元・一覧に数えない。版の一覧（`filled/` の git
  履歴）は 3 つ区切りに空を返す。作成済みのテンプレートは作成タブから作成経路（`?created=1`）で開き、
  申請 → 承認で上書きする。生成は作成済み・承認待ちの作成申請・同意の無い作業中（下書きか
  `pending/`）を 409 で止め、下書きと `pending/` は生成器が成功した後に捨てる（コメントとパーツ変更
  履歴は残す）。作り直した id の同じタブの編集状態（Undo と下書きの持ち主）も捨てる。
```

- 「交付版⇄全体版 パーツ自動同期」の箇条の `dataRoot/sync/<pairKey>.json` の後に「（`pairKey` はテンプレートが `会社_ファンド`、値入り HTML が `会社_ファンド_基準日`）」を足す。
- 却下済み設計の #46 の箇条(649〜650 行)を次に替える(項目の数は変えない):

```markdown
- **ペア同期の状態ファイルを `filled/` と `templates/` で共有する**: しない。テンプレート（`templates/`）の
  ファイル名は基準日を持たない（`会社_ファンド_版種`）ので、ペアのキー（`templatePairKey`）は
  テンプレートが `会社_ファンド`、値入り HTML が `会社_ファンド_基準日` になり、状態ファイルは別になる。
  1 つにまとめると、基準日の違う値入り HTML の同期状態とテンプレートの同期状態が混ざる。
```

- `rev` に `- 1.4 | 2026-10-03 | テンプレート（templates/）の ID から基準日を外し、ID の 2 つの形・作り直しの守り・却下済み設計 #46 を改訂` を足し、`version` を `"1.4"` にする。

- [ ] **Step 2: 要約とルール(ローカル)を直す**

`.claude/rules/design-canon-summary.md` の editor の却下済み設計の 46 を `46. ペア同期の状態ファイルを `filled/` と `templates/` で共有する` にする。続けて:

```bash
pnpm run check:canon-summary -- --update
pnpm run check:canon-summary
```

Expected: 2 回目が OK。

`.claude/rules/editor.md` の「テンプレ作成タブ（新規作成）」の箇条の最後に「成果物の ID は基準日の無い `会社_ファンド_版種`（`templates/` のファイル名）。編集タブの ID は `会社_ファンド_基準日_版種`（`filled/`）。作成タブから開く既存・作成中のテンプレートも作成経路。」を足し、「雛形:」の後のファイル名を `editor/web/src/api/fixtures/templates/AM01_510037_20240710_交付版.html`（local の fixture。値入り HTML と同じ 4 つ区切り）にする。(どちらも git 管理外。コミットには含めない。)

- [ ] **Step 3: 設計書・仕様一覧・手順書を直す**

`docs/editor/src/設計書.md`:
- 2.1 節の「作成タブの連動プルダウン…」の段落: `creatable` の説明を「作成済みか（テンプレートフォルダ `templates/` に `会社_ファンド_版種.html` があるか。大文字小文字は区別しない。作成済みなら `templateId`、作成済みでなく同じ id の下書きか `pending/` があれば `inProgressId` も返す）」にする。
- 同じ節の「DB の守備範囲」の callout: 「`getTemplate` は `filled/` → `templates/` → `pending/` の順に読む」を「`getTemplate` は id の形で探し先を分け、値入り HTML（4 つ区切り）は `filled/` → `pending/`、テンプレート（3 つ区切り）は `templates/` → `pending/` の順に読む」にする。
- 3.3 節の「テンプレート同一性」: 「`TemplateAttributes`（… / `baseDate` 基準日 yyyymmdd。値入り HTML だけが持つ / …）。ファイル名規約は値入り HTML が `company_fund_date_edition.html`、テンプレートが `company_fund_edition.html` で、区切りの数で見分ける。変換は `shared/src/domain/template.ts`（`templateFileName` / `parseTemplateFileName` / `skeletonFileName` / `parseSkeletonFileName` / `parseAnyTemplateFileName`）の純関数。」にする。
- 4.2 節(264 行付近)の「`getTemplate` は `filled/`（値入り HTML）→ `templates/`（作成タブの Jinja）→ `pending/` の順に探し、`filled/` で見つかれば `html` と `filled` の両方に本文を返す。」を「`getTemplate` は id の形で探し先を分ける。値入り HTML（4 つ区切り）は `filled/` → `pending/`、テンプレート（3 つ区切り）は `templates/` → `pending/`。`filled/` で見つかれば `html` と `filled` の両方に本文を返す。local では承認済みのテンプレートも一覧に `draft` の行として出る（rest の一覧は `filled/` と `pending/` だけ）。」にする。
- 6.1 節(編集 2 系統)の作成タブの説明に「作成済み・作成中のテンプレートは作成タブの『既存のテンプレートを開く』『作成中のテンプレートを開く』から作成経路で開く。作り直しは確認ダイアログで同意を得てから行い、同じタブの編集状態（Undo と下書きの持ち主）も捨てる。基準日を持たないテンプレートでは上部バーと属性欄に基準日を出さない」を足す。
- 7.3 節の「渡すもの」: 「サーバが決めた `baseDate`、」を消し、「テンプレートは基準日を持たないので基準日は渡さない。」を足す。`sourceFundCode` の説明に「生成器は `templates/<会社>_<コピー元>_<版種>.html` を読む」を足す。同じ節に「生成の前に、作成済み・承認待ちの作成申請・同意（`replaceExisting`）の無い作業中を確かめて 409 で止める。同じ id の下書きと `pending/` は生成器が成功した後に捨て、失敗したら残す。コメントとパーツ変更履歴は残す」を足す。
- ペア同期を説明している段落(`pairSyncService` を説明しているところ)に「状態ファイルはテンプレートが `sync/会社_ファンド.json`、値入り HTML が `sync/会社_ファンド_基準日.json`」を足す。
- `rev` に `- 3.1 | 2026-10-03 | テンプレート（templates/）の ID から基準日を外し、作り直しの守りを追加（2.1 節・3.3 節・4.2 節・6.1 節・7.3 節）` を足し、`version` を `"3.1"` にする。

`docs/editor/src/Editor_仕様一覧.md`:
- 画面項目定義の 6 行目(テンプレート作成 / 基準日)を消し、以降の No を詰める。作成タブに 2 行足す:
  - `| <No> | テンプレート作成 | 既存のテンプレートを開く | — | ボタン |  | 作成済み（/templates/creatable の created=true）のときだけ表示。templateId を作成経路（?created=1）の編集画面で開く。このとき「属性から新規作成」「既存のシリーズを元に作成」は押せない |`
  - `| <No> | テンプレート作成 | 作成中のテンプレートを開く | — | ボタン |  | 作成中（/templates/creatable の inProgressId あり）のときだけ表示。inProgressId を作成経路で開く。新規作成・シリーズから作成は押せるが、「作業中の内容を捨てて作り直しますか」と確認し、同意したら replaceExisting=true で生成する |`
- API 表の `/templates/creatable` の応答を「CreatableInfo（created, templateId?（作成済みのときだけ。templates/ のファイルの綴り）, inProgressId?（作業中のときだけ）, seriesFunds[fundCode, fundName, hasTemplate]）」にする。
- `/generate` の行を「GenerateRequest（companyCode, fundCode, editionType, sourceFundCode?, isRedemption?, replaceExisting?）。生成される id は `会社_ファンド_版種`（基準日なし）。作成済みなら 409「作成済みです。既存のテンプレートを開いてください」、承認待ちの作成申請があれば 409「申請中です。承認か却下を待ってください」、同じ id の下書きか pending があり replaceExisting が無ければ 409「作成中のテンプレートがあります」。下書きと pending は生成の成功後に捨てる。sourceFundCode のコピー元テンプレートが無ければ 400」にする。
- `/templates/:templateId/versions` の行に「テンプレート（3 つ区切り）は空の配列」を足す。
- `rev` に `- 1.4 | 2026-10-03 | テンプレートの ID から基準日を外す（作成タブの基準日の項目を削除、既存・作成中を開くボタン、creatable の templateId / inProgressId、generate の 409 の 3 種類と replaceExisting）` を足し、`version` と本文冒頭の「版 1.3」を 1.4 にする。

`docs/editor/src/操作手順書.md` の 4 章:
- 手順 2 の小項目「すでにテンプレートがある会社・ファンド・版種を選ぶと、『作成済みです』という注意が表示されます（基準日は問いません）。」を次の 2 つに替える:
  - 「すでにテンプレートがある会社・ファンド・版種を選ぶと、『作成済みです』という注意と **『既存のテンプレートを開く』** ボタンが表示されます。テンプレートは会社・ファンド・版種ごとに 1 つです。直すときはこのボタンで開き、編集して申請します（承認されると、そのテンプレートが上書きされます）。このとき『属性から新規作成』『既存のシリーズを元に作成』は押せません。」
  - 「作りかけのテンプレート（作成したが、まだ申請・承認していないもの）がある会社・ファンド・版種を選ぶと、『作成中です』という注意と **『作成中のテンプレートを開く』** ボタンが表示されます。続きはこのボタンで開きます。作り直すときは『属性から新規作成』などを押すと『作業中の内容を捨てて作り直しますか』と聞かれます。『作り直す』を押すと、作りかけの内容は捨てられて新しく作られます（コメントと修正履歴は残ります）。」
- 手順 4 の後に注意を 1 つ足す: `> [!INFO] 「申請中です。承認か却下を待ってください」と表示されたときは、同じテンプレートの作成の申請が承認待ちです。承認か却下が済んでから作り直してください。`
- 画像の説明文を `![テンプレート作成タブ：作成済みの会社・ファンド・版種を選ぶと「既存のテンプレートを開く」が出る](images/create-tab.png)` にする。
- 122 行の注意を次に替える(作成タブから開いた既存・作成中のテンプレートも作成経路なのでハイライトが出る):
  `> [!INFO] テンプレート作成タブから開いた編集画面（作成直後・「既存のテンプレートを開く」・「作成中のテンプレートを開く」）では、差し込み値（`{{ }}` の場所）が**薄い色でハイライト表示**されます。これは「あとで実データが入る場所」の目印です。編集タブ（第 3 章）から開いた編集画面では表示されず、実際の値がそのまま本文として見えます。これは故障ではなく仕様です。テンプレートには基準日が無いので、作成タブから開いた編集画面の上部に基準日は表示されません。`
- `rev` に `- 3.7 | 2026-10-03 | テンプレート作成タブ（作成済み・作成中のテンプレートを開く、作り直しの確認、申請中の表示）` を足し、`version` を `"3.7"` にする。

`docs/editor/src/デプロイ運用手順書.md` の 3.2 節に、生成器への入力の約束を 1 段落足す:
「生成器へ渡す属性の JSON は `companyCode`・`fundCode`・`editionType` と、シリーズから作成のときだけ `sourceFundCode`、償還のときだけ `isRedemption`。テンプレートは基準日を持たないので `baseDate` は渡さない。コピー元は `TEMPLATES_DIR` の `<会社コード>_<sourceFundCode>_<版種>.html`（基準日なし）で、生成器はこれを読む。本番の生成器はこの約束に合わせて改修してから、この版の editor を動かす。」
`rev` に `- 2.0 | 2026-10-03 | 生成器への入力から基準日を外し、コピー元のファイル名を基準日なしへ（3.2 節）` を足し、`version` を `"2.0"` にする。

- [ ] **Step 4: 生成と検査**

```bash
py -3.13 docs/_build/build_all.py
pnpm run test:docs
pnpm run check:canon-summary
pnpm run check:comments
```

Expected: いずれも exit 0 / OK。

- [ ] **Step 5: コミット**

```bash
git add docs/editor/src docs/editor/editor_設計.html docs/editor/editor_手引き.html
git commit -m "docs(editor): テンプレートのファイル名から基準日を外し、作り直しの守りを足したことを文書へ反映する"
```

---

### Task 6: 差分パッチを作り、検証して Release に上げる

- [ ] **Step 1: README の追記(note)を作る**

前回の note(`C:\Users\caads\AppData\Local\Temp\claude\C--Users-caads-workspace\a38df4cf-1686-40cd-aa9e-67b1bf36ec57\scratchpad\note-e82.txt`)の DB の手順 a〜c と任意の台帳削除はそのまま残し、先頭に「当てる前」の 2 項目を足した note をスクラッチパッドに作る(`note-e82-skeleton.txt`。UTF-8)。README の手順 4(適用)と 5(start.bat)の間に入るので、適用前の作業は「手順 1 の前に」と明記する:

```
※ 手順 1 より前に(このパッチを当てる前に)次の 2 つを済ませる。
  ・本番の生成器(PY_GENERATE_SCRIPT)を新しい約束へ改修しておく。属性の JSON に baseDate は
    来なくなり、シリーズから作成のコピー元は templates\<会社>_<コピー元ファンド>_<版種>.html
    (基準日なし)を読む。改修前のままだと「シリーズから作成」がコピー元を見つけられない。
  ・念のため、作成タブの申請(承認タブで「作成」の申請)が残っていれば承認か却下で片付けておく。
    テンプレートのファイル名から基準日を外したので、古い名前の申請は承認できない。
※ 次の a〜c を、手順 5 で start.bat を起動する前に済ませる。
a. sproc 2 本(editor\server\db\sproc\template.sql の 委託会社一覧/ファンド一覧、series.sql の 一覧)の
   仮のテーブル名・列名を実際の名前に合わせる(返す列名 AS … は変えない)。
   委託会社略称 は、テンプレートのファイル名に使う会社コード(smtam など)に当たる列にする。
b. DB へ流す(<DBサーバ> は DB_SERVER の値):
     sqlcmd -S <DBサーバ> -d usrap -E -b -f 65001 -i editor\server\db\sproc\template.sql
     sqlcmd -S <DBサーバ> -d usrap -E -b -f 65001 -i editor\server\db\sproc\series.sql
c. 確かめる(会社と略称が返ること):
     sqlcmd -S <DBサーバ> -d usrap -E -f 65001 -Q "EXEC [ug01].[Rep1_運報自動化_Editor_usp_テンプレート] @操作=N'委託会社一覧'"
任意: 使わなくなったテンプレート台帳を消す
     sqlcmd -S <DBサーバ> -d usrap -E -b -f 65001 -i editor\server\db\dev\台帳_削除.sql
```

(別環境は作成タブを使っておらず `templates\` も空なので、ファイルの移行の手順は無い。)

- [ ] **Step 2: パッチを作る**

```bash
py -3.13 local-only/make-source-patch/make_source_patch.py --base e82a5c27677376f4db8ba55de12c7e855c60e9e9 --target HEAD --out C:/Users/caads/AppData/Local/Temp/claude/C--Users-caads-workspace/a38df4cf-1686-40cd-aa9e-67b1bf36ec57/scratchpad/patch-out --note C:/Users/caads/AppData/Local/Temp/claude/C--Users-caads-workspace/a38df4cf-1686-40cd-aa9e-67b1bf36ec57/scratchpad/note-e82-skeleton.txt
```

Expected: `patch-out` に zip と `.sha256` ができる。zip 内の `README.txt` の手順 4 と 5 の間に note が入っている。

- [ ] **Step 3: 検証する(前回の Task 6 と同じ方法)**

1. `git archive e82a5c27677376f4db8ba55de12c7e855c60e9e9` をスクラッチパッドの空フォルダに展開し、別環境と同じ `MANIFEST`(`git -c core.quotepath=false ls-tree -r --name-only e82a5c2`)と `SOURCE-COMMIT`(e82a5c2 のフル SHA ＋ 空白 ＋ `git show -s --format=%cI e82a5c2`。末尾改行なし)を置く。
2. その直下へパッチのフォルダを置き、`apply_patch.bat --dry-run` → 「上書き・追加: N 件 / 削除: M 件」が出る。
3. `apply_patch.bat` で適用する。
4. `HEAD` の `git archive` を別の空フォルダに展開し、生成した `MANIFEST` / `SOURCE-COMMIT` を足したものと `diff -rq` で一致すること(`bk\` は除く)。
5. 2 回目の `apply_patch.bat` が「適用済み」で止まること。`SOURCE-COMMIT` を別の SHA に書き換えた所では中止すること。

- [ ] **Step 4: push を確かめて Release に上げる**

`git ls-remote origin chore/deps-latest-offline-bundle` の SHA が `git rev-parse HEAD` と同じことを確かめる(違えば push の完了を待つか、ユーザーに `! git push` を頼む)。

Release notes(スクラッチパッドの `notes-skeleton.md`):

```markdown
SOURCE-COMMIT が e82a5c2（前回のパッチ `patch-2f88a2e-to-e82a5c2` を当てた環境）を <target7> へ更新する差分パッチ。

当てる前に
- **本番の生成器を新しい約束へ改修しておく**: 属性の JSON に `baseDate` は来なくなり、シリーズから作成のコピー元は `templates\<会社>_<コピー元ファンド>_<版種>.html`（基準日なし）を読む。改修前のままだと「シリーズから作成」がコピー元を見つけられない。
- 念のため、作成タブの申請（承認タブの「作成」の申請）が残っていれば承認か却下で片付けておく。

変更の要点
- 作成タブの委託会社・ファンドの候補を、DB のテンプレート台帳ではなく `Rep1` のファンド属性（`Rep1_投委託会社` / `Rep1_投信ファンド属性`）から取る。usrap の sproc から 3 部名で読む（テーブル名・列名は仮）。
- 委託会社は会社名で表示し、ファイル名の会社コードには Rep1 の委託会社略称を使う。会社名・ファンド名の一部でも絞り込める。
- シリーズから作成は、コピー元のファンドを選んで生成器へ `sourceFundCode` として渡す。コピー元のテンプレートが無い候補は警告して作成できない。償還は `isRedemption` として生成器へ渡す。
- テンプレート（templates\）のファイル名から基準日を外した（`会社_ファンド_版種.html`）。値入り HTML（filled\）は今までどおり基準日を持つ。
- 作成済みのテンプレートは作成タブの「既存のテンプレートを開く」から開いて直す（申請 → 承認で上書き）。作りかけは「作成中のテンプレートを開く」で続きを開き、作り直すときは確認してから行う（作りかけの内容は生成が成功した後に捨て、コメントと修正履歴は残す）。申請中は作り直せない。
- テンプレート台帳（sproc の `候補` / `生成登録`）を使わなくなった。

適用
- 対象は展開先の `SOURCE-COMMIT` の先頭が `e82a5c2` の環境だけ。それ以外では何もせずに中止する。
- 依存（lockfile・requirements）は変更なし。依存バンドルの入れ替えは不要。
- **起動の前に DB の作業が要る**: sproc 2 本（`template.sql` / `series.sql`）の仮のテーブル名・列名を実際の名前に合わせてから流す。手順は zip 内の `README.txt` の a〜c。
- 任意: 使わなくなったテンプレート台帳は `editor\server\db\dev\台帳_削除.sql` で消せる。

前のパッチ patch-e82a5c2-to-936a55c に、テンプレートのファイル名から基準日を外す変更を加えた版。こちらを使う。

https://claude.ai/code/session_01LM2wCfpvPYv6Qt7w4d7frW
```

```bash
gh release create patch-e82a5c2-to-<target7> --target <target のフル SHA> --title "ソース差分パッチ e82a5c2 → <target7>" --notes-file <notes-skeleton.md> --prerelease --latest=false <zip> <zip.sha256>
```

Expected: `gh release view patch-e82a5c2-to-<target7>` に zip と `.sha256` の 2 資産があり、Pre-release になっている。

---

## Self-Review(計画の作成時に実施)

- 仕様の各節 → Task: ID とファイル名(Task 1)/ 置き場ごとの規則(Task 2・3)/ 生成の 4 段の確認と破棄の順序(Task 3、local は Task 4)/ コメントとパーツ変更履歴を残す(Task 3 のテスト)/ 同じタブの編集状態の破棄(Task 4 の `forgetLocalEditState`)/ 作成済み・作成中の画面(Task 4)/ 取得と一覧・版の一覧(Task 2・3)/ 申請と承認(Task 2・3)/ ペア同期(Task 2 のテスト、Task 5 の #46)/ 画面の基準日(Task 4)/ local(Task 4)/ 文書(Task 5)/ エラー処理(Task 3 の 409 の 3 種類)/ 差分パッチと生成器・移行の README(Task 6)。
- 型と名前の一貫性: `findTemplateId(fileNames, companyCode, fundCode, editionType)`、`hasPendingCreateReview(templateId)`、`templateAttributeItems(a)`、`assertFileNameFor(target, fileName)`、`forgetLocalEditState(templateId)`、`createTemplateCreationService(repo, forgetEditState?)`、`CreatableInfo.templateId` / `inProgressId`、`GenerateRequest.replaceExisting` は定義した Task と使う Task で同じ形。
- 各コミットの緑: Task 3 の時点では web が `replaceExisting` を送らないので作業中の作り直しは 409 のトーストになるが、e2e(create.spec)は seed 直後の 1 回目の作成なので通る。ファンド画像の解決(`fundCodeOfTemplateId`)は 3 つ区切りの id が出る Task 3 で直す。
- 各コミットで壊れる既存テストは、その Task の表・箇条で書き換え先を示した。RED にならない追加ケース(confirmedWrite.guard の filled 側、templateTable の空欄)は回帰網と明記した。
