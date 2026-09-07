// =============================================================================
// sprocFake.ts — ゲートウェイ sproc 7 本の in-memory 実装
// =============================================================================
// `createSprocClient(query)` の `query` として差し込み、rest モードのサーバを DB 無しで
// 動かす。写すのは SQL ではなく sproc の**不変則**で、外すと rest e2e が偽の挙動を検証する:
//   - `ユーザー/PW初期化` は除外セッション以外の失効までを 1 操作で行う(パスワードだけ
//     変わって旧セッションが生きている中間状態を作らない)。
//   - `ユーザー/PWリセット` はそのユーザーの全セッション失効 + `要パスワード変更`=1。
//   - `ユーザー/作成` は重複ログインID を 50409 で断り、`要パスワード変更` の既定は 1。
//   - `ユーザー/更新` は NULL を据え置く(COALESCE)。
//   - `セッション/取得` は `失効=0` かつ `有効期限 > now` の行だけを返す。
//   - `テンプレート/生成登録` は冪等。
// エラーは `AppError` ではなく `number` を持つ生 SQL エラー相当を throw する。種別への
// 変換は `createSprocClient` の中の `mapSqlError` が 1 回だけ行う。
// 状態はすべて `createFakeQuery` のクロージャに閉じるので、フェイクを 2 つ作れば 2 つの
// 独立した DB になる(モジュール変数を持たない)。
import type { UserRole } from '@editor/shared';
import { parseTemplateFileName } from '@editor/shared';
import { hashPassword } from '../../src/auth/password.js';
import { createSprocClient, type QueryFn, type Row, type SprocClient } from '../../src/db/sproc.js';
import { SP } from '../../src/db/sprocNames.js';

// ── 1. seed の型と既定値 ──

export interface FakeUserSeed {
  username: string;
  displayName: string;
  role: UserRole;
  /** seed ユーザーの平文パスワード。rest e2e のログインで使う。 */
  password: string;
}
export interface FakeFundSeed {
  code: string;
  name: string;
  nickname: string;
  companyCode: string;
  companyName: string;
}
export interface FakePartSeed {
  id: string;
  category: string;
  majorClass: string;
  middleClass: string;
  minorClass: string;
  name: string;
  content: string;
  syncDefault: string | null;
  masterReflectDefault: string | null;
}
export interface FakeSeed {
  users?: readonly FakeUserSeed[];
  funds?: readonly FakeFundSeed[];
  /** 台帳へ載せるテンプレートID(ファイル名の stem)。属性はここから解析する。 */
  templateIds?: readonly string[];
  parts?: readonly FakePartSeed[];
}

// 自己承認は職務分掌で拒否されるので、申請者と承認者は別人が要る。パスワードはユーザー名と
// 同じにする: local の fixtures(users.json)と同じ規約なので、e2e の `login(page, user)` が
// local / rest のどちらでも同じ引数で通る。
// displayName は local fixtures とは意図的に別値にしてある(例: approver は「承認 花子」だが
// local の精査担当は「精査花子」)。local/rest の両方を走らせる共有 spec は displayName の
// 文言を assert しないこと。
export const DEFAULT_USERS: readonly FakeUserSeed[] = [
  { username: 'editor', displayName: '編集 太郎', role: 'editor', password: 'editor' },
  { username: 'approver', displayName: '承認 花子', role: 'approver', password: 'approver' },
  { username: 'admin', displayName: '管理 次郎', role: 'admin', password: 'admin' },
];

// ファンドマスタが無いと `parseFundMaster` が undefined を返し、画面のファンド名が空になる。
// コードは `editor/web/src/api/fixtures/sample/*.json` と一致させる(dataRoot 側の seed が
// 同じファンドのテンプレートを置くため)。
const TRUST_AM = '三井住友トラスト・アセットマネジメント株式会社';
export const DEFAULT_FUNDS: readonly FakeFundSeed[] = [
  {
    code: '110024',
    name: '高金利ソブリンオープン',
    nickname: '',
    companyCode: 'AM01',
    companyName: TRUST_AM,
  },
  {
    code: '510003',
    name: 'コア投資戦略ファンド（安定型）',
    nickname: 'コアラップ（安定型）',
    companyCode: 'AM01',
    companyName: TRUST_AM,
  },
  {
    code: '510037',
    name: 'コア投資戦略ファンド（切替型）',
    nickname: 'コアラップ（切替型）',
    companyCode: 'AM01',
    companyName: TRUST_AM,
  },
  {
    code: '510124',
    name: 'ＳＭＴ ＪＰＸ日経中小型株インデックス・オープン',
    nickname: '',
    companyCode: 'AM01',
    companyName: TRUST_AM,
  },
  {
    code: '510155',
    name: 'コア投資戦略ファンド（切替型ワイド）',
    nickname: 'コアラップ（切替型ワイド）',
    companyCode: 'AM01',
    companyName: TRUST_AM,
  },
];

