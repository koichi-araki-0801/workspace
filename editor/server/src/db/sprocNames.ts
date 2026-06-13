/**
 * Central registry of the 7 gateway stored procedures (one per table).
 *
 * Every DB access goes through one of these, dispatched by a first `@操作`
 * argument. Keeping the Japanese physical names in one place means the rest of
 * the server never hard-codes them. Names mirror `server/db/sproc/*.sql`.
 */

const SCHEMA = 'ug01';
const PREFIX = 'Rep1_運報自動化_Editor';

const gw = (target: string): string => `[${SCHEMA}].[${PREFIX}_usp_${target}]`;

/** Fully-qualified gateway sproc names. */
export const SP = {
  template: gw('テンプレート'),
  history: gw('履歴'),
  user: gw('ユーザー'),
  session: gw('セッション'),
  part: gw('パーツ'),
  sample: gw('サンプルデータ'),
  audit: gw('監査ログ'),
} as const;
