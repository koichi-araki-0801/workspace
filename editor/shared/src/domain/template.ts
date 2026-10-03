// =============================================================================
// template.ts — テンプレート identity の値オブジェクトとファイル名規約の純関数
// =============================================================================
// ファイル名規約は 2 つで、区切りの数で見分ける。値入り HTML(`filled/`)は基準日ごとに別物なので
// `company_fund_date_edition.html`、テンプレート(`templates/`)は基準日で使い回さないので
// `company_fund_edition.html`。純粋・依存なしなので `web` と `server` の双方で再利用できる。

// `../errors.js` を barrel(`../index.js`)経由でなく直接引くのは循環 import を避けるため
// (index は本ファイルを再輸出する)。型のみの `TemplateAttributes` は消去されるので barrel で良い。
import { validation } from '../errors.js';
import type { TemplateAttributes } from '../index.js';

// 各トークンから `/` `\` を除くのは、この正規表現がファイル名規約の記述であると同時に
// パス安全性のゲートとしても使われるため(`[^_]+` のままだと `../../x` が 1 トークンとして
// 通り、`path.join` 連結でディレクトリを脱出できた)。版種は非ASCII(`交付版` 等)を含みうるので
// 許可文字を列挙する形には寄せられない。
export const TEMPLATE_FILENAME_RE =
  /^(?<companyCode>[^_/\\]+)_(?<fundCode>[^_/\\]+)_(?<baseDate>[^_/\\]+)_(?<editionType>[^_/\\]+)\.html$/;

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

export function templateIdFromFileName(fileName: string): string {
  return fileName.replace(/\.html$/, '');
}

// ── 交付版⇄全体版 ペア解決 ──
// 同一の会社/ファンド/基準日で版種だけが異なる 2 テンプレートを「ペア」と呼び、確定保存の
// 承認直後にパーツ単位の自動同期(server の `sync/partSync.ts`)を掛ける。版種は自由文字列の
// ままだが(旧 `kr`/`zr` 等の残存資産を壊さない)、ペアとして扱うのは下表の 2 値に限る。

/**
 * 自動同期のペアとみなす版種の相互対応。ここに無い版種はペア無し(同期対象外)。
 *
 * `Object.create(null)` で組む(null プロトタイプ)。プレーンなオブジェクトリテラルだと
 * `EDITION_SYNC_PAIRS[attrs.editionType]` は `Object.prototype` の継承キー(`constructor` /
 * `toString` 等)も解決してしまい、`pairedTemplateId` はリクエスト由来の `templateId`
 * (`GET /templates/:templateId/notes` 経由)から `editionType` を素通しでここへ渡す入口の
 * 1 つ — 本ファイルが持つ「利用者入力で引く表は null プロトタイプにする」という不変則の対象。
 */
export const EDITION_SYNC_PAIRS: Readonly<Record<string, string>> = Object.assign(
  Object.create(null),
  {
    交付版: '全体版',
    全体版: '交付版',
  },
);

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

/**
 * ファイル名規約の基準日(yyyymmdd)を帳票の表示形式 `YYYY年M月D日` へ整える(書式は
 * `sampleCommon.report` の他の日付と統一)。8 桁数字でない値は規約外の残存資産でありうる
 * ため壊さずそのまま返す — これは表示用の整形であって検証ゲートではない。
 */
export function formatBaseDate(baseDate: string): string {
  const m = /^(\d{4})(\d{2})(\d{2})$/.exec(baseDate);
  if (!m) return baseDate;
  return `${m[1]}年${Number(m[2])}月${Number(m[3])}日`;
}

// ── パス安全性のゲート ──
// templateId / fundCode はリクエスト由来のまま `path.join` でディレクトリへ連結される
// (`server/src/files/*`)。連結する側ごとに検査すると必ず取りこぼすので、ここで純関数として
// 一元定義し、I/O 層の入口で強制する。`node:path` に依存しないのは web からも使うため。

/**
 * 単一のファイル名セグメントとして安全か。パス区切り・`..`・制御文字に加え、Windows で
 * 特別扱いされる字面(ドライブ指定子 `:`・ワイルドカード・末尾ドット/空白)も落とす。
 */
