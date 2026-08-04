// =============================================================================
// loginRateLimit.ts — 資格情報試行のレート制限(プロセス内メモリ・予約方式)
// =============================================================================
// 止めたいものは 2 つある: 推測可能な資格情報の総当たりと、PBKDF2(12 万回反復)を
// 空回しさせて CPU を枯らす攻撃。
//
// ★ この module の最重要の不変条件 — 判定と計上は 1 つの同期区間で行う。
// 以前は「判定する関数」と「失敗を数える関数」が別で、その間に DB 往復と KDF の
// await が挟まっていた。JavaScript のジョブは await で他のジョブへ切り替わるので、
// 同一 tick に到着した N 本はすべて「まだ 0 回」の状態を読み、全部通過してから
// まとめて計上された。窓あたりの試行が「閾値」ではなく「攻撃者の同時接続数」になる。
// `beginCredentialAttempt` は読み取り・加算・閾値判定・書き戻しを 1 つの同期関数に
// 閉じている。関数の中に await / yield / コールバック境界が 1 つも無ければ、呼び出しから
// return まではアトミックなので、明示ロック無しで競合しない。
// **この保証は同期であり続ける限りしか成り立たない。** 計上区間へ監査ログや DB 参照の
// await を足した瞬間に上記の穴が完全再現する。`test/loginRateLimit.test.ts` の
// 構造テストがソース中の async / await を機械検査して再来を止めている。
//
// プロセスをまたぐ保証は無い(複数プロセス配備では Map が共有されない)。editor は
// 1 プロセス構成という前提に依存した設計で、外部依存(`@fastify/rate-limit` / Redis)は
// エアギャップ配布のため足さない。多重化する日が来たら、この module の内部だけを
// 共有ストアへ差し替える(公開関数の形は保つ)。
import crypto from 'node:crypto';
import { type AppError, forbidden } from '@editor/shared';

/** 第 1 段(IP + ログインID)。この回数を超える試行で `BLOCK_MS` のあいだ拒否する。 */
export const LOGIN_MAX_FAILURES = 5;
/** 第 1 段の窓。ここを跨いだ試行は数え直す。 */
const WINDOW_MS = 5 * 60_000;
/** 第 1 段の拒否時間。`WINDOW_MS` より長くして、明けたら必ず数え直しになるようにする。 */
const BLOCK_MS = 15 * 60_000;

/**
 * 第 2 段(IP のみ)の上限。第 1 段は (IP, ログインID) の組なので、多数のアカウントへ
 * 1 回ずつ試すスプレーはどのキーも閾値に届かない。IP だけだと共有 NAT 配下の全員を
 * 巻き添えにするため、第 1 段は組キーのまま残し、第 2 段は人間の利用では到底届かない
 * 緩い閾値(5 分で 60 = 5 秒に 1 回を 5 分続ける)だけを見る追加層とする。
 */
export const IP_MAX_ATTEMPTS = 60;
const IP_WINDOW_MS = 5 * 60_000;
const IP_BLOCK_MS = 15 * 60_000;

/**
 * 第 3 段。同時に走ってよい KDF の本数 = CPU 予算。`UV_THREADPOOL_SIZE` の既定 4 を
 * 埋め尽くさない値にする。第 1/第 2 段はキーごとの上限なので、キーを散らされると
 * 瞬間的な同時実行は抑えられない。
 */
export const MAX_CONCURRENT_ATTEMPTS = 4;
/**
 * in-flight の自動解放期限。`settle` を呼ばない経路が 1 つでもあるとゲージがリークし、
 * 数本で全ログインが恒久的に拒否される(自己 DoS)。時刻で保険を掛ける。
 */
const IN_FLIGHT_TTL_MS = 60_000;

/** 掃除の最短間隔。試行のたびに全走査しないための間引き。 */
const PRUNE_INTERVAL_MS = 60_000;
/** 保持するエントリ数のハードキャップ。超過分は呼び出しごとに最古から 1 件ずつ退避する。 */
export const LOGIN_MAX_ENTRIES = 10_000;
/** レート制限で拒否したことを機械可読に伝えるコード(UI はこれで文言を出し分けできる)。 */
export const LOGIN_RATE_LIMITED_CODE = 'LOGIN_RATE_LIMITED';
/** 同時実行上限での拒否。総当たり(上記)と混雑を運用が区別できるよう別コードにする。 */
export const LOGIN_BUSY_CODE = 'LOGIN_BUSY';