// `editor/web/src/api/fixtures/templates/*.html` と同じ 8 件。候補・系列の値がここから出る。
export const DEFAULT_TEMPLATE_IDS: readonly string[] = [
  'AM01_110024_20251117_交付版',
  'AM01_110024_20251117_全体版',
  'AM01_510003_20250710_全体版',
  'AM01_510037_20240710_交付版',
  'AM01_510037_20240710_全体版',
  'AM01_510124_20251020_交付版',
  'AM01_510124_20251020_全体版',
  'AM01_510155_20240710_交付版',
];

// 既定は「未判断」= ペア同期も次回反映もしない。承認フローで機械転写が勝手に走らない側へ倒す。
const DEFAULT_PARTS: readonly FakePartSeed[] = [
  {
    id: 'p-cover-title',
    category: '表紙',
    majorClass: '見出し',
    middleClass: 'タイトル',
    minorClass: '標準',
    name: '表紙タイトル',
    content: '<h1>運用報告書</h1>',
    syncDefault: null,
    masterReflectDefault: null,
  },
  {
    id: 'p-note-tax',
    category: '注記',
    majorClass: '税制',
    middleClass: '個人',
    minorClass: '標準',
    name: '税制の注記',
    content: '<p>税制は変更される場合があります。</p>',
    syncDefault: null,
    masterReflectDefault: null,
  },
];

// ── 2. 行の形と補助 ──

interface UserRow {
  公開ID: string;
  ログインID: string;
  表示名: string;
  ロール: string;
  無効: number;
  要パスワード変更: number;
  PWハッシュ: Buffer;
  PWソルト: Buffer;
  PW反復回数: number;
  作成順: number;
}
interface SessionRow {
  セッションID: string;
  ログインID: string;
  有効期限: Date;
  失効: number;
  最終アクセス: Date;
}
interface TemplateRow {
  テンプレートID: string;
  委託会社コード: string;
  ファンドコード: string;
  基準日: string;
  版種: string;
  ファイル名: string;
  状態: string;
  更新日時: string | null;
  更新者: string | null;
}
interface NoteRow {
  パーツID: string;
  ファンドコード: string;
  版種: string;
  注記HTML: string | null;
  更新者: string | null;
  順: number;
}

type Args = Map<string, unknown>;

/** `number` を持つ生 SQL エラー相当。`mapSqlError` はこの番号だけで種別を決める。 */
function sqlError(number: number, message: string): Error {
  return Object.assign(new Error(message), { number });
}

const text = (a: Args, k: string): string =>
  typeof a.get(k) === 'string' && a.get(k) !== '' ? (a.get(k) as string) : '';
const optText = (a: Args, k: string): string | null =>
  typeof a.get(k) === 'string' ? (a.get(k) as string) : null;
const bit = (v: unknown): number | undefined => (v == null ? undefined : v ? 1 : 0);
const int = (v: unknown): number | undefined => (typeof v === 'number' ? v : undefined);
const bin = (v: unknown): Buffer => (Buffer.isBuffer(v) ? v : Buffer.alloc(0));

/** `EXEC <proc> @a=?, @b=?` と位置指定の値から、proc 名と 名前→値 の対応を組む。 */
function parseCall(sql: string, values: unknown[]): { proc: string; args: Args } {
  const m = /^EXEC (\S+)(?: (@.*))?$/.exec(sql);
  if (!m) throw sqlError(50000, `フェイクが解釈できない SQL です: ${sql}`);
  const names = [...(m[2] ?? '').matchAll(/@([^=,\s]+)=\?/g)].map((x) => x[1]);
  const args: Args = new Map();
  for (const [i, name] of names.entries()) args.set(name, values[i] ?? null);
  return { proc: m[1], args };
}