function isSafeFileNameSegment(s: string): boolean {
  if (s.length === 0 || s.length > 200) return false;
  if (/[/\\:*?"<>|]/.test(s)) return false;
  // biome-ignore lint/suspicious/noControlCharactersInRegex: NUL 混入によるパス切り詰めを防ぐ意図的な検査。
  if (/[\u0000-\u001f]/.test(s)) return false;
  if (s.includes('..')) return false;
  // 末尾のドット/空白は Windows が黙って落とすため、検査をすり抜けた別名になりうる。
  if (s !== s.trim() || s.endsWith('.')) return false;
  // Windows の予約デバイス名は拡張子付き(`CON.html`)でもデバイスとして扱われる。
  if (/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\..*)?$/i.test(s)) return false;
  return true;
}

/**
 * ファイル名規約の 1 トークン(`companyCode` / `fundCode` / `baseDate` / `editionType`)として
 * 安全か。`_` を弾くのはトークン区切りだから(正当な値には現れない)。
 *
 * **セグメント検査は組み立て済みファイル名ではなくトークンごとに掛ける。** 全体にだけ
 * 掛けると `AM01 _510037_20240710_交付版.html` が通る — トークン内部の末尾空白は
 * ファイル名全体の trim では消えないのに、SQL Server の `=` は末尾空白を無視するので
 * 「ファイルは 2 つ・台帳は 1 行」の食い違いを作れる。
 */
export function isValidTemplateToken(token: string): boolean {
  return isSafeFileNameSegment(token) && !token.includes('_');
}

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

/**
 * ファンドコードが単一セグメントとして安全か。要求はファイル名規約の 1 トークンと同一なので
 * `isValidTemplateToken` へ委譲する(判定を 2 本持つと片方だけが緩む)。
 */
export function isValidFundCode(fundCode: string): boolean {
  return isValidTemplateToken(fundCode);
}

/**
 * ペアキー(`templatePairKey` の形。テンプレートは `companyCode_fundCode`、値入り HTML は
 * `companyCode_fundCode_baseDate`)が全体・トークン単位ともに安全か。`syncFiles.ts` が
 * `sync/<pairKey>.json` へ連結する前の検査に使う。
 */
export function isValidPairKey(pairKey: string): boolean {
  const tokens = pairKey.split('_');
  return (tokens.length === 2 || tokens.length === 3) && tokens.every(isValidTemplateToken);
}

/** `isValidPairKey` に通らなければ `validation` を投げ、通れば入力をそのまま返す。 */
export function assertPairKey(pairKey: string): string {
  if (!isValidPairKey(pairKey)) {
    throw validation(`不正な同期キーです: ${pairKey}`);
  }
  return pairKey;
}

/** `isValidTemplateId` に通らなければ `validation` を投げ、通れば入力をそのまま返す。 */
export function assertTemplateId(templateId: string): string {
  if (!isValidTemplateId(templateId)) {
    throw validation(`不正なテンプレート id です: ${templateId}`);
  }
  return templateId;
}

/** `isValidAnyTemplateId` に通らなければ `validation` を投げ、通れば入力をそのまま返す。 */
export function assertAnyTemplateId(templateId: string): string {
  if (!isValidAnyTemplateId(templateId)) {
    throw validation(`不正なテンプレート id です: ${templateId}`);
  }
  return templateId;
}

/** `isValidFundCode` に通らなければ `validation` を投げ、通れば入力をそのまま返す。 */
export function assertFundCode(fundCode: string): string {
  if (!isValidFundCode(fundCode)) {
    throw validation(`不正なファンドコードです: ${fundCode}`);
  }
  return fundCode;
}

/**
 * ファイル名規約の 1 トークンを検査して返す(`label` はユーザー向け文言に使う)。
 * テンプレ生成のように「ファイル名を組み立てる前のトークン」を受ける入口はここを通す —
 * 検査を各ルートのローカル関数へ複製すると、複製されなかった入口だけが緩む。
 */
export function assertTemplateAttributeToken(label: string, value: string): string {
  if (!isValidTemplateToken(value)) throw validation(`不正な${label}です: ${value}`);
  return value;
}

/**
 * 値入り HTML のファイル名(4 つ区切り)として安全か検査し、正規化した名前を返す。
 * 台帳やディレクトリ走査で得た名前も、書き込み先に使う前にここを通す。
 * 検査はファイル名全体と**4 トークンそれぞれ**の両方に掛ける(`isValidTemplateToken`)。
 */
export function assertTemplateFileName(fileName: string): string {
  const attrs = parseTemplateFileName(fileName);
  if (!attrs || !isSafeFileNameSegment(fileName) || !attributesAreSafe(attrs)) {
    throw validation(`不正なテンプレートファイル名です: ${fileName}`);
  }
  return templateFileName(attrs);
}

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