/** 試行の種別。login と init-password でカウンタを混ぜない。 */
export type AttemptScope = 'login' | 'init-password';

/** `beginCredentialAttempt` が通した 1 試行の引換券。必ず `settleCredentialAttempt` へ返す。 */
export interface AttemptTicket {
  /** in-flight ゲージ上の識別子(通し番号)。 */
  readonly serial: number;
  /** 第 1 段(scope + IP + 正規化ログインID)のキー。 */
  readonly idKey: string;
  /** 第 2 段(scope + IP)のキー。 */
  readonly ipKey: string;
}

export type BeginResult =
  | { readonly ok: true; readonly ticket: AttemptTicket }
  | { readonly ok: false; readonly error: AppError };

interface CountingState {
  /** 現在の窓での試行回数。 */
  attempts: number;
  /** 現在の窓の起点。 */
  firstAt: number;
}

/** 窓の中で数えている最中のキー。Map の挿入順 = 初出順なので最古退避が O(1)。 */
const counting = new Map<string, CountingState>();
/** 拒否が確定したキー → 解除時刻。counting とは別 Map にして退避順を分ける。 */
const blocked = new Map<string, number>();
/** 走行中の試行 → 開始時刻。 */
const inFlight = new Map<number, number>();
let nextSerial = 1;
let lastPrunedAt = 0;

/**
 * ログインID を長さ有界の識別子へ畳む。正規化済みの値を受け取る前提で、ここでは
 * 大小文字や幅の畳み込みをしない(`auth/loginId.ts` の `canonicalLoginId` が正典。
 * ここで独自に畳み直すと 2 つの正規化が併存し、どちらが効いているか分からなくなる)。
 */
function loginIdDigest(loginId: string): string {
  return crypto.createHash('sha256').update(loginId, 'utf8').digest('hex');
}

/**
 * 期限切れエントリを捨て、件数が上限を超えるなら最古から退避する。
 * 退避は counting を先に、それが空のときだけ blocked を落とす。拒否中を先に捨てると、
 * 攻撃者が別ID の試行で表を溢れさせて自分のブロックを流せてしまう。
 * 全件 sort をしない: 上限超過は呼び出しごとに 1 件ずつ吸収すれば足り、sort を挟むと
 * 上限に張り付いた状態で毎リクエスト n log n を払うことになる。
 */
function prune(now: number): void {
  for (const [serial, startedAt] of inFlight) {
    if (now - startedAt <= IN_FLIGHT_TTL_MS) break;
    inFlight.delete(serial);
  }
  if (now - lastPrunedAt >= PRUNE_INTERVAL_MS) {
    lastPrunedAt = now;
    for (const [key, state] of counting) {
      if (now - state.firstAt > WINDOW_MS) counting.delete(key);
    }
    for (const [key, until] of blocked) {
      if (until <= now) blocked.delete(key);
    }
  }
  while (counting.size + blocked.size > LOGIN_MAX_ENTRIES) {
    const victims = counting.size > 0 ? counting : blocked;
    const oldest = victims.keys().next();
    if (oldest.done) break;
    victims.delete(oldest.value);
  }
}

/** 拒否中なら残り待ち時間(ms)、そうでなければ null。 */
function blockedFor(key: string, now: number): number | null {
  const until = blocked.get(key);
  if (until === undefined) return null;
  if (until <= now) {
    blocked.delete(key);
    return null;
  }
  return until - now;
}

/**
 * 1 試行ぶんを先に計上し、閾値を超えたら拒否時間へ入れる。呼び出し側が結果を待たずに
 * 加算する(＝予約)のが要点で、「通してから数える」形にすると並行リクエストが素通しする。
 * 返り値は拒否時の残り待ち時間(ms)、通すなら null。
 */