// ── 3. 実行面 ──

export async function createFakeQuery(seed: FakeSeed = {}): Promise<QueryFn> {
  const users = new Map<string, UserRow>();
  const sessions = new Map<string, SessionRow>();
  const templates = new Map<string, TemplateRow>();
  const notes = new Map<string, NoteRow>();
  const funds = new Map<string, FakeFundSeed>();
  const parts = [...(seed.parts ?? DEFAULT_PARTS)];
  // 台帳の IDENTITY 相当。一覧の並び(作成順・注記内部ID順)がここから出る。
  let order = 0;

  const userSeeds = seed.users ?? DEFAULT_USERS;
  // KDF は 1 件 100ms 級なので、seed 件数ぶん直列に待たない(行の並びは後で seed 順に組む)。
  const hashes = await Promise.all(userSeeds.map((u) => hashPassword(u.password)));
  userSeeds.forEach((u, i) => {
    const { hash, salt, iterations } = hashes[i];
    users.set(`u-${u.username}`, {
      公開ID: `u-${u.username}`,
      ログインID: u.username,
      表示名: u.displayName,
      ロール: u.role,
      無効: 0,
      要パスワード変更: 0,
      PWハッシュ: hash,
      PWソルト: salt,
      PW反復回数: iterations,
      作成順: order++,
    });
  });
  for (const f of seed.funds ?? DEFAULT_FUNDS) funds.set(f.code, f);
  for (const id of seed.templateIds ?? DEFAULT_TEMPLATE_IDS) {
    const attrs = parseTemplateFileName(`${id}.html`);
    if (!attrs) continue;
    templates.set(id, {
      テンプレートID: id,
      委託会社コード: attrs.companyCode,
      ファンドコード: attrs.fundCode,
      基準日: attrs.baseDate,
      版種: attrs.editionType,
      ファイル名: `${id}.html`,
      状態: 'published',
      更新日時: null,
      更新者: null,
    });
  }

  /** 台帳の公開列だけを写す(ハッシュ列は `認証情報取得` 以外へ出さない)。 */
  const publicUser = (r: UserRow): Row => ({
    公開ID: r.公開ID,
    ログインID: r.ログインID,
    表示名: r.表示名,
    ロール: r.ロール,
    無効: r.無効,
    要パスワード変更: r.要パスワード変更,
  });
  const byLoginId = (loginId: string): UserRow | undefined =>
    [...users.values()].find((u) => u.ログインID === loginId);

  function userOp(op: string, a: Args): Row[] {
    if (op === '一覧')
      return [...users.values()].sort((x, y) => x.作成順 - y.作成順).map(publicUser);

    if (op === '作成') {
      const 公開ID = text(a, '公開ID');
      const ログインID = text(a, 'ログインID');
      const 表示名 = text(a, '表示名');
      const ロール = text(a, 'ロール');
      if (!公開ID || !ログインID || !表示名 || !ロール)
        throw sqlError(50000, '公開ID・ログインID・表示名・ロール が必要です');
      if (byLoginId(ログインID)) throw sqlError(50409, 'このログインIDは既に使われています');
      // `公開ID` の重複は自前 THROW でなく主キー違反として届く。番号が違えば `mapSqlError` の
      // 経路も違う(2627 は文言を転送せず定型文へ倒す)ので、そこまで写す。
      if (users.has(公開ID))
        throw sqlError(
          2627,
          "Violation of PRIMARY KEY constraint 'PK_ユーザー'. Cannot insert duplicate key.",
        );
      const row: UserRow = {
        公開ID,
        ログインID,
        表示名,
        ロール,
        無効: bit(a.get('無効')) ?? 0,
        要パスワード変更: bit(a.get('要パスワード変更')) ?? 1,
        PWハッシュ: bin(a.get('PWハッシュ')),
        PWソルト: bin(a.get('PWソルト')),
        PW反復回数: int(a.get('PW反復回数')) ?? 0,
        作成順: order++,
      };
      users.set(公開ID, row);
      return [publicUser(row)];
    }

    if (op === '更新') {
      const 公開ID = text(a, '公開ID');
      if (!公開ID) throw sqlError(50000, '公開ID が必要です');
      const row = users.get(公開ID);
      if (!row) throw sqlError(50404, 'ユーザーが見つかりません');
      // COALESCE と同じで、NULL は据え置き。
      row.表示名 = optText(a, '表示名') ?? row.表示名;
      row.ロール = optText(a, 'ロール') ?? row.ロール;
      row.無効 = bit(a.get('無効')) ?? row.無効;
      row.要パスワード変更 = bit(a.get('要パスワード変更')) ?? row.要パスワード変更;
      return [publicUser(row)];
    }

    if (op === 'PWリセット') {
      const 公開ID = text(a, '公開ID');
      if (!公開ID || !Buffer.isBuffer(a.get('PWハッシュ')) || !Buffer.isBuffer(a.get('PWソルト')))
        throw sqlError(50000, '公開ID・仮ハッシュ が必要です');
      const row = users.get(公開ID);
      if (!row) throw sqlError(50404, 'ユーザーが見つかりません');
      row.PWハッシュ = bin(a.get('PWハッシュ'));
      row.PWソルト = bin(a.get('PWソルト'));
      row.PW反復回数 = int(a.get('PW反復回数')) ?? row.PW反復回数;
      row.要パスワード変更 = 1;
      // 管理者リセットは乗っ取り疑いの経路なので、除外なしで全セッションを失効させる。
      // 資格情報の差し替えと失効は不可分(片方だけが残ると守りが無効になる)。
      for (const s of sessions.values()) if (s.ログインID === row.ログインID) s.失効 = 1;
      return [];
    }

    if (op === '認証情報取得') {
      const ログインID = text(a, 'ログインID');
      if (!ログインID) throw sqlError(50000, 'ログインID が必要です');
      const row = byLoginId(ログインID);
      return row
        ? [
            {
              ...publicUser(row),
              PWハッシュ: row.PWハッシュ,
              PWソルト: row.PWソルト,
              PW反復回数: row.PW反復回数,
            },
          ]
        : [];
    }

    if (op === 'PW初期化') {
      const ログインID = text(a, 'ログインID');
      if (
        !ログインID ||
        !Buffer.isBuffer(a.get('PWハッシュ')) ||
        !Buffer.isBuffer(a.get('PWソルト'))
      )
        throw sqlError(50000, 'ログインID・新ハッシュ が必要です');
      const row = byLoginId(ログインID);
      if (!row) throw sqlError(50404, 'ユーザーが見つかりません');
      row.PWハッシュ = bin(a.get('PWハッシュ'));
      row.PWソルト = bin(a.get('PWソルト'));
      row.PW反復回数 = int(a.get('PW反復回数')) ?? row.PW反復回数;
      row.要パスワード変更 = 0;
      // 操作中の自分だけ残して他端末を蹴る。書き換えと失効は同一操作で行う。
      const except = optText(a, '除外セッションID') ?? '';
      for (const s of sessions.values())
        if (s.ログインID === ログインID && s.失効 === 0 && s.セッションID !== except) s.失効 = 1;
      return [];
    }

    throw sqlError(50000, '未知の @操作 です(ユーザー)');
  }

  function sessionOp(op: string, a: Args): Row[] {
    if (op === '作成') {
      const セッションID = text(a, 'セッションID');
      const ログインID = text(a, 'ログインID');
      const 有効期限 = a.get('有効期限');
      if (!セッションID || !ログインID || !(有効期限 instanceof Date))
        throw sqlError(50000, 'セッションID・ログインID・有効期限 が必要です');
      sessions.set(セッションID, {
        セッションID,
        ログインID,
        有効期限,
        失効: 0,
        最終アクセス: new Date(),
      });
      return [];
    }

    if (op === '取得') {
      const セッションID = text(a, 'セッションID');
      if (!セッションID) throw sqlError(50000, 'セッションID が必要です');
      const s = sessions.get(セッションID);
      if (!s || s.失効 === 1 || s.有効期限.getTime() <= Date.now()) return [];
      s.最終アクセス = new Date();
      const u = byLoginId(s.ログインID);
      return u ? [publicUser(u)] : [];
    }

    if (op === '失効') {
      const セッションID = text(a, 'セッションID');
      if (!セッションID) throw sqlError(50000, 'セッションID が必要です');
      const s = sessions.get(セッションID);
      if (s) s.失効 = 1;
      return [];
    }

    if (op === '全失効') {
      for (const s of sessions.values()) s.失効 = 1;
      return [];
    }

    if (op === '掃除') {
      const 保持日数 = int(a.get('保持日数'));
      if (保持日数 === undefined) throw sqlError(50000, '保持日数 が必要です');
      // 境界は「有効期限が保持日数ぶん過去」。now 単体にすると期限内の行まで消える。
      const border = Date.now() - 保持日数 * 86_400_000;
      for (const [id, s] of sessions) if (s.有効期限.getTime() < border) sessions.delete(id);
      return [];
    }

    throw sqlError(50000, '未知の @操作 です(セッション)');
  }

  function templateOp(op: string, a: Args): Row[] {
    const rows = [...templates.values()];
    if (op === '候補') {
      const company = optText(a, '委託会社コード');
      const fund = optText(a, 'ファンドコード');
      const base = optText(a, '基準日');
      // 各候補は「自分より上位の選択」だけで絞る(自分自身・下位は含めない)。そうしないと
      // 版種を選んだ後にその版種だけへ候補が潰れ、別の版種へ戻せない。
      const out: Row[] = [];
      const push = (区分: string, 値: string) => {
        if (!out.some((r) => r.区分 === 区分 && r.値 === 値)) out.push({ 区分, 値 });
      };
      for (const r of rows) push('会社', r.委託会社コード);
      for (const r of rows)
        if (!company || r.委託会社コード === company) push('ファンド', r.ファンドコード);
      for (const r of rows)
        if ((!company || r.委託会社コード === company) && (!fund || r.ファンドコード === fund))
          push('基準日', r.基準日);
      for (const r of rows)
        if (
          (!company || r.委託会社コード === company) &&
          (!fund || r.ファンドコード === fund) &&
          (!base || r.基準日 === base)
        )
          push('版種', r.版種);
      return out.sort(
        (x, y) =>
          String(x.区分).localeCompare(String(y.区分)) || String(x.値).localeCompare(String(y.値)),
      );
    }

    if (op === '系列') {
      const company = text(a, '委託会社コード');
      const edition = text(a, '版種');
      if (!company || !edition) throw sqlError(50000, '委託会社コードと版種が必要です');
      return rows
        .filter((r) => r.委託会社コード === company && r.版種 === edition)
        .sort(
          (x, y) =>
            x.ファンドコード.localeCompare(y.ファンドコード) || x.基準日.localeCompare(y.基準日),
        )
        .map((r) => ({ ...r }));
    }

    if (op === '生成登録') {
      const id = text(a, 'テンプレートID');
      const 委託会社コード = text(a, '委託会社コード');
      const ファンドコード = text(a, 'ファンドコード');
      const 基準日 = text(a, '基準日');
      const 版種 = text(a, '版種');
      const ファイル名 = text(a, 'ファイル名');
      if (!id || !委託会社コード || !ファンドコード || !基準日 || !版種 || !ファイル名)
        throw sqlError(50000, '生成登録には属性4とファイル名が必要です');
      // 冪等。既に在る行は触らない。
      if (!templates.has(id))
        templates.set(id, {
          テンプレートID: id,
          委託会社コード,
          ファンドコード,
          基準日,
          版種,
          ファイル名,
          状態: 'draft',
          更新日時: null,
          更新者: null,
        });
      return [];
    }

    throw sqlError(50000, '未知の @操作 です(テンプレート)');
  }

  function partOp(op: string, a: Args): Row[] {
    const category = optText(a, 'カテゴリ');
    const major = optText(a, '大分類');
    const middle = optText(a, '中分類');
    const minor = optText(a, '小分類');
    if (op === '分類候補') {
      const out: Row[] = [];
      const push = (区分: string, 値: string) => {
        if (!out.some((r) => r.区分 === 区分 && r.値 === 値)) out.push({ 区分, 値 });
      };
      for (const q of parts) push('カテゴリ', q.category);
      for (const q of parts) if (!category || q.category === category) push('大分類', q.majorClass);
      for (const q of parts)
        if ((!category || q.category === category) && (!major || q.majorClass === major))
          push('中分類', q.middleClass);
      for (const q of parts)
        if (
          (!category || q.category === category) &&
          (!major || q.majorClass === major) &&
          (!middle || q.middleClass === middle)
        )
          push('小分類', q.minorClass);
      return out;
    }

    if (op === '一覧') {
      return parts
        .filter(
          (q) =>
            (!category || q.category === category) &&
            (!major || q.majorClass === major) &&
            (!middle || q.middleClass === middle) &&
            (!minor || q.minorClass === minor),
        )
        .map((q) => ({
          パーツID: q.id,
          カテゴリ: q.category,
          大分類: q.majorClass,
          中分類: q.middleClass,
          小分類: q.minorClass,
          名称: q.name,
          説明: '',
          使用上の注意: '',
          内容HTML: q.content,
          更新日時: null,
          更新者: null,
          同期既定: q.syncDefault,
          次回反映既定: q.masterReflectDefault,
        }));
    }

    throw sqlError(50000, '未知の @操作 です(パーツ)');
  }

  function sampleOp(op: string, a: Args): Row[] {
    if (op === '取得') {
      const code = text(a, 'ファンドコード');
      if (!code) throw sqlError(50000, 'ファンドコード が必要です');
      const f = funds.get(code);
      // `parseFundMaster` が読む形。欠けるとファンド名が空になる。
      return f
        ? [
            {
              データJSON: JSON.stringify({
                fund: { name: f.name, nickname: f.nickname },
                company: { code: f.companyCode, name: f.companyName },
              }),
            },
          ]
        : [];
    }
    throw sqlError(50000, '未知の @操作 です(サンプルデータ)');
  }

  function noteMasterOp(op: string, a: Args): Row[] {
    const key = (パーツID: string, ファンドコード: string, 版種: string) =>
      [パーツID, ファンドコード, 版種].join('\x00');
    if (op === '取得') {
      const ファンドコード = text(a, 'ファンドコード');
      const 版種 = text(a, '版種');
      if (!ファンドコード || !版種) throw sqlError(50000, 'ファンドコードと版種が必要です');
      return [...notes.values()]
        .filter((n) => n.ファンドコード === ファンドコード && n.版種 === 版種)
        .sort((x, y) => x.順 - y.順)
        .map((n) => ({ パーツID: n.パーツID, 注記HTML: n.注記HTML }));
    }
    if (op === '反映') {
      const パーツID = text(a, 'パーツID');
      const ファンドコード = text(a, 'ファンドコード');
      const 版種 = text(a, '版種');
      if (!パーツID || !ファンドコード || !版種)
        throw sqlError(50000, 'パーツID・ファンドコード・版種が必要です');
      const k = key(パーツID, ファンドコード, 版種);
      const prev = notes.get(k);
      notes.set(k, {
        パーツID,
        ファンドコード,
        版種,
        注記HTML: optText(a, '注記HTML'),
        更新者: optText(a, '更新者'),
        順: prev?.順 ?? order++,
      });
      return [];
    }
    throw sqlError(50000, '未知の @操作 です(注記マスタ)');
  }

  function auditOp(op: string, a: Args): Row[] {
    if (op === '登録') {
      // 行は保持しない(監査の source of truth はファイルログ)。必須列の欠落だけを写す。
      if (!text(a, 'イベント') || !text(a, '結果') || !text(a, '実行者'))
        throw sqlError(50000, 'イベント・結果・実行者 が必要です');
      return [];
    }
    throw sqlError(50000, '未知の @操作 です(監査ログ)');
  }

  return async (sql, values) => {
    const { proc, args } = parseCall(sql, values);
    const op = String(args.get('操作') ?? '');
    switch (proc) {
      case SP.user:
        return userOp(op, args);
      case SP.session:
        return sessionOp(op, args);
      case SP.template:
        return templateOp(op, args);
      case SP.part:
        return partOp(op, args);
      case SP.sample:
        return sampleOp(op, args);
      case SP.noteMaster:
        return noteMasterOp(op, args);
      case SP.audit:
        return auditOp(op, args);
      default:
        throw sqlError(50000, `フェイクが知らない sproc です: ${proc}`);
    }
  };
}

/** フェイクの実行面を本番と同じ `createSprocClient` で包む(変換は `mapSqlError` が 1 回)。 */
export async function createFakeSproc(seed: FakeSeed = {}): Promise<SprocClient> {
  return createSprocClient(await createFakeQuery(seed));
}
