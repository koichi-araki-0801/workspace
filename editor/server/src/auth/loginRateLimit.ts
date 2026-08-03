// =============================================================================
// loginRateLimit.ts — ログイン試行のレート制限(プロセス内メモリ)
// =============================================================================
// 止めたいものは 2 つある: 推測可能な資格情報の総当たりと、PBKDF2(12 万回反復)を
// 空回しさせて CPU を枯らす攻撃。どちらも「同じ相手が短時間に何度も失敗する」形なので、
// (IP, ログインID) 単位で失敗を数え、閾値を超えたら一定時間拒否する。
//
// 外部依存(`@fastify/rate-limit` / Redis)は足さない — エアギャップ配布で同梱物を
// 増やせず、editor は 1 プロセス構成なので Map で足りる。多重化・水平分散する日が
// 来たら、この module の内部だけを共有ストアへ差し替える(公開関数の形は保つ)。
import crypto from 'node:crypto';
import { type AppError, forbidden } from '@editor/shared';

/** この回数の失敗で `BLOCK_MS` のあいだ拒否する。 */
export const LOGIN_MAX_FAILURES = 5;
/** 失敗回数を数える窓。ここを跨いだ失敗は数え直す。 */
const WINDOW_MS = 5 * 60_000;
/** 閾値超過後の拒否時間。`WINDOW_MS` より長くして、明けたら必ず数え直しになるようにする。 */
const BLOCK_MS = 15 * 60_000;
/** 掃除の最短間隔。ログインのたびに全走査しないための間引き。 */
const PRUNE_INTERVAL_MS = 60_000;
/** 保持するエントリ数のハードキャップ。超過分は `prune` が強制退避する。 */
export const LOGIN_MAX_ENTRIES = 10_000;
/** レート制限で拒否したことを機械可読に伝えるコード(UI はこれで文言を出し分けできる)。 */
export const LOGIN_RATE_LIMITED_CODE = 'LOGIN_RATE_LIMITED';

interface AttemptState {
  /** 現在の窓での失敗回数。 */
  failures: number;
  /** 現在の窓の起点。 */
  firstAt: number;
  /** この時刻まで拒否する(0 = 拒否していない)。 */
  blockedUntil: number;
}

const attempts = new Map<string, AttemptState>();
let lastPrunedAt = 0;

/**
 * 失敗を数える単位のキー。IP だけだと共有 NAT 配下の全員を巻き添えにし、ログインID だけだと
 * 攻撃者が対象を変えるだけで回避できるため、両方を組にする。区切りに使う NUL は IP にも
 * ログインID にも現れないので、両者の境界が曖昧にならない。
 *
 * ログインID は生のまま載せず sha256 の hex に畳む。`LoginRequest.username` に長さ制約は
 * 無く(実効上限はボディ上限の 8MB)、失敗は DB 呼び出しの成否に関わらず必ず記録されるため、
 * 生のまま鍵にすると「巨大なログインID で失敗し続ける」だけでキー長 x 件数のメモリを食える。
 * IP 側を平文で残すのは、運用でキーを見たときに発信元だけは追えるようにするため。
 */
export function loginAttemptKey(ip: string | undefined, username: string): string {
  return `${ip ?? 'unknown'}\u0000${usernameDigest(username)}`;
}

/** ログインID を長さ有界の識別子へ畳む(大文字小文字は同一視のまま)。 */
function usernameDigest(username: string): string {
  return crypto.createHash('sha256').update(username.toLowerCase(), 'utf8').digest('hex');
}

/**
 * 期限切れエントリを捨て、残りが `LOGIN_MAX_ENTRIES` を超えるなら古い順に強制退避する。
 * 期限切れ掃除だけでは件数の上限にならない — 失敗は窓の 5 分間どれも消せないので、毎回違う
 * ログインID を送るだけで件数が要求レートに比例して伸びる。
 * 退避順は「拒否中でないもの → `firstAt` が古いもの」。拒否中を先に捨てると、攻撃者が
 * 別ID の失敗で表を溢れさせて自分のブロックを流せてしまう。
 */
function prune(now: number): void {
  if (now - lastPrunedAt < PRUNE_INTERVAL_MS && attempts.size <= LOGIN_MAX_ENTRIES) return;
  lastPrunedAt = now;
  for (const [key, state] of attempts) {
    if (state.blockedUntil <= now && now - state.firstAt > WINDOW_MS) attempts.delete(key);
  }
  if (attempts.size <= LOGIN_MAX_ENTRIES) return;
  const victims = [...attempts.entries()].sort((a, b) => {
    const blocked = Number(a[1].blockedUntil > now) - Number(b[1].blockedUntil > now);
    return blocked !== 0 ? blocked : a[1].firstAt - b[1].firstAt;
  });
  for (let i = 0; i < victims.length - LOGIN_MAX_ENTRIES; i++) attempts.delete(victims[i][0]);
}

/**
 * 拒否すべきなら `AppError` を、通してよければ null を返す。呼び出し元は KDF を回す**前**に
 * 判定し、返ってきたエラーを監査ログへ落としてから throw する(拒否も攻撃の痕跡なので残す)。
 */
export function loginRateLimitRejection(key: string, now: number = Date.now()): AppError | null {
  prune(now);
  const state = attempts.get(key);
  if (!state || state.blockedUntil <= now) return null;
  const waitSec = Math.ceil((state.blockedUntil - now) / 1000);
  return forbidden(`ログイン試行が多すぎます。${waitSec} 秒ほど待ってから再試行してください`, {
    code: LOGIN_RATE_LIMITED_CODE,
  });
}

/** 失敗を 1 件記録する。窓を跨いでいれば数え直し、閾値に達したら拒否期間へ入る。 */
export function recordLoginFailure(key: string, now: number = Date.now()): void {
  const state = attempts.get(key);
  if (!state || now - state.firstAt > WINDOW_MS) {
    attempts.set(key, { failures: 1, firstAt: now, blockedUntil: 0 });
    return;
  }
  state.failures += 1;
  if (state.failures >= LOGIN_MAX_FAILURES) state.blockedUntil = now + BLOCK_MS;
}

/** 認証成功でカウンタを捨てる(正規利用者が打ち間違いを引きずらないようにする)。 */
export function clearLoginFailures(key: string): void {
  attempts.delete(key);
}

/** 現在保持しているエントリ数。件数上限が本当に効いているかを外から観測するための口。 */
export function loginAttemptEntryCount(): number {
  return attempts.size;
}

/** テスト用。module スコープの状態を初期化する。 */
export function resetLoginRateLimit(): void {
  attempts.clear();
  lastPrunedAt = 0;
}
