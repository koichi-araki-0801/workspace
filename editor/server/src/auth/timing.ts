// =============================================================================
// timing.ts — 認証失敗応答の時間フロア(存在オラクルの second channel を塞ぐ)
// =============================================================================
// 未知のログインID は DB 往復だけで返り、実在する ID は DB 往復 + PBKDF2(60ms 前後)を
// 払う。文言とステータスを揃えても、この応答時間の差だけで「その ID は存在するか」が
// 読める。観測可能な差は文言・ステータス・`code`・応答時間・レート制限の状態の 5 つ
// あり、1 つでも残れば閉じない。
//
// 対策に「未知 ID でもダミーの KDF を 1 回回す」は採らない。未知 ID 1 リクエストの
// コストが 0ms から 60ms へ上がり、毎回違う ID を送るだけでスレッドプールを無制限に
// 占有できる — 存在オラクルを塞ぐ修正がそのまま DoS 増幅器になる。代わりに
// **失敗応答へ一定の下限時間を課す**。CPU は一切増えず、DB 往復のばらつきまで隠せる。
//
// フロアは失敗応答 1 本あたりソケットを保持するので、レート制限の第 2 段(IP 窓)と
// 第 3 段(同時実行上限)が入っていることが前提。レート制限による拒否にはフロアを
// 掛けない — 攻撃者自身のキーの状態しか反映せず他人の存在を漏らさないうえ、速く返す
// ほうが同時実行の在庫を空けるため。
//
// 値の解決は `config.ts`(`config.auth.failedAuthFloorMs`)に一本化する。ここで env を
// 素の `Number()` で読んでいた版は、`AUTH_FAILURE_FLOOR_MS=`(空)で `Number('')===0` となり
// **存在オラクル対策が無言で無効化**され、`1e9` も 10 進検証無しに受理されていた。
// 防御のパラメータは `envNumber` の規律(未知値は起動中止)の内側に置くこと。

import { config } from '../config.js';

/** 認証失敗応答の下限時間(ms)。KDF 60〜65ms + DB 往復の p99 を十分上回る値を既定にする。 */
export const FAILED_AUTH_FLOOR_MS = config.auth.failedAuthFloorMs;

/** 単調増加の経過時間測定。壁時計だと NTP 補正でフロアが飛ぶ。 */
export function startedNow(): number {
  return performance.now();
}

/**
 * 失敗応答を返す直前に呼び、開始からの経過が `floorMs` に満たない分だけ待つ。
 * 呼び忘れた経路が 1 つでもあるとそこが時間オラクルとして残るので、失敗系の分岐は
 * 例外の種類(未知 ID / 無効 / パスワード誤り / DB 障害)を問わず全部通すこと。
 */
export async function applyFailureFloor(
  startedAt: number,
  floorMs: number = FAILED_AUTH_FLOOR_MS,
): Promise<void> {
  const remaining = floorMs - (performance.now() - startedAt);
  if (remaining <= 0) return;
  await new Promise((resolve) => setTimeout(resolve, remaining));
}