function charge(
  key: string,
  now: number,
  max: number,
  windowMs: number,
  blockMs: number,
): number | null {
  const state = counting.get(key);
  if (!state || now - state.firstAt > windowMs) {
    counting.set(key, { attempts: 1, firstAt: now });
    return null;
  }
  state.attempts += 1;
  if (state.attempts <= max) return null;
  counting.delete(key);
  blocked.set(key, now + blockMs);
  return blockMs;
}

function rateLimited(waitMs: number): AppError {
  const waitSec = Math.ceil(waitMs / 1000);
  return forbidden(`ログイン試行が多すぎます。${waitSec} 秒ほど待ってから再試行してください`, {
    code: LOGIN_RATE_LIMITED_CODE,
  });
}

/**
 * 資格情報の検証に入ってよいかを判定し、同時に 1 試行ぶんを計上する。
 * **この関数へ await を持ち込んではならない**(module 冒頭の不変条件)。
 *
 * `loginId` は `canonicalLoginId` の戻り値を渡すこと。生の入力を渡すと、大小文字や
 * 全角で書き分けるだけで 1 アカウントに独立したカウンタをいくつでも作れる。
 * 未知のログインID でも同じように計上する — 「ブロックされない ID = 存在しない ID」は
 * 限定子経由の存在オラクルになるため、存在有無で挙動を変えない。
 */
export function beginCredentialAttempt(
  scope: AttemptScope,
  ip: string | undefined,
  loginId: string,
  now: number = Date.now(),
): BeginResult {
  prune(now);
  if (inFlight.size >= MAX_CONCURRENT_ATTEMPTS) {
    return {
      ok: false,
      error: forbidden('ただいま混雑しています。少し待ってから再試行してください', {
        code: LOGIN_BUSY_CODE,
      }),
    };
  }
  const ipKey = `${scope} ${ip ?? 'unknown'}`;
  const idKey = `${ipKey} ${loginIdDigest(loginId)}`;

  const ipBlocked = blockedFor(ipKey, now);
  if (ipBlocked !== null) return { ok: false, error: rateLimited(ipBlocked) };
  const idBlocked = blockedFor(idKey, now);
  if (idBlocked !== null) return { ok: false, error: rateLimited(idBlocked) };

  const ipOver = charge(ipKey, now, IP_MAX_ATTEMPTS, IP_WINDOW_MS, IP_BLOCK_MS);
  if (ipOver !== null) return { ok: false, error: rateLimited(ipOver) };
  const idOver = charge(idKey, now, LOGIN_MAX_FAILURES, WINDOW_MS, BLOCK_MS);
  if (idOver !== null) return { ok: false, error: rateLimited(idOver) };

  const serial = nextSerial;
  nextSerial += 1;
  inFlight.set(serial, now);
  return { ok: true, ticket: { serial, idKey, ipKey } };
}

/**
 * 試行の後始末。成功なら第 1 段のカウンタを捨てる(正規利用者が打ち間違いを引きずらない)。
 * 失敗は `begin` の時点で計上済みなので何もしない。
 *
 * **第 2 段(IP 窓)は成功でもクリアしない。** 対称にすると、有効な資格情報を 1 つ持つ
 * 攻撃者が自分のログイン成功を挟むだけで IP 上限を無限にリセットでき、スプレーが
 * 素通しになる。
 */
export function settleCredentialAttempt(
  ticket: AttemptTicket,
  outcome: 'success' | 'failure',
): void {
  inFlight.delete(ticket.serial);
  if (outcome === 'success') counting.delete(ticket.idKey);
}

/** 現在保持しているエントリ数。件数上限が本当に効いているかを外から観測するための口。 */
export function loginAttemptEntryCount(): number {
  return counting.size + blocked.size;
}

/** 走行中の試行数。`settle` 漏れ(= 自己 DoS)を外から観測するための口。 */
export function loginInFlightCount(): number {
  return inFlight.size;
}

/** テスト用。module スコープの状態を初期化する。 */
export function resetLoginRateLimit(): void {
  counting.clear();
  blocked.clear();
  inFlight.clear();
  nextSerial = 1;
  lastPrunedAt = 0;
}
