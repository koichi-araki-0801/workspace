// =============================================================================
// template.ts — テンプレート identity の値オブジェクトとファイル名規約の純関数
// =============================================================================
// ファイル名規約は `company_fund_date_edition.html`。純粋・依存なしなので `web` と
// `server` の双方で再利用できる。

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

export function parseTemplateFileName(fileName: string): TemplateAttributes | null {
  const m = TEMPLATE_FILENAME_RE.exec(fileName);
  if (!m?.groups) return null;
  const { companyCode, fundCode, baseDate, editionType } = m.groups;
  return { companyCode, fundCode, baseDate, editionType };
}

export function templateFileName(a: TemplateAttributes): string {
  return `${a.companyCode}_${a.fundCode}_${a.baseDate}_${a.editionType}.html`;
}

export function templateIdFromFileName(fileName: string): string {
  return fileName.replace(/\.html$/, '');
}

// ── 交付版⇄全体版 ペア解決 ──
// 同一の会社/ファンド/基準日で版種だけが異なる 2 テンプレートを「ペア」と呼び、確定保存の
// 承認直後にパーツ単位の自動同期(server の `sync/partSync.ts`)を掛ける。版種は自由文字列の
// ままだが(旧 `kr`/`zr` 等の残存資産を壊さない)、ペアとして扱うのは下表の 2 値に限る。

/** 自動同期のペアとみなす版種の相互対応。ここに無い版種はペア無し(同期対象外)。 */
export const EDITION_SYNC_PAIRS: Readonly<Record<string, string>> = {
  交付版: '全体版',
  全体版: '交付版',
};

/**
 * テンプレート ID から同期ペアの ID を導く。版種がペア対象外・ID が規約外なら null。
 * ペア実体(ファイル)の存在確認は呼び出し側の責務(ここは純粋な名前変換のみ)。
 */
export function pairedTemplateId(templateId: string): string | null {
  const attrs = parseTemplateFileName(`${templateId}.html`);
  if (!attrs) return null;
  const paired = EDITION_SYNC_PAIRS[attrs.editionType];
  if (!paired) return null;
  return templateIdFromFileName(templateFileName({ ...attrs, editionType: paired }));
}

/** ペア単位の識別子(版種を除いた 3 属性)。同期状態ファイル `sync/<pairKey>.json` の名に使う。 */
export function templatePairKey(a: TemplateAttributes): string {
  return `${a.companyCode}_${a.fundCode}_${a.baseDate}`;
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

/** `TemplateAttributes` の 4 トークンがすべて安全か。 */
function attributesAreSafe(a: TemplateAttributes): boolean {
  return [a.companyCode, a.fundCode, a.baseDate, a.editionType].every(isValidTemplateToken);
}

/** テンプレート id がファイル名規約に一致し、全体もトークン単位でも安全か。 */
export function isValidTemplateId(templateId: string): boolean {
  const attrs = parseTemplateFileName(`${templateId}.html`);
  return attrs !== null && isSafeFileNameSegment(templateId) && attributesAreSafe(attrs);
}

/**
 * ファンドコードが単一セグメントとして安全か。要求はファイル名規約の 1 トークンと同一なので
 * `isValidTemplateToken` へ委譲する(判定を 2 本持つと片方だけが緩む)。
 */
export function isValidFundCode(fundCode: string): boolean {
  return isValidTemplateToken(fundCode);
}

/** `isValidTemplateId` に通らなければ `validation` を投げ、通れば入力をそのまま返す。 */
export function assertTemplateId(templateId: string): string {
  if (!isValidTemplateId(templateId)) {
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
 * テンプレート本体のファイル名(`*.html`)として安全か検査し、正規化した名前を返す。
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
